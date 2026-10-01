// 上下文归档流水线（step-context-archive 纯逻辑层）
// 宿主通过 jiti 直接加载本 TS 源码，运行时零第三方依赖：
// 只允许 import node 内置模块，宿主类型一律用本地最小结构接口（鸭子类型）对齐。

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";

// ============ 宿主结构的本地最小接口（字段与宿主真实结构对齐） ============

// 宿主 SessionEntry 的 message 形态（session-manager.ts:46-56）
interface SessionMessageEntry {
  type: "message";
  id: string;
  parentId: string | null;
  timestamp: string;
  message: {
    role: string;
    content: unknown;
    usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  };
}

// 宿主 ContextUsage（types.ts:332-338）
interface ContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

// 宿主 CompactionResult（compaction.ts:95-104）
interface CompactionResult {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  estimatedTokensAfter?: number;
  usage?: unknown;
  details?: unknown;
}

// ============ 阈值与三态决策 ============

// 介入下限与摘要门限（用户拍板值）
export const THRESHOLDS = { foldPercent: 80 } as const;

/**
 * 介入线策略。默认**按所选模型的上下文窗口自适应**——写死一个绝对值在不同窗口下
 * 要么过早介入（1M 窗口只用 10% 就压缩，巨型窗口被浪费），要么过晚（256K 窗口已超）。
 * 生效线 = max(floor, contextWindow × enterPercent)；`enterTokens` 非 null 时直接覆盖。
 */
export interface EnterPolicy {
  /** 显式绝对 token 线；null = 按窗口自适应 */
  enterTokens: number | null;
  /** 自适应比例：窗口的百分之多少开始介入 */
  enterPercent: number;
  /** 自适应的绝对下限，防止小窗口下过早介入 */
  floor: number;
}

export const DEFAULT_ENTER_POLICY: EnterPolicy = {
  enterTokens: null,
  enterPercent: 0.25,
  floor: 100_000,
};

/**
 * 解算实际生效的介入线。窗口未知（宿主未给 contextWindow）时退化为 floor，
 * 保证行为不因缺信息而漂移。
 */
export function effectiveEnterTokens(
  policy: EnterPolicy = DEFAULT_ENTER_POLICY,
  contextWindow?: number,
): number {
  if (policy.enterTokens !== null) return policy.enterTokens;
  if (contextWindow == null || contextWindow <= 0) return policy.floor;
  return Math.max(policy.floor, Math.round(contextWindow * policy.enterPercent));
}

export type FoldDecision = "silent" | "dedup" | "summarize";

// 三态决策：silent 不介入 / dedup 算法去重 / summarize 调 LLM 摘要
export function decideFold(
  usage: { tokens: number | null; contextWindow?: number; percent: number | null } | undefined,
  policy: EnterPolicy = DEFAULT_ENTER_POLICY,
): FoldDecision {
  if (!usage) return "silent";
  const { tokens, contextWindow, percent } = usage;
  const enterTokens = effectiveEnterTokens(policy, contextWindow);
  if (tokens == null || tokens < enterTokens) return "silent";
  if (percent != null) return percent >= THRESHOLDS.foldPercent ? "summarize" : "dedup";
  // percent 缺失但 tokens 已知：用 tokens/contextWindow 手算比例补位
  if (contextWindow != null && contextWindow > 0) {
    return (tokens / contextWindow) * 100 >= THRESHOLDS.foldPercent ? "summarize" : "dedup";
  }
  // 分母不可得：保守降级为算法去重
  return "dedup";
}

// ============ 纯语义切块 ============

// 语义块：一组连续 message 条目；key 为 entryIds 首尾拼接的稳定键，供 stampOf 输入
export interface Chunk {
  key: string;
  entryIds: string[];
  text: string;
}

// JSON 序列化失败或无字符串结果时返回空串
function safeJson(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    return typeof s === "string" ? s : "";
  } catch {
    return "";
  }
}

// 将 message.content（字符串 / 内容块数组 / 其他）拍平成纯文本，image 块跳过
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((part) => {
        if (part && typeof part === "object") {
          const p = part as { type?: string; text?: unknown };
          if (p.type === "text" && typeof p.text === "string") return p.text;
          if (p.type === "image") return "";
        }
        return safeJson(part);
      })
      .filter((s) => s.length > 0);
    return parts.join("\n");
  }
  if (content == null) return "";
  return safeJson(content);
}

