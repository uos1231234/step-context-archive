/**
 * context-archive 扩展入口：只做副作用接线，算法全部在 ./pipeline.js。
 * 运行时零依赖：不 import 任何宿主包（扩展由 jiti 源码直载，裸包名
 * import 会随扩展所在目录变化而解析失败），宿主接口一律本地鸭子类型声明。
 */
import { readdirSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	THRESHOLDS,
	dedupChunk,
	decideFold,
	effectiveEnterTokens,
	estimateTokens,
	formatStampLine,
	legacyArchiveDir,
	normalizeStampId,
	parseSummary,
	projectArchiveDir,
	projectRelativePath,
	projectToolResult,
	semanticChunks,
	stampFilePath,
	stampOf,
	summaryPrompt,
	writeArchiveIndexSync,
	writeStamp,
	writeStampSync,
	STAMP_FILE_RE,
	type Chunk,
	type EnterPolicy,
	type FoldDecision,
} from "./pipeline.js";

// ---------------------------------------------------------------------------
// 本地鸭子类型（对齐 Step-Code 宿主真实签名，出处见 README「与上游对齐」）
// ---------------------------------------------------------------------------

interface ContextUsage {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

interface CompactOptions {
	customInstructions?: string;
	onComplete?: (result: unknown) => void;
	onError?: (error: Error) => void;
}

interface SessionBeforeCompactEvent {
	type: "session_before_compact";
	/** 运行时可能缺失（防御性声明），缺失时本插件让宿主走默认压缩路径 */
	preparation?: {
		firstKeptEntryId: string;
		tokensBefore: number;
	};
	branchEntries: Array<Record<string, any>>;
	customInstructions?: string;
	reason?: "manual" | "threshold" | "overflow";
	willRetry?: boolean;
	signal?: AbortSignal;
}

/** 压缩失败/被中止（extensions.md:484-490） */
interface SessionCompactFailedEvent {
	type: "session_compact_failed";
	reason: "manual" | "threshold" | "overflow";
	/** true 表示这次压缩是被取消/中止的 */
	aborted?: boolean;
	/** true 表示当时正在使用扩展提供的压缩内容 */
	fromExtension?: boolean;
	errorMessage?: string;
	willRetry?: boolean;
}

interface SessionBeforeCompactResult {
	compaction?: {
		summary: string;
		firstKeptEntryId: string;
		tokensBefore: number;
	};
}

interface ToolResultEvent {
	type: "tool_result";
	toolCallId: string;
	input: Record<string, unknown>;
	content: Array<{ type: string; [key: string]: any }>;
	isError: boolean;
}

interface ToolResultEventResult {
	content?: Array<{ type: string; [key: string]: any }>;
}

interface ExtensionContext {
	hasUI?: boolean;
	ui?: { notify(message: string, type?: "info" | "warning" | "error"): void };
	/** 当前模型，可能未选中；缺失时三点摘要降级为算法层去重 */
	model?: unknown;
	modelRegistry?: {
		find(provider: string, modelId: string): ExtensionContext["model"];
		complete(
			model: unknown,
			context: {
				systemPrompt?: string;
				messages: Array<{ role: string; content: string; timestamp?: number }>;
			},
			options?: { signal?: AbortSignal; maxTokens?: number },
		): Promise<{ content: Array<{ type: string; text?: string }> }>;
	};
	getContextUsage(): ContextUsage | undefined;
	compact(options?: CompactOptions): void;
}

interface ToolSpec {
	name: string;
	label: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	/** 纯 JSON Schema 对象，与官方 Type.Object 产物等价 */
	parameters: Record<string, unknown>;
	execute(
		toolCallId: string,
		params: Record<string, any>,
		signal?: unknown,
		onUpdate?: unknown,
		ctx?: ExtensionContext,
	): Promise<{ content: Array<Record<string, any>>; details?: unknown; isError?: boolean }>;
}

interface ExtensionAPI {
	on(
		event: "turn_end",
		handler: (ev: { type: "turn_end" }, ctx: ExtensionContext) => void,
	): void;
	on(
		event: "session_before_compact",
		handler: (
			ev: SessionBeforeCompactEvent,
			ctx: ExtensionContext,
		) => Promise<SessionBeforeCompactResult | undefined> | SessionBeforeCompactResult | undefined,
	): void;
	on(
		event: "tool_result",
		handler: (
			ev: ToolResultEvent,
			ctx: ExtensionContext,
		) => Promise<ToolResultEventResult | undefined> | ToolResultEventResult | undefined,
	): void;
	on(
		event: "session_compact_failed",
		handler: (ev: SessionCompactFailedEvent) => void,
	): void;
	registerTool(tool: ToolSpec): void;
	registerCommand(
		name: string,
		options: {
			description?: string;
			handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
		},
	): void;
}

// ---------------------------------------------------------------------------
// 集中配置
// ---------------------------------------------------------------------------

export const CONFIG = {
	/**
	 * 介入线策略（按所选模型的上下文窗口自适应，见 pipeline.effectiveEnterTokens）：
	 * 生效线 = max(enterFloor, contextWindow × enterPercent)；enterTokens 非 null 时直接覆盖。
	 * 例如 256K 窗口 → 100K（下限兜底，与旧版行为一致）；1M 窗口 → 250K。
	 */
	enterTokens: null as number | null,
	enterPercent: 0.25,
	enterFloor: 100_000,
	/** 折叠门限：实际占用达到窗口的这个百分比才发起压缩摘要（镜像 THRESHOLDS） */
	foldPercent: THRESHOLDS.foldPercent,
	/** 工具结果投影上限（token），作为 projectToolResult 的 maxTokens */
	projectionMax: 20_000,
	/** 去重后仍超过该 token 数的块才值得花一次模型调用做三点摘要 */
	summarizeMinTokens: 800,
	/** 摘要压缩默认模型：优先 step-3.7-flash（便宜），不可用时回退会话模型 */
	compressionModel: { provider: "step", id: "step-3.7-flash" },
};

/** CONFIG → decideFold 用的策略视图（用 getter 保持单一事实源：改 CONFIG 即改行为） */
const ENTER_POLICY: EnterPolicy = {
	get enterTokens() {
		return CONFIG.enterTokens;
	},
	get enterPercent() {
		return CONFIG.enterPercent;
	},
	get floor() {
		return CONFIG.enterFloor;
	},
};

/** ctx.compact 下发的自定义指令：告知宿主采用本插件的三点摘要协议与已归档约定 */
const COMPACT_INSTRUCTIONS = [
	"本次压缩遵循 context-archive 插件的三点摘要协议：每个历史任务块只保留目标、关键决策、是否完成三点。",
	"摘要中必须原样保留 #STAMP 标记行，它们指向已归档的完整原文。",
	"保留仍未完成的任务、未决问题与关键文件路径，删除可从归档召回的细节。",
	"后续需要历史细节时，用 recall_by_stamp 工具按 stamp 读取原文，不要凭记忆复述。",
].join("\n");

/** 压缩结果顶部协议段：向接手的模型说明 #STAMP 行与召回纪律 */
const PROTOCOL_HEADER =
	"[context-archive] 以下 #STAMP 行是已归档历史任务块的索引，摘要仅作导航，细节可能失真。\n" +
	"召回纪律：需要引用历史细节时，先用 recall_by_stamp 工具（或 /recall-stamp 命令）按 stamp 读取原文，禁止凭记忆复述。\n";

// ---------------------------------------------------------------------------
// 模块级状态
// ---------------------------------------------------------------------------

/** 防重入：compact 发起后未回调前不再次发起 */
let inFlight = false;
let inFlightSince = 0;
/** 上次接管压缩的时间，仅供 /context-archive 诊断展示 */
let lastTakeoverAt = 0;

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

/** 对齐 config.ts:208-215：STEP_CODING_AGENT_DIR 优先，缺省 ~/.stepcode/agent */
function resolveAgentDir(): string {
	const envDir = process.env.STEP_CODING_AGENT_DIR?.trim();
	if (envDir) {
		return envDir.startsWith("~/") ? path.join(os.homedir(), envDir.slice(2)) : envDir;
	}
	return path.join(os.homedir(), ".stepcode", "agent");
}

/**
 * 按 stamp 读取归档原文。按「新目录优先、旧目录兜底」依次查找，
 * 让 0.1.x 时代写在 agentDir 下的旧归档在迁移后仍能召回。
 */
function readStampText(
	roots: string[],
	raw: string,
): { ok: true; text: string; file: string } | { ok: false; error: string } {
	const id = normalizeStampId(raw);
	if (!id) {
		return { ok: false, error: `无效 stamp：${raw}（只允许 12 位十六进制 id、b 前缀退化短 id，或 stamp-<id>.md 文件名）` };
	}
	const tried: string[] = [];
	for (const root of roots) {
		const file = stampFilePath(root, id);
		tried.push(file);
		try {
			return { ok: true, text: readFileSync(file, "utf8"), file };
		} catch {
			// 继续试下一个目录
		}
	}
	return { ok: false, error: `未找到归档文件（已查找：${tried.join("、")}）` };
}

/** 降级摘要：取去重文本首个非空行并截断 */
function firstLineBrief(text: string): string {
	const line = text.split("\n").find((candidate) => candidate.trim().length > 0) ?? "";
	return line.trim().slice(0, 200);
}

function responseText(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter((part) => part.type === "text" && part.text)
		.map((part) => part.text)
		.join("\n");
}

/**
 * 从 session_before_compact 载荷推断折叠决策。载荷里没有 contextWindow/percent，
 * 能拿到 usage 就交给 decideFold；拿不到走保守规则：overflow 或 tokensBefore
 * 已达介入线即视为 summarize，其余 dedup。
 */
function foldDecisionForPreparation(ev: SessionBeforeCompactEvent, ctx: ExtensionContext): FoldDecision {
	const usage = ctx.getContextUsage();
	if (usage && usage.tokens !== null && usage.percent !== null) {
		return decideFold(usage, ENTER_POLICY);
	}
	if (ev.reason === "overflow") return "summarize";
	const tokensBefore = ev.preparation?.tokensBefore ?? 0;
	// 载荷里没有 contextWindow 时用 floor 兜底，保证判定不因缺窗口信息而漂移
	return tokensBefore >= effectiveEnterTokens(ENTER_POLICY, usage?.contextWindow)
		? "summarize"
		: "dedup";
}

/** 单块三点摘要：模型调用失败或未启用时降级为去重文本首行，整体不 throw */
async function briefOf(
	chunkText: string,
	ctx: ExtensionContext,
	useModel: boolean,
	signal?: AbortSignal,
): Promise<string> {
	const fallback = firstLineBrief(chunkText);
	if (!useModel || estimateTokens(chunkText) <= CONFIG.summarizeMinTokens) {
		return fallback;
	}
	try {
		const run = (m: NonNullable<ExtensionContext["model"]>) =>
			ctx.modelRegistry!.complete(
				m,
				{
					systemPrompt: "你是上下文压缩器，把给定文本压缩为背景、行动、结论三点摘要，每点一行，不复述细节。",
					messages: [{ role: "user", content: summaryPrompt(chunkText), timestamp: Date.now() }],
				},
				{ signal, maxTokens: 512 },
			);
		// 压缩模型优先 CONFIG.compressionModel（step-3.7-flash，便宜）：find 不到或调用失败时回退会话模型
		const preferred = ctx.modelRegistry?.find?.(
			CONFIG.compressionModel.provider,
			CONFIG.compressionModel.id,
		);
		let response: Awaited<ReturnType<typeof run>>;
		try {
			response = await run(preferred ?? ctx.model!);
		} catch (error) {
			if (!ctx.model || !preferred || preferred === ctx.model) throw error;
			response = await run(ctx.model);
		}
		return parseSummary(responseText(response.content)) || fallback;
	} catch {
		return fallback;
	}
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export default function activate(pi: ExtensionAPI): void {
	const projectRoot = process.cwd();
	// 新目录写在项目内（市场协议约定，跨机器/移仓可解析）；旧目录只读回落
	const stampRoot = projectArchiveDir(projectRoot);
	const legacyRoot = legacyArchiveDir(resolveAgentDir());
	const readRoots = [stampRoot, legacyRoot];

	// turn_end：只观察与打印一行诊断，不直接改会话。本插件的两个真实改写点是
	//「压缩接管」（session_before_compact）与「工具投影」（tool_result），
	// turn_end 若也改写会造成重复触发；这里仅在决策为 summarize 时发起 compact。
	pi.on("turn_end", (_ev, ctx) => {
		const usage = ctx.getContextUsage();
		if (!usage) return;
		const decision = decideFold(usage, ENTER_POLICY);
		if (decision === "silent") return;
		process.stderr.write(
			`[context-archive] usage=${usage.tokens} window=${usage.contextWindow ?? "?"} ` +
				`enter=${effectiveEnterTokens(ENTER_POLICY, usage.contextWindow)} ` +
				`percent=${usage.percent} decision=${decision}\n`,
		);
		if (decision !== "summarize") return;
		// 防重入：compact 未回调前不再发起；异常卡死超过 10 分钟自动放行
		if (inFlight && Date.now() - inFlightSince < 600_000) return;
		inFlight = true;
		inFlightSince = Date.now();
		const release = () => {
			inFlight = false;
		};
		try {
			ctx.compact({
				customInstructions: COMPACT_INSTRUCTIONS,
				onComplete: release,
				onError: release,
			});
		} catch (error) {
			release();
			process.stderr.write(`[context-archive] compact 发起失败：${String(error)}\n`);
		}
	});

	// 核心接管：归档原文 + 生成带 #STAMP 行的压缩摘要。
	// 防抖策略：不拦截 manual 连点（用户意志优先），只记录接管时间供诊断。
	pi.on("session_before_compact", async (ev, ctx) => {
		// 入口诊断：如实记录本插件看到了什么（是否被调用、preparation 在不在、信号是否已中止）
		process.stderr.write(
			`[context-archive] session_before_compact reason=${ev.reason ?? "?"} ` +
				`preparation=${ev.preparation ? "yes" : "no"} ` +
				`aborted=${ev.signal?.aborted ? "yes" : "no"} ` +
				`willRetry=${ev.willRetry ? "yes" : "no"} entries=${ev.branchEntries.length}\n`,
		);
		if (!ev.preparation) return;

		// ── 阶段 1：同步归档。刻意不依赖 ctx、不依赖模型、不依赖 signal ──────────
		// 必须排在最前面：宿主中止压缩时会并发拆卸会话，此时 ctx.getContextUsage()
		// 可能抛异常、模型调用会立即 aborted；这些一旦先跑，后面真正要保命的落盘
		// 就全丢了（实测 369 entries 连续 5 次 0 归档，只打出入口诊断那一行）。
		const chunks: Chunk[] = semanticChunks(ev.branchEntries);
		const failed = new Set<string>();
		for (const chunk of chunks) {
			const stamp = stampOf(chunk.key);
			const file = stampFilePath(stampRoot, stamp);
			try {
				writeStampSync(stampRoot, stamp, chunk.text);
			} catch (error) {
				// 不发 #STAMP 行：宁可本块只剩摘要，也不给出指向「内容不同」的旧文件的指针
				process.stderr.write(
					`[context-archive] 归档失败 ${file}：${String(error)}（本块不发 #STAMP 索引行）\n`,
				);
				failed.add(stamp);
			}
		}
		const archived = chunks.length - failed.size;
		const indexPath = writeArchiveIndexSync(stampRoot, (abs) => projectRelativePath(projectRoot, abs));

		// 信号已中止 → 压缩已被宿主取消，不接管摘要（让宿主走它自己的路径）。
		// 但原文与索引已在阶段 1 落盘，「压缩前归档原文」不因中止而破。
		if (ev.signal?.aborted) {
			process.stderr.write(
				`[context-archive] 压缩已被宿主中止：已归档 ${archived}/${chunks.length} 个块，` +
					`索引 ${indexPath}；#STAMP 未进入会话，可从该索引文件查到可召回的块。\n`,
			);
			return;
		}

		// ── 阶段 2：接管摘要（依赖 ctx 与模型；失败也不影响已落盘的归档）────────
		try {
			lastTakeoverAt = Date.now();
			const useModel =
				foldDecisionForPreparation(ev, ctx) === "summarize" && !!ctx.model && !!ctx.modelRegistry;
			const lines = (
				await Promise.all(
					chunks.map(async (chunk) => {
						const stamp = stampOf(chunk.key);
						if (failed.has(stamp)) return null;
						const brief = await briefOf(dedupChunk(chunk.text), ctx, useModel, ev.signal);
						return formatStampLine(
							stamp,
							projectRelativePath(projectRoot, stampFilePath(stampRoot, stamp)),
							brief,
						);
					}),
				)
			).filter((line): line is string => line !== null);

			return {
				compaction: {
					summary: PROTOCOL_HEADER + lines.join("\n"),
					firstKeptEntryId: ev.preparation.firstKeptEntryId,
					tokensBefore: ev.preparation.tokensBefore,
				},
			};
		} catch (error) {
			// 摘要阶段出错：原文已落盘，如实报告并让宿主走默认压缩，不伪造成功
			process.stderr.write(
				`[context-archive] 摘要阶段失败（原文已落盘 ${archived} 块，索引 ${indexPath}）：${String(error)}\n`,
			);
			return;
		}
	});

	// 压缩失败/被中止时如实报告，不假装成功
	pi.on("session_compact_failed", async (ev) => {
		process.stderr.write(
			`[context-archive] session_compact_failed reason=${ev.reason} ` +
				`aborted=${ev.aborted ? "yes" : "no"} fromExtension=${ev.fromExtension ? "yes" : "no"}` +
				`${ev.errorMessage ? ` error=${ev.errorMessage}` : ""}\n`,
		);
	});

	// 有界工具投影：先归档全文，归档成功才投影；归档失败则放行原文，宁可占上下文也不丢数据
	pi.on("tool_result", async (ev) => {
		const stamp = stampOf(ev.toolCallId);
		const projected = projectToolResult(ev.content, CONFIG.projectionMax, stamp);
		if (!projected.projected) return;
		try {
			await writeStamp(stampRoot, stamp, projected.fullText);
		} catch (error) {
			process.stderr.write(`[context-archive] 工具结果归档失败，放弃投影：${String(error)}\n`);
			return;
		}
		return { content: projected.content };
	});

	// 召回工具：按 stamp 读取归档文件全文
	pi.registerTool({
		name: "recall_by_stamp",
		label: "按 Stamp 召回归档",
		description: "输入 stamp（12 位十六进制 id、b 前缀退化短 id，或 stamp-<id>.md 文件名），读取对应归档文件全文并返回",
		promptSnippet: "Recall archived pre-compaction context by its 12-hex stamp id",
		promptGuidelines: [
			"Use recall_by_stamp when a #STAMP line is referenced and the exact archived text is needed.",
		],
		parameters: {
			type: "object",
			properties: {
				stamp: {
					type: "string",
					description: "归档 stamp：12 位十六进制 id、b 前缀退化短 id，或 stamp-<id>.md 文件名",
				},
			},
			required: ["stamp"],
		},
		async execute(_toolCallId, params) {
			const result = readStampText(readRoots, String(params.stamp ?? ""));
			if (result.ok) {
				return { content: [{ type: "text", text: result.text }], details: { file: result.file } };
			}
			return { content: [{ type: "text", text: result.error }], isError: true };
		},
	});

	// 命令：召回归档块（与工具共用同一读取函数，输出走 stdout）
	pi.registerCommand("recall-stamp", {
		description: "召回归档块：/recall-stamp <stamp>",
		handler: async (args, ctx) => {
			const result = readStampText(readRoots, args);
			if (!result.ok) {
				ctx.ui?.notify(result.error, "error");
				process.stderr.write(`${result.error}\n`);
				return;
			}
			process.stdout.write(result.text.endsWith("\n") ? result.text : `${result.text}\n`);
		},
	});

	// 命令：诊断面板（归档目录、文件数、当前 usage、CONFIG）
	pi.registerCommand("context-archive", {
		description: "查看归档目录、文件数、当前 usage 与 CONFIG",
		handler: async (_args, ctx) => {
			const countIn = (root: string): number => {
				try {
					return readdirSync(root).filter((name) => STAMP_FILE_RE.test(name)).length;
				} catch {
					return 0;
				}
			};
			const usage = ctx.getContextUsage();
			const usageText = usage
				? `tokens=${usage.tokens} percent=${usage.percent} contextWindow=${usage.contextWindow}`
				: "unknown";
			const takeoverText = lastTakeoverAt > 0 ? new Date(lastTakeoverAt).toISOString() : "无";
			process.stdout.write(
				[
					`[context-archive] 归档目录：${stampRoot}`,
					`[context-archive] 归档文件数：${countIn(stampRoot)}`,
					`[context-archive] 旧版目录（只读回落）：${legacyRoot}`,
					`[context-archive] 旧版文件数：${countIn(legacyRoot)}`,
					`[context-archive] 上次接管压缩：${takeoverText}`,
					`[context-archive] 当前 usage：${usageText}`,
					`[context-archive] 生效介入线：${effectiveEnterTokens(ENTER_POLICY, usage?.contextWindow)}` +
						`（策略 ${CONFIG.enterTokens === null ? `自适应 max(下限 ${CONFIG.enterFloor}, 窗口×${CONFIG.enterPercent})` : `固定 ${CONFIG.enterTokens}`}，` +
						`本会话窗口 ${usage?.contextWindow ?? "未知"}）`,
					`[context-archive] CONFIG：enterTokens=${CONFIG.enterTokens} enterPercent=${CONFIG.enterPercent} enterFloor=${CONFIG.enterFloor} foldPercent=${CONFIG.foldPercent} projectionMax=${CONFIG.projectionMax} summarizeMinTokens=${CONFIG.summarizeMinTokens}`,
					"",
				].join("\n"),
			);
		},
	});
}
