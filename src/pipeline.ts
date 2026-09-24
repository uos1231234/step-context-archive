// 上下文归档流水线（step-context-archive 纯逻辑层）
// 宿主通过 jiti 直接加载本 TS 源码，运行时零第三方依赖：
// 只允许 import node 内置模块，宿主类型一律用本地最小结构接口（鸭子类型）对齐。

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

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
export const THRESHOLDS = { enterTokens: 100_000, foldPercent: 80 } as const;

export type FoldDecision = "silent" | "dedup" | "summarize";

// 三态决策：silent 不介入 / dedup 算法去重 / summarize 调 LLM 摘要
export function decideFold(usage: { tokens: number | null; contextWindow?: number; percent: number | null } | undefined): FoldDecision {
  if (!usage) return "silent";
  const { tokens, contextWindow, percent } = usage;
  if (tokens == null || tokens < THRESHOLDS.enterTokens) return "silent";
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

// 归档目录固定为 agentDir 下的 context-archive
export function archiveDir(agentDir: string): string {
  return join(agentDir, "context-archive");
}

// 写入 <dir>/stamp-<stamp>.md（已存在则覆盖为同内容），返回绝对路径
export async function writeStamp(dir: string, stamp: string, body: string): Promise<string> {
  const file = resolve(dir, `stamp-${stamp}.md`);
  await mkdir(dir, { recursive: true });
  await writeFile(file, body, "utf8");
  return file;
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

// 估算 token 数：每 4 字符折算 1 token，向上取整
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// 工具结果有界投影：总文本超 maxTokens（默认 20000）时保头 70%、保尾 30%，
// 预算按 token 估算换算成字符，尾部切点做代理对保护以落在字符边界，
// 中间替换为一行投影标记；image 等非 text 片段原位保留。
// fullText 返回原文全文，由调用方（index 层）负责写入归档。
// 幂等：文本已含投影前缀时原样返回且 projected=false。
export function projectToolResult(
  content: Array<{ type: string; text?: string }>,
  maxTokens?: number,
  stamp?: string
): { content: Array<{ type: string; text?: string }>; projected: boolean; fullText: string } {
  const limit = maxTokens ?? 20_000;
  const textParts = content.filter((part) => part.type === "text" && typeof part.text === "string");
  const fullText = textParts.map((part) => part.text as string).join("\n");
  if (fullText.includes(PROJECTION_PREFIX)) return { content, projected: false, fullText };
  if (estimateTokens(fullText) <= limit) return { content, projected: false, fullText };
  const headChars = Math.floor(limit * 0.7) * 4;
  const tailChars = Math.floor(limit * 0.3) * 4;
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