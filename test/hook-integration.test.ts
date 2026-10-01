/**
 * session_before_compact 接管的确定性验证。
 *
 * 为什么这样做：要让真实会话的上下文堆到 205K（256K 窗口的 80%），得让模型真的吃下
 * 20 万 token——而实测模型会**只读它需要的那几行**（一次 read 只回 10 tokens），
 * 有界地堆上下文是 token 预算问题，不是我们代码的问题。
 *
 * 所以这里只在**宿主扩展 API 边界**做 mock（pi.on / pi.registerTool / ctx），
 * 被测的是 activate() 里真实注册的处理器与整条 session_before_compact 路径：
 * 切块 → 原文归档 → 三点摘要 → 组装 #STAMP 索引行。宿主是否允许堆到 205K 属另一问题。
 */
import { mkdtempSync, readdirSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import activate, { CONFIG } from "../src/index.ts";
import { estimateTokens, THRESHOLDS } from "../src/pipeline.ts";

type Handler = (ev: any, ctx: any) => Promise<any> | any;

interface Harness {
	handlers: Map<string, Handler>;
	tools: Map<string, any>;
	commands: Map<string, any>;
	fire(event: string, ev: any, ctx?: any): Promise<any>;
}

function mount(): Harness {
	const handlers = new Map<string, Handler>();
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		registerTool(tool: any) {
			tools.set(tool.name, tool);
		},
		registerCommand(name: string, options: any) {
			commands.set(name, options);
		},
	} as any;
	activate(pi);
	return {
		handlers,
		tools,
		commands,
		fire: (event, ev, ctx) => Promise.resolve(handlers.get(event)!(ev, ctx)),
	};
}

function ctxWith(usage: { tokens: number | null; contextWindow: number; percent: number | null }) {
	return {
		getContextUsage: () => usage,
		model: { id: "step-3.7-flash" },
		modelRegistry: {
			find: () => undefined, // 强制走降级摘要（去重文本首行），不产生模型调用
			complete: async () => ({ content: [{ type: "text", text: "" }] }),
		},
		compact: () => {},
		hasUI: false,
	};
}

function branch(entries: Array<{ id: string; role: string; text: string }>) {
	return entries.map((e) => ({
		type: "message",
		id: e.id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: e.role, content: e.text },
	}));
}

let project: string;
const before = process.cwd();

beforeEach(() => {
	project = mkdtempSync(join(tmpdir(), "sca-hook-"));
	process.chdir(project);
});

afterEach(() => {
	process.chdir(before);
	rmSync(project, { recursive: true, force: true });
});