// 按纯语义边界切块（无大小硬区间）：连续 message 条目在角色切换处断开——
// 「遇到第一个 assistant 消息即组块」与「role 变化（user 起始）强制分块」
// 统一收敛为 user/assistant 角色切换切点；
// 非 message 类型条目（compaction/label 等）跳过不入块。
export function semanticChunks(entries: Array<Record<string, any>>): Chunk[] {
  const messages = entries.filter(
    (e) => e && e.type === "message" && e.message && typeof e.message.role === "string"
  );
  const chunks: Chunk[] = [];
  let group: Array<Record<string, any>> = [];
  let prevRole: string | null = null;
  const flush = () => {
    if (group.length === 0) return;
    const entryIds = group.map((e) => String(e.id));
    const text = group
      .map((e) => {
        const m = (e as unknown as SessionMessageEntry).message;
        return `${m.role}: ${contentToText(m.content)}`;
      })
      .join("\n\n");
    chunks.push({ key: `${entryIds[0]}..${entryIds[entryIds.length - 1]}`, entryIds, text });
    group = [];
  };
  for (const entry of messages) {
    const role: string = entry.message.role;
    if (group.length > 0 && role !== prevRole && (role === "user" || role === "assistant")) {
      flush();
    }
    group.push(entry);
    prevRole = role;
  }
  flush();
  return chunks;
}

// ============ 算法去重（三规则按序执行） ============

// 工具结果折叠后的占位行
function foldPlaceholder(lineCount: number): string {
  return `… [已折叠 ${lineCount} 行 · 去重]`;
}

// 规则①：工具结果折叠——
//   a) 成对 <output>...</output> 包裹块无条件折叠；
//   b) `Result of ` 头行（或未闭合的 <output> 头行）折叠到第一个空行为止；
//   c) 无标记但连续 >=40 行的行块（长工具输出兜底启发）整块折叠；
//   === 分隔的长输出由 c) 的行数规则覆盖。宁可不动不误伤。
function foldToolBlocks(lines: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const t = lines[i].trim();
    // ①-a：成对 output 标签包裹块
    if (t === "<output>") {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== "</output>") j++;
      if (j < lines.length) {
        out.push(foldPlaceholder(j - i + 1));
        i = j + 1;
        continue;
      }
    }
    // ①-b：工具结果标记头行块
    if (t.startsWith("Result of ") || t === "<output>") {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== "") j++;
      out.push(foldPlaceholder(j - i));
      i = j;
      continue;
    }
    // ①-c：连续 >=40 行的无标记长行块
    if (t !== "") {
      let j = i;
      while (j < lines.length && lines[j].trim() !== "") j++;
      if (j - i >= 40) {
        out.push(foldPlaceholder(j - i));
        i = j;
        continue;
      }
    }
    out.push(lines[i]);
    i++;
  }
  return out;
}

// 规则②：完全重复行计数——相邻相同的非空行折叠为「行 ×N」（空行交给规则③）
function collapseDuplicateLines(lines: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line === "") {
      out.push(line);
      i++;
      continue;
    }
    let j = i + 1;
    while (j < lines.length && lines[j] === line) j++;
    if (j - i >= 2) out.push(`${line} ×${j - i}`);
    else out.push(line);
    i = j;
  }
  return out;
}

// 规则③：连续空行压缩为一个
function compressBlankRuns(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (line === "" && out[out.length - 1] === "") continue;
    out.push(line);
  }
  return out;
}

// 文本去重入口：① 折叠工具结果 → ② 相邻重复行计数 → ③ 压缩连续空行
export function dedupChunk(text: string): string {
  const lines = text.split(/\r?\n/);
  return compressBlankRuns(collapseDuplicateLines(foldToolBlocks(lines))).join("\n");
}

// ============ stamp 与归档写盘 ============

