import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  THRESHOLDS,
  DEFAULT_ENTER_POLICY,
  decideFold,
  dedupChunk,
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
  writeStamp,
} from "../src/pipeline.ts";

// 大字符串一律用混合内容构造，避免单字符重复触发分词器病态慢路径
function mixedText(count: number): string {
  return Array.from({ length: count }, (_, i) => `chunk-${i}-xxxxxxxx`).join(" ");
}

describe("THRESHOLDS / ENTER_POLICY", () => {
  it("折叠门限为拍板值 80", () => {
    expect(THRESHOLDS.foldPercent).toBe(80);
  });

  it("介入策略默认自适应：比例 0.25、绝对下限 100K、无固定覆盖", () => {
    expect(DEFAULT_ENTER_POLICY.enterTokens).toBeNull();
    expect(DEFAULT_ENTER_POLICY.enterPercent).toBe(0.25);
    expect(DEFAULT_ENTER_POLICY.floor).toBe(100_000);
  });
});

describe("effectiveEnterTokens（按模型窗口自适应）", () => {
  it("窗口未知或非正时退化为下限，行为不因缺信息漂移", () => {
    expect(effectiveEnterTokens(undefined, undefined)).toBe(100_000);
    expect(effectiveEnterTokens(undefined, 0)).toBe(100_000);
  });

  it("256K 窗口：25% 只有 64K，被下限兜到 100K —— 与旧版行为逐字节一致", () => {
    expect(effectiveEnterTokens(undefined, 256_000)).toBe(100_000);
  });

  it("1M 窗口：25% = 250K，显著高于旧的固定 100K（用户要求：1M 等超过约 256K 再压缩）", () => {
    expect(effectiveEnterTokens(undefined, 1_000_000)).toBe(250_000);
  });

  it("显式 enterTokens 非 null 时直接覆盖，忽略窗口与下限", () => {
    const policy = { enterTokens: 42_000, enterPercent: 0.25, floor: 100_000 };
    expect(effectiveEnterTokens(policy, 1_000_000)).toBe(42_000);
    expect(effectiveEnterTokens(policy, undefined)).toBe(42_000);
  });
});

describe("decideFold", () => {
  it("usage 缺失或 tokens 为 null 时 silent", () => {
    expect(decideFold(undefined)).toBe("silent");
    expect(decideFold({ tokens: null, percent: null })).toBe("silent");
  });

  it("256K 窗口下未达 100K 一律 silent（即使 percent 已很高，与旧版一致）", () => {
    expect(decideFold({ tokens: 99_999, contextWindow: 256_000, percent: 85 })).toBe("silent");
  });

  it("1M 窗口下 150K 仍 silent、260K 起介入（自适应抬高了介入线）", () => {
    expect(decideFold({ tokens: 150_000, contextWindow: 1_000_000, percent: 15 })).toBe("silent");
    expect(decideFold({ tokens: 260_000, contextWindow: 1_000_000, percent: 26 })).toBe("dedup");
  });

  it("tokens 达标但 percent 低于 80 时 dedup", () => {
    expect(decideFold({ tokens: 100_000, contextWindow: 256_000, percent: 39 })).toBe("dedup");
  });

  it("percent 达到 80 时 summarize", () => {
    expect(decideFold({ tokens: 205_000, contextWindow: 256_000, percent: 80 })).toBe("summarize");
  });

  it("percent 为 null 时按 tokens/contextWindow 手算", () => {
    expect(decideFold({ tokens: 160_000, contextWindow: 200_000, percent: null })).toBe("summarize");
    expect(decideFold({ tokens: 100_000, contextWindow: 200_000, percent: null })).toBe("dedup");
  });

  it("percent 为 null 且 contextWindow 不可得时保守 dedup", () => {
    expect(decideFold({ tokens: 500_000, percent: null })).toBe("dedup");
  });
});

describe("semanticChunks", () => {
  const entries: Array<Record<string, any>> = [
    { type: "message", id: "m1", message: { role: "user", content: "问题一" } },
    { type: "message", id: "m2", message: { role: "user", content: "补充" } },
    { type: "compaction", id: "c1" },
    { type: "message", id: "m3", message: { role: "assistant", content: "回答一" } },
    { type: "message", id: "m4", message: { role: "assistant", content: [{ type: "text", text: "继续输出" }] } },
    { type: "message", id: "m5", message: { role: "user", content: "问题二" } },
    { type: "message", id: "m6", message: { role: "assistant", content: "回答二" } },
  ];

  it("按角色切换语义分块，非 message 条目跳过不入块", () => {
    const chunks = semanticChunks(entries);
    expect(chunks.map((c) => c.entryIds)).toEqual([
      ["m1", "m2"],
      ["m3", "m4"],
      ["m5"],
      ["m6"],
    ]);
    for (const c of chunks) expect(c.entryIds).not.toContain("c1");
  });

  it("key 为 entryIds 首尾拼接，text 含角色前缀与内容", () => {
    const chunks = semanticChunks(entries);
    expect(chunks[0].key).toBe("m1..m2");
    expect(chunks[2].key).toBe("m5..m5");
    expect(chunks[0].text).toContain("user: 问题一");
    expect(chunks[1].text).toContain("assistant: 回答一");
    expect(chunks[1].text).toContain("继续输出");
  });

  it("空输入返回空数组", () => {
    expect(semanticChunks([])).toEqual([]);
  });
});