describe("session_before_compact 接管（真实处理器 + 宿主 API 边界 mock）", () => {
	it("返回带协议头与 #STAMP 索引行的摘要，且每块原文真的落盘", async () => {
		const h = mount();
		const entries = branch([
			{ id: "e1", role: "user", text: "请实现 /archive 与 /recall 两条命令。" },
			{ id: "e2", role: "assistant", text: "已完成清单与命令文本，接着补技能提示词。" },
			{ id: "e3", role: "user", text: "再补一条：归档文件不覆盖。" },
			{ id: "e4", role: "assistant", text: "已加不覆盖规则，并同步到 README。" },
		]);

		const result = await h.fire(
			"session_before_compact",
			{
				type: "session_before_compact",
				preparation: { firstKeptEntryId: "e4", tokensBefore: 230_000 },
				branchEntries: entries,
			},
			ctxWith({ tokens: 230_000, contextWindow: 262_144, percent: 87 }),
		);

		const summary: string = result.compaction.summary;

		// ① 协议头：告知模型 #STAMP 是什么、召回纪律
		expect(summary).toContain("[context-archive]");
		expect(summary).toContain("召回纪律");
		// ② 索引行：#STAMP <id> → <项目相对路径> — <摘要>
		const stampLines = summary.split("\n").filter((l: string) => l.startsWith("#STAMP "));
		expect(stampLines.length).toBeGreaterThan(0);
		for (const line of stampLines) {
			expect(line).toMatch(/^#STAMP [0-9a-f]{12} → \.stepcode\/context-archive\/stamp-[0-9a-f]{12}\.md — /);
		}
		// ③ 索引行里的路径必须真实存在，且内容是该块**原文**（非摘要）
		for (const line of stampLines) {
			const rel = line.split(" → ")[1].split(" — ")[0];
			const abs = join(project, ...rel.split("/"));
			expect(existsSync(abs)).toBe(true);
			const archived = readFileSync(abs, "utf8");
			expect(archived).toMatch(/^(user|assistant): /m);
		}
		// ④ firstKeptEntryId / tokensBefore 原样回传
		expect(result.compaction.firstKeptEntryId).toBe("e4");
		expect(result.compaction.tokensBefore).toBe(230_000);
		// ⑤ 归档目录落在项目内
		expect(existsSync(join(project, ".stepcode", "context-archive"))).toBe(true);
	});

	it("同名归档内容不同时：拒绝覆盖、不覆盖旧内容、且该块不发 #STAMP 行", async () => {
		const h = mount();
		const entries = branch([{ id: "e1", role: "user", text: "原始内容" }]);

		// 第一次写入
		await h.fire(
			"session_before_compact",
			{ type: "session_before_compact", preparation: { firstKeptEntryId: "e1", tokensBefore: 1 }, branchEntries: entries },
			ctxWith({ tokens: 1, contextWindow: 262_144, percent: 1 }),
		);
		const dir = join(project, ".stepcode", "context-archive");
		const first = readdirSync(dir)[0];
		expect(readFileSync(join(dir, first), "utf8")).toContain("原始内容");

		// 同 id、不同内容：模拟 chunk 内容变化后再次归档
		const changed = branch([{ id: "e1", role: "user", text: "被篡改的内容" }]);
		const result = await h.fire(
			"session_before_compact",
			{ type: "session_before_compact", preparation: { firstKeptEntryId: "e1", tokensBefore: 1 }, branchEntries: changed },
			ctxWith({ tokens: 1, contextWindow: 262_144, percent: 1 }),
		);

		// 旧内容原样保留
		expect(readFileSync(join(dir, first), "utf8")).toContain("原始内容");
		// 唯一的块写盘失败 → 归档 0 块 → 交回 undefined，让宿主走它自己的摘要。
		// 若交回 compaction，协议头就会成为 firstKeptEntryId 之前全部历史的唯一表示。
		expect(result).toBeUndefined();
	});
});

describe("turn_end 阈值判定（真实处理器）", () => {
	it("262K 窗口 38% → dedup 且不发起 compact", async () => {
		const h = mount();
		let compactCalls = 0;
		const ctx = { ...ctxWith({ tokens: 100_767, contextWindow: 262_144, percent: 38.4 }), compact: () => { compactCalls++; } };
		await h.fire("turn_end", { type: "turn_end" }, ctx);
		expect(compactCalls).toBe(0);
	});

	it("1M 窗口 30% → silent（自适应把介入线抬到 250K，旧版会在 100K 就介入）", async () => {
		const h = mount();
		let compactCalls = 0;
		const ctx = { ...ctxWith({ tokens: 300_000, contextWindow: 1_000_000, percent: 30 }), compact: () => { compactCalls++; } };
		await h.fire("turn_end", { type: "turn_end" }, ctx);
		expect(compactCalls).toBe(0);
	});

	it("1M 窗口 85% → 判为 summarize，但依然不发起 compact", async () => {
		// 判定仍要算（诊断行依赖它），但发起压缩是越权：宿主 compact() 首行即
		// await this.abort()，而 turn_end 发射于 agent loop 内层循环、run 仍在进行中。
		const h = mount();
		let compactCalls = 0;
		const ctx = { ...ctxWith({ tokens: 850_000, contextWindow: 1_000_000, percent: 85 }), compact: () => { compactCalls++; } };
		await h.fire("turn_end", { type: "turn_end" }, ctx);
		expect(compactCalls).toBe(0);
	});
});

	it("信号被中止时仍归档 + 写磁盘索引，但不接管摘要（原文不丢、也不假装接管）", async () => {
		const h = mount();
		const controller = new AbortController();
		controller.abort(); // 模拟宿主已取消这次压缩
		const result = await h.fire(
			"session_before_compact",
			{
				type: "session_before_compact",
				preparation: { firstKeptEntryId: "e1", tokensBefore: 230_000 },
				branchEntries: branch([{ id: "e1", role: "user", text: "被中止也要留住的原文" }]),
				reason: "threshold",
				signal: controller.signal,
			},
			ctxWith({ tokens: 230_000, contextWindow: 262_144, percent: 88 }),
		);

		// 不接管摘要
		expect(result).toBeUndefined();
		// 但原文必须已经落盘
		const dir = join(project, ".stepcode", "context-archive");
		const files = readdirSync(dir).filter((n) => n.startsWith("stamp-"));
		expect(files).toHaveLength(1);
		expect(readFileSync(join(dir, files[0]), "utf8")).toContain("被中止也要留住的原文");
		// 且磁盘索引存在，模型下次读项目就能知道能召回什么
		const index = readFileSync(join(dir, "INDEX.md"), "utf8");
		expect(index).toContain("recall_by_stamp");
		expect(index).toContain(files[0].slice("stamp-".length, -".md".length));
		expect(index).toContain("被中止也要留住的原文");
	});

	it("session_compact_failed 被如实记录（不假装成功）", async () => {
		const h = mount();
		const seen: any[] = [];
		const write = process.stderr.write.bind(process.stderr);
		(process.stderr as any).write = (chunk: any) => {
			seen.push(String(chunk));
			return true;
		};
		try {
			await h.fire("session_compact_failed", {
				type: "session_compact_failed",
				reason: "overflow",
				aborted: true,
				fromExtension: false,
			});
		} finally {
			(process.stderr as any).write = write;
		}
		expect(seen.join("")).toContain("session_compact_failed");
		expect(seen.join("")).toContain("aborted=yes");
	});

	it("正常路径也写磁盘索引（与 #STAMP 双通道，互不依赖）", async () => {
		const h = mount();
		await h.fire(
			"session_before_compact",
			{
				type: "session_before_compact",
				preparation: { firstKeptEntryId: "e1", tokensBefore: 1 },
				branchEntries: branch([{ id: "e1", role: "user", text: "第一行提要\n第二行" }]),
			},
			ctxWith({ tokens: 1, contextWindow: 262_144, percent: 1 }),
		);
		const index = readFileSync(join(project, ".stepcode", "context-archive", "INDEX.md"), "utf8");
		expect(index).toContain("第一行提要");
		expect(index).not.toContain("第二行"); // 提要只取首个非空行
	});

describe("工具与命令注册", () => {
	it("注册 recall_by_stamp 工具与两条命令", () => {
		const h = mount();
		expect(h.tools.has("recall_by_stamp")).toBe(true);
		expect(h.commands.has("recall-stamp")).toBe(true);
		expect(h.commands.has("context-archive")).toBe(true);
	});

	it("recall_by_stamp 找不到时如实报错并列出已查找路径", async () => {
		const h = mount();
		const out = await h.tools.get("recall_by_stamp").execute("t1", { stamp: "abc123def456" }, {}, undefined, {});
		expect(out.isError).toBe(true);
		expect(out.content[0].text).toContain("未找到归档文件");
		expect(out.content[0].text).toContain(".stepcode\\context-archive\\stamp-abc123def456.md");
	});

	it("recall_by_stamp 接受市场协议的 b 前缀退化 id", async () => {
		const h = mount();
		const out = await h.tools.get("recall_by_stamp").execute("t1", { stamp: "b3-202609272200" }, {}, undefined, {});
		expect(out.isError).toBe(true);
		// 不再是"无效 stamp"，而是走到查找阶段
		expect(out.content[0].text).not.toContain("无效 stamp");
		expect(out.content[0].text).toContain("stamp-b3-202609272200.md");
	});
});

describe("归档失败时的降级路径（宿主一旦收到 compaction 就跳过它自己的摘要）", () => {
	const entries = branch([
		{ id: "e1", role: "user", text: "任务一：把登录页改完。" },
		{ id: "e2", role: "assistant", text: "已完成登录页改造，涉及 320 行改动。" },
		{ id: "e3", role: "user", text: "任务二：修一个崩溃。" },
		{ id: "e4", role: "assistant", text: "崩溃根因是 null 解引用，修复于 parser.ts 第 88 行。" },
	]);
	const ev = () => ({
		reason: "manual",
		preparation: { firstKeptEntryId: "e4", tokensBefore: 180_000, contextWindow: 200_000 },
		branchEntries: entries,
		willRetry: false,
		signal: new AbortController().signal,
	});

	it("全部块写盘失败时交回 undefined，让宿主走它自己的 LLM 摘要", async () => {
		// 让项目根下的 .stepcode 变成普通文件 → 建归档目录时 ENOTDIR → 全块失败
		writeFileSync(join(project, ".stepcode"), "not a directory", "utf8");
		const h = mount();
		const notified: string[] = [];
		const ctx = { ...ctxWith({ tokens: 180_000, contextWindow: 200_000, percent: 90 }), ui: { notify: (m: string) => notified.push(m) } };

		const result = await h.fire("session_before_compact", ev(), ctx);

		// 关键回归：绝不能返回 compaction，否则 firstKeptEntryId 之前的历史只剩协议头
		expect(result).toBeUndefined();
		// 也不能静默：用户必须看到发生了什么
		expect(notified.join(" ")).toContain("全部归档失败");
	});

	it("部分块写盘失败时，该块仍留下摘要行，只是不带指针", async () => {
		const h = mount();
		const ctx = ctxWith({ tokens: 180_000, contextWindow: 200_000, percent: 90 });

		// 先正常跑一次，把归档目录建起来
		await h.fire("session_before_compact", ev(), ctx);

		// 把其中一个块的归档文件占位成与正文**无前缀关系**的内容 → 触发 EEXIST 冲突
		const dir = join(project, ".stepcode", "context-archive");
		const victim = readdirSync(dir).find((n) => n.startsWith("stamp-"))!;
		writeFileSync(join(dir, victim), "SQUATTER", "utf8");

		const result = await h.fire("session_before_compact", ev(), ctx);
		const summary: string = result?.compaction?.summary ?? "";

		// 失败块不指向磁盘（那个文件是别人的内容），但它的内容不能凭空消失
		expect(summary).toContain("#UNARCHIVED");
		expect(summary).not.toContain(victim.slice("stamp-".length, -".md".length));
		// 其余块照常带 #STAMP
		expect(summary).toContain("#STAMP ");
	});
});

describe("turn_end 只观察，不发起压缩", () => {
	it("即使判定为 summarize 也不调 ctx.compact", async () => {
		// 宿主 AgentSession.compact() 的第一行就是 await this.abort()，而 turn_end
		// 发射于 agent loop 内层循环（run 仍在进行中）——调用它会当场中止用户这一轮。
		const h = mount();
		let compactCalls = 0;
		const ctx = {
			...ctxWith({ tokens: 180_000, contextWindow: 200_000, percent: 90 }),
			compact: () => {
				compactCalls += 1;
			},
		};

		await h.fire("turn_end", {}, ctx);

		expect(compactCalls).toBe(0);
	});
});

describe("CONFIG 生效线（自检用真值，防文档漂移）", () => {
	it("默认自适应：0.25 / 100K 下限 / 无固定覆盖", () => {
		expect(CONFIG.enterTokens).toBeNull();
		expect(CONFIG.enterPercent).toBe(0.25);
		expect(CONFIG.enterFloor).toBe(100_000);
	});

	it("foldPercent 只有 THRESHOLDS 一个事实源，CONFIG 不再镜像它", () => {
		// 镜像过一次的那份是死配置：改它对 decideFold 零影响，却会被 /context-archive
		// 面板当生效值打印，误导排查。折叠门限只认 pipeline.THRESHOLDS.foldPercent。
		expect(THRESHOLDS.foldPercent).toBe(80);
		expect("foldPercent" in CONFIG).toBe(false);
	});

	it("projectionMax 落在宿主内置工具 50KB 截断线之下，投影才会真正触发", () => {
		// 宿主 core/tools/truncate.ts 的 DEFAULT_MAX_BYTES = 50 * 1024 字节。
		// 投影线折算成字符若超过它，tool_result 钩子永远拿不到超限内容，投影形同虚设。
		const HOST_MAX_BYTES = 50 * 1024;
		expect(estimateTokens("a".repeat(HOST_MAX_BYTES))).toBeGreaterThan(CONFIG.projectionMax);
		// 中文侧同理：estimateTokens 按 CJK 1 字 1 token 折算，50KB ≈ 17K 汉字
		expect(estimateTokens("中".repeat(17_000))).toBeGreaterThan(CONFIG.projectionMax);
	});
});