// 稳定键 → 12 位 sha256 十六进制 stamp
export function stampOf(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

// 归档目录：项目内 .stepcode/context-archive/（市场协议约定，跨机器/移仓可解析）
export function projectArchiveDir(projectRoot: string): string {
  return join(projectRoot, ".stepcode", "context-archive");
}

// 旧版归档目录（agentDir 下）。保留用于召回回落：0.1.x 之前的归档写在这里，
// 迁移后旧文件不搬家，recall 按「新目录优先、旧目录兜底」仍能取回。
export function legacyArchiveDir(agentDir: string): string {
  return join(agentDir, "context-archive");
}

/**
 * 判定磁盘上已存在的同名文件是否为「上次写盘被中断」的残骸。
 *
 * 为什么需要：`flag:"wx"` 保证不覆盖已存在文件，但**创建成功不等于写完**——进程
 * 在 writeFile 中途被杀、或 ENOSPC，都会留下一个内容是本次正文**严格前缀**的半截
 * 文件。没有这条自愈路径，该 stamp 之后每次归档都撞 EEXIST + 内容不同而失败，
 * 永久失去归档能力（本插件明确担心压缩过程中被宿主杀进程，所以这个状态是现实的）。
 * 内容与本次正文无前缀关系时返回 false，按「内容不同」处理、仍然拒绝覆盖。
 */
function isInterruptedWrite(existing: string, body: string): boolean {
  return existing.length > 0 && existing.length < body.length && body.startsWith(existing);
}

// 写入 <dir>/stamp-<stamp>.md，返回绝对路径。已存在同名文件不覆盖（见函数体注释）
export async function writeStamp(dir: string, stamp: string, body: string): Promise<string> {
  const file = resolve(dir, `stamp-${stamp}.md`);
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(file, body, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readFile(file, "utf8");
    if (existing === body) return file;
    if (isInterruptedWrite(existing, body)) {
      await writeFile(file, body, { encoding: "utf8" });
      return file;
    }
    throw new Error(`归档文件已存在且内容不同，拒绝覆盖：${file}`);
  }
  return file;
}

// stamp id 的两种合法形态：12 位小写十六进制为主格式；
// `b<块序号>-<yyyymmddhhmm>` 退化短 id 是主格式之外的显式例外（靠 b 前缀区分），市场协议已承认。
const HEX_ID_RE = /^[0-9a-f]{12}$/;
const FALLBACK_ID_RE = /^b\d+-\d{10,14}$/;

// 归档文件名：stamp-<id>.md。id 不含路径分隔符，杜绝路径穿越。
export const STAMP_FILE_RE = /^stamp-([0-9a-f]{12}|b\d+-\d{10,14})\.md$/;

// 归档文件绝对路径
export function stampFilePath(root: string, stamp: string): string {
  return join(root, `stamp-${stamp}.md`);
}

/**
 * 把用户/模型给的 stamp 归一化为 id：接受 12 位 hex、b 前缀退化 id、
 * `stamp-<id>.md` 文件名，或包含该文件名的任意路径（取 basename）。
 * 两种 id 形态都不含路径分隔符，配合 basename 双重杜绝路径穿越。
 */
export function normalizeStampId(raw: string): string | null {
  const input = raw.trim();
  if (HEX_ID_RE.test(input) || FALLBACK_ID_RE.test(input)) return input;
  const matched = STAMP_FILE_RE.exec(basename(input));
  return matched ? matched[1] : null;
}

// 索引行里的路径用项目相对路径 + 正斜杠（跨机器/移仓可解析，跨平台一致）
export function projectRelativePath(projectRoot: string, file: string): string {
  return relative(projectRoot, file).split(sep).join("/");
}

/**
 * 同步写盘版本，语义与 writeStamp 完全一致（wx 不覆盖 + 同内容幂等）。
 *
 * 为什么必须有同步版：宿主在中止压缩时**不会等异步钩子跑完**就继续走甚至退出进程，
 * 实测（365 条 branchEntries）await writeStamp 的落盘直接丢失，归档目录都没建成。
 * 压缩接管是"一次性、不可重来"的时刻，用同步写换"一定写完"是划算的：
 * 单次阻塞量级为本次归档的原文体积（实测 7 块 / 1.07MB 也在毫秒级）。
 */
export function writeStampSync(dir: string, stamp: string, body: string): string {
  const file = resolve(dir, `stamp-${stamp}.md`);
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(file, body, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = readFileSync(file, "utf8");
    if (existing === body) return file;
    if (isInterruptedWrite(existing, body)) {
      writeFileSync(file, body, { encoding: "utf8" });
      return file;
    }
    throw new Error(`归档文件已存在且内容不同，拒绝覆盖：${file}`);
  }
  return file;
}

// ============ 召回索引（INDEX.md） ============

export interface ArchiveIndexEntry {
	stamp: string;
	/** 项目相对路径 */
	path: string;
	bytes: number;
	/** 原文首个非空行，截断后作为一行提要 */
	firstLine: string;
}

/** 索引文件名（放在归档目录内，与 stamp 文件同级） */
export const ARCHIVE_INDEX_FILE = "INDEX.md";

/** 提要行截断长度（够认出一个块，又不至于把索引撑爆） */
const INDEX_PREVIEW_CHARS = 120;

/** 从归档原文取首个非空行并截断（纯函数，可测） */
export function archivePreview(text: string): string {
	const line = text.split(/\r?\n/).find((candidate) => candidate.trim().length > 0) ?? "";
	return line.trim().slice(0, INDEX_PREVIEW_CHARS);
}

/**
 * 渲染召回索引。**为什么需要它**：压缩被宿主中止时，`#STAMP` 索引行不会进入会话上下文，
 * 模型就不知道有哪些块可召回。这里在磁盘上留一份人类/模型都能读的清单，
 * 让「原文已落盘」这件事在任何情况下都可被发现。
 */
export function renderArchiveIndex(entries: ArchiveIndexEntry[]): string {
	const lines = [
		"# context-archive 召回索引",
		"",
		"> 本文件由插件自动生成。它列出本项目已归档的历史任务块。",
		"> 需要某块的完整原文时，用 `recall_by_stamp(stamp)` 或 `/recall-stamp <stamp>` 按 stamp 取回；",
		"> 摘要只是导航，一切以归档原文为准。",
		"",
	];
	if (entries.length === 0) {
		lines.push("（暂无归档）", "");
		return lines.join("\n");
	}
	lines.push("| stamp | 文件 | 字节 | 原文首行 |", "| --- | --- | ---: | --- |");
	for (const entry of entries) {
		// 管道符会破坏 Markdown 表格
		const preview = entry.firstLine.replace(/\|/g, "\\|");
		lines.push(`| \`${entry.stamp}\` | \`${entry.path}\` | ${entry.bytes} | ${preview} |`);
	}
	lines.push("");
	return lines.join("\n");
}

/**
 * 扫描归档目录、重写 INDEX.md。幂等：每次都从磁盘现状重建，
 * 因此删掉归档文件后索引自动收敛，不会残留指向已删文件的条目。
 * @returns 索引文件的项目相对路径（写入失败时返回兜底相对路径，不抛错）
 */
export function writeArchiveIndexSync(dir: string, toProjectRelative: (abs: string) => string): string {
	const indexPath = resolve(dir, ARCHIVE_INDEX_FILE);
	let names: string[] = [];
	try {
		names = readdirSync(dir);
	} catch {
		names = [];
	}
	const entries: ArchiveIndexEntry[] = [];
	for (const name of names.sort()) {
		if (!STAMP_FILE_RE.test(name)) continue;
		const abs = join(dir, name);
		let bytes = 0;
		let firstLine = "";
		try {
			bytes = statSync(abs).size;
			firstLine = archivePreview(readFileSync(abs, "utf8"));
		} catch {
			// 单个文件读不了就跳过该条，不让索引失败拖垮归档
			continue;
		}
		entries.push({ stamp: name.slice("stamp-".length, -".md".length), path: toProjectRelative(abs), bytes, firstLine });
	}
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(indexPath, renderArchiveIndex(entries), "utf8");
	} catch {
		// 索引写不了不影响归档本体；诊断行里仍会打印它的路径，如实告知
	}
	return toProjectRelative(indexPath);
}