describe("dedupChunk", () => {
  it("规则一：连续 40 行以上的行块折叠为占位行", () => {
    const block = Array.from({ length: 45 }, (_, i) => `line-${i}-aaaaaaaa`).join("\n");
    const out = dedupChunk(`head\n\n${block}\n\ntail`);
    expect(out).toContain("… [已折叠 45 行 · 去重]");
    expect(out).not.toContain("line-10-aaaaaaaa");
    expect(out).toContain("head");
    expect(out).toContain("tail");
  });

  it("规则一：不足 40 行的普通行块不动", () => {
    const block = Array.from({ length: 10 }, (_, i) => `line-${i}-bbbbbbbb`).join("\n");
    expect(dedupChunk(block)).toBe(block);
  });

  it("规则一：Result of 标记块折叠到空行为止", () => {
    const src = ["Result of tool:", "r1", "r2", "r3", "r4", "r5", "", "after"].join("\n");
    expect(dedupChunk(src)).toBe("… [已折叠 6 行 · 去重]\n\nafter");
  });

  it("规则一：成对 output 标签块整块折叠", () => {
    const src = ["<output>", "x1", "x2", "</output>", "after"].join("\n");
    expect(dedupChunk(src)).toBe("… [已折叠 4 行 · 去重]\nafter");
  });

  it("规则二：相邻相同行折叠为 行 ×N", () => {
    expect(dedupChunk("same\nsame\nsame\ndiff")).toBe("same ×3\ndiff");
  });

  it("规则三：连续空行压缩为一个且不产生重复计数", () => {
    expect(dedupChunk("a\n\n\n\nb")).toBe("a\n\nb");
    expect(dedupChunk("a\n\n\nb")).not.toContain("×");
  });

  it("组合：只动该动的部分", () => {
    expect(dedupChunk("alpha\nalpha\nbeta\n\n\n\ngamma")).toBe("alpha ×2\nbeta\n\ngamma");
    expect(dedupChunk("唯一行甲\n唯一行乙")).toBe("唯一行甲\n唯一行乙");
  });
});

describe("stampOf", () => {
  it("确定性、12 位十六进制、不同键不同值", () => {
    const a = stampOf("m1..m6");
    expect(a).toBe(stampOf("m1..m6"));
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(a).not.toBe(stampOf("m1..m7"));
  });
});

describe("归档目录", () => {
  it("projectArchiveDir 为项目内 .stepcode/context-archive", () => {
    expect(projectArchiveDir("base")).toBe(join("base", ".stepcode", "context-archive"));
    expect(projectArchiveDir(join("D:", "proj"))).toBe(
      join("D:", "proj", ".stepcode", "context-archive"),
    );
  });

  it("legacyArchiveDir 为 agentDir 下的 context-archive（旧版回落用）", () => {
    expect(legacyArchiveDir("base")).toBe(join("base", "context-archive"));
  });
});

describe("stampFilePath / normalizeStampId", () => {
  it("接受 12 位 hex id", () => {
    expect(normalizeStampId("abc123def456")).toBe("abc123def456");
    expect(stampFilePath("/r", "abc123def456")).toBe(join("/r", "stamp-abc123def456.md"));
  });

  it("接受市场协议承认的 b 前缀退化短 id", () => {
    expect(normalizeStampId("b3-202609272200")).toBe("b3-202609272200");
    expect(normalizeStampId("stamp-b3-202609272200.md")).toBe("b3-202609272200");
  });

  it("接受文件名与含该文件名的任意路径（项目相对/绝对都取 basename）", () => {
    expect(normalizeStampId("stamp-abc123def456.md")).toBe("abc123def456");
    expect(normalizeStampId(".stepcode/context-archive/stamp-abc123def456.md")).toBe(
      "abc123def456",
    );
    expect(normalizeStampId("C:\\proj\\.stepcode\\context-archive\\stamp-abc123def456.md")).toBe(
      "abc123def456",
    );
  });

  it("拒绝非法 id 与路径穿越", () => {
    expect(normalizeStampId("abc123")).toBeNull();
    expect(normalizeStampId("../../etc/passwd")).toBeNull();
    expect(normalizeStampId("b3-2026")).toBeNull();
    expect(normalizeStampId("bX-202609272200")).toBeNull();
    expect(normalizeStampId("")).toBeNull();
  });
});

describe("projectRelativePath", () => {
  it("输出项目相对路径且统一正斜杠", () => {
    const root = resolve("D:", "proj");
    const file = projectArchiveDir(root) + "\\stamp-abc123def456.md";
    expect(projectRelativePath(root, file)).toBe(
      ".stepcode/context-archive/stamp-abc123def456.md",
    );
  });
});

describe("writeStamp", () => {
  it("实际写盘并返回绝对路径", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sca-"));
    try {
      const stamp = stampOf("k1");
      const file = await writeStamp(dir, stamp, "正文一");
      expect(isAbsolute(file)).toBe(true);
      expect(basename(file)).toBe(`stamp-${stamp}.md`);
      expect(await readFile(file, "utf8")).toBe("正文一");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("内容相同的重复写幂等返回同一路径（不报错、不重复写）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sca-"));
    try {
      const stamp = stampOf("k1");
      const first = await writeStamp(dir, stamp, "同一份");
      const again = await writeStamp(dir, stamp, "同一份");
      expect(again).toBe(first);
      expect(await readFile(first, "utf8")).toBe("同一份");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("内容不同时拒绝覆盖并抛错（市场协议安全红线）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sca-"));
    try {
      const stamp = stampOf("k1");
      const file = await writeStamp(dir, stamp, "原始内容");
      await expect(writeStamp(dir, stamp, "被篡改的内容")).rejects.toThrow(/拒绝覆盖/);
      // 旧内容必须原样保留
      expect(await readFile(file, "utf8")).toBe("原始内容");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("summaryPrompt / parseSummary", () => {
  it("prompt 含三点结构关键词与上下文原文", () => {
    const p = summaryPrompt("目标行上下文");
    expect(p).toContain("目标");
    expect(p).toContain("关键决策");
    expect(p).toContain("是否完成");
    expect(p).toContain("6 行");
    expect(p).toContain("目标行上下文");
  });

  it("parseSummary 剥离代码围栏并压缩空行", () => {
    const raw = "```md\n第一行\n\n\n第二行\n```";
    expect(parseSummary(raw)).toBe("第一行\n第二行");
  });

  it("parseSummary 截断到 600 字符", () => {
    const long = mixedText(70);
    expect(long.length).toBeGreaterThan(600);
    const out = parseSummary(long);
    expect(out.length).toBe(600);
    expect(out.startsWith("chunk-0-xxxxxxxx")).toBe(true);
  });
});

describe("projectToolResult", () => {
  const stamp = "abc123def456";

  it("未超限原样返回", () => {
    const content = [
      { type: "text", text: "短文本" },
      { type: "image" },
    ];
    const r = projectToolResult(content, 100, stamp);
    expect(r.projected).toBe(false);
    expect(r.content).toEqual(content);
    expect(r.fullText).toBe("短文本");
  });

  it("超限时保头 70%、保尾 30%、插入投影标记，image 不动", () => {
    const original = mixedText(200);
    const content: Array<{ type: string; text?: string }> = [
      { type: "text", text: original },
      { type: "image" },
    ];
    expect(estimateTokens(original)).toBeGreaterThan(100);
    const r = projectToolResult(content, 100, stamp);
    expect(r.projected).toBe(true);
    expect(r.fullText).toBe(original);
    expect(r.content[r.content.length - 1]).toEqual({ type: "image" });
    const text = r.content[0].text ?? "";
    expect(text).toContain("chunk-0-xxxxxxxx");
    expect(text).toContain("chunk-199-xxxxxxxx");
    expect(text).not.toContain("chunk-100-xxxxxxxx");
    const marker = text.split("\n").find((line) => line.startsWith("[tool-result-projection]"));
    expect(marker).toBeDefined();
    expect(marker).toContain(`stamp-${stamp}.md`);
    // 标记行约占 20 余 token：投影后总量应有界（头 280 + 尾 120 + 标记行开销）
    expect(estimateTokens(text)).toBeLessThanOrEqual(130);
    expect(estimateTokens(text)).toBeLessThan(estimateTokens(original));
  });

  it("幂等：已含投影前缀的文本原样返回", () => {
    const original = mixedText(200);
    const first = projectToolResult([{ type: "text", text: original }], 100, stamp);
    const second = projectToolResult(first.content, 100, stamp);
    expect(second.projected).toBe(false);
    expect(second.content).toEqual(first.content);
    expect(second.fullText).toContain("[tool-result-projection]");
  });

  it("纯 image 内容不投影", () => {
    const content = [{ type: "image" }];
    const r = projectToolResult(content, 1, stamp);
    expect(r.projected).toBe(false);
    expect(r.content).toEqual(content);
  });
});

describe("formatStampLine", () => {
  it("输出精确单行格式", () => {
    expect(formatStampLine("abc123def456", "/tmp/stamp-abc123def456.md", "三条摘要")).toBe(
      "#STAMP abc123def456 → /tmp/stamp-abc123def456.md — 三条摘要"
    );
  });
});

describe("estimateTokens", () => {
  it("按每 4 字符 1 token 向上取整", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens(mixedText(200))).toBe(923);
  });
});