// ============ 三点摘要 prompt 与解析 ============

// 生成「目标 / 关键决策 / 是否完成」三点结构的中文摘要指令
export function summaryPrompt(chunkText: string): string {
  return [
    "请为下面的对话上下文生成摘要，严格遵守：",
    "1. 三点结构：目标 / 关键决策 / 是否完成；",
    "2. 每点一行，总共不超过 6 行；",
    "3. 只输出纯文本，不要 markdown，不要代码围栏。",
    "",
    "对话上下文开始",
    chunkText,
    "对话上下文结束",
  ].join("\n");
}

// 清洗 LLM 返回：剥离 markdown 代码围栏、压缩空行、截断到 600 字符
export function parseSummary(raw: string): string {
  const noFences = raw
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("```"))
    .join("\n");
  const compressed = noFences.replace(/\n{2,}/g, "\n").trim();
  return compressed.length > 600 ? compressed.slice(0, 600) : compressed;
}

// ============ 有界投影 ============

// 投影标记行前缀（与测试断言保持同源一致）
const PROJECTION_PREFIX = "[tool-result-projection]";

// 投影标记行：中间被替换的那一行，指向归档 stamp 文件
function projectionLine(stamp: string | undefined): string {
  return `${PROJECTION_PREFIX} 正文已投影，全文归档于 stamp-${stamp}.md（用 recall_by_stamp 召回）`;
}

// 判断是否为 UTF-16 低代理项（避免把增补平面字符切成两半）
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

// CJK 字符（假名 + 表意文字 + 谚文）：UTF-8 占 2~3 字节，经验值约 1 字 1 token
const CJK_RE = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/g;

/**
 * 估算 token 数：CJK 按 1 字 1 token、其余按每 4 字符 1 token 分别折算后求和。
 *
 * 为什么不对齐宿主的 len/4：那条启发式按 ASCII 标定，对中文会低估约 4 倍
 * （8000 个中文字符真实约 8000 token，len/4 只算出 2000）。低估会让「超过上限
 * 就投影 / 就调模型做摘要」的判断集体失准，而这两处都是**丢弃数据**的硬决策，
 * 偏差后果集中在这里，故按字符集分别折算。
 */
export function estimateTokens(text: string): number {
  const cjk = text.match(CJK_RE)?.length ?? 0;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

/**
 * 给定文本，按它自身的 CJK 密度换算：能装下 targetTokens 个 token 需要多少字符。
 * 中文与 ASCII 的 token/字符密度差约 4 倍，固定乘 4 会在纯中文正文上把预算撑爆。
 */
function charsForTokens(text: string, targetTokens: number): number {
  if (text.length === 0) return 0;
  const density = estimateTokens(text) / text.length;
  return density > 0 ? Math.floor(targetTokens / density) : 0;
}

// 工具结果有界投影：总文本超 maxTokens（默认 10000）时保头 70%、保尾 30%，
// 预算按 token 估算换算成字符，尾部切点做代理对保护以落在字符边界，
// 中间替换为一行投影标记；image 等非 text 片段原位保留。
// fullText 返回原文全文，由调用方（index 层）负责写入归档。
// 幂等：文本已含投影前缀时原样返回且 projected=false。
export function projectToolResult(
  content: Array<{ type: string; text?: string }>,
  maxTokens?: number,
  stamp?: string
): { content: Array<{ type: string; text?: string }>; projected: boolean; fullText: string } {
  const limit = maxTokens ?? 10_000;
  const textParts = content.filter((part) => part.type === "text" && typeof part.text === "string");
  const fullText = textParts.map((part) => part.text as string).join("\n");
  if (fullText.includes(PROJECTION_PREFIX)) return { content, projected: false, fullText };
  if (estimateTokens(fullText) <= limit) return { content, projected: false, fullText };
  const headChars = charsForTokens(fullText, limit * 0.7);
  const tailChars = charsForTokens(fullText, limit * 0.3);
  let headEnd = Math.min(headChars, fullText.length);
  if (headEnd < fullText.length && isLowSurrogate(fullText.charCodeAt(headEnd))) headEnd--;
  let tailStart = Math.max(fullText.length - tailChars, 0);
  if (tailStart > 0 && isLowSurrogate(fullText.charCodeAt(tailStart))) tailStart++;
  const merged =
    `${fullText.slice(0, headEnd)}\n${projectionLine(stamp)}\n${fullText.slice(tailStart)}`;
  // 多个 text 片段合并为一个投影后的片段，放在首个 text 片段的位置
  const out: Array<{ type: string; text?: string }> = [];
  let mergedIn = false;
  for (const part of content) {
    if (part.type === "text" && typeof part.text === "string") {
      if (!mergedIn) {
        out.push({ type: "text", text: merged });
        mergedIn = true;
      }
    } else {
      out.push(part);
    }
  }
  return { content: out, projected: true, fullText };
}

// stamp 行：单行可读的「stamp → 归档路径 — 摘要」引用格式
export function formatStampLine(stamp: string, path: string, summary: string): string {
  return `#STAMP ${stamp} → ${path} — ${summary}`;
}

// 归档失败块的摘要行：**没有指针**，只留摘要本身。
// 为什么不给 #STAMP：写盘失败意味着磁盘上同名文件存在且内容不同（见 writeStampSync），
// 给出指针会让后来按 stamp 召回的人读到别人的内容——那比明确说"这块没存下来"更糟。
export function formatUnarchivedLine(summary: string): string {
  return `#UNARCHIVED（原文未落盘，无法召回）— ${summary}`;
}