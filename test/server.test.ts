import { describe, expect, it } from "vitest";
import {
	countStamps,
	findRegisteredSources,
	INSTALL_COMMAND,
	mentionsRepo,
	projectArchiveDir,
	renderStatus,
	REPO_URL,
	STAMP_FILE_RE,
	TOOL_SCHEMA,
	VERSION,
} from "../server/lib.mjs";

describe("常量与安装指令", () => {
	it("安装指令就是一条 step install 指向本仓库", () => {
		expect(REPO_URL).toBe("https://github.com/uos1231234/step-context-archive");
		expect(INSTALL_COMMAND).toBe(`step install ${REPO_URL}`);
	});

	it("版本号与 package.json 一致（读不到时降级而非抛错）", () => {
		expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
	});
});

describe("mentionsRepo", () => {
	it("命中包含仓库 URL 的配置文本", () => {
		expect(mentionsRepo(`packages = [ "${REPO_URL}" ]`)).toBe(true);
	});

	it("未登记时为 false", () => {
		expect(mentionsRepo('packages = [ "https://github.com/other/pkg" ]')).toBe(false);
		expect(mentionsRepo("")).toBe(false);
	});

	it("非字符串输入不抛错", () => {
		expect(mentionsRepo(undefined)).toBe(false);
		expect(mentionsRepo(null)).toBe(false);
	});
});

describe("findRegisteredSources", () => {
	it("只返回登记了我们源的配置路径", () => {
		const files: Record<string, string> = {
			"/a/config.toml": `packages = [ "${REPO_URL}" ]`,
			"/b/config.toml": "packages = []",
		};
		const found = findRegisteredSources(Object.keys(files), (p: string) => files[p]);
		expect(found).toEqual(["/a/config.toml"]);
	});

	it("读不存在的路径静默跳过（首次安装前它们本来就不存在）", () => {
		const readFile = (p: string) => {
			if (p === "/missing.toml") throw new Error("ENOENT");
			return `packages = [ "${REPO_URL}" ]`;
		};
		expect(findRegisteredSources(["/missing.toml", "/ok.toml"], readFile)).toEqual(["/ok.toml"]);
	});
});

describe("countStamps", () => {
	it("只统计 stamp-<id>.md，两种 id 形态都认", () => {
		const listing = () => [
			"stamp-abc123def456.md",
			"stamp-b3-202609272200.md",
			"README.md",
			"stamp-tooshort.md",
			"stamp-bx-2026.md",
			"notes.txt",
		];
		expect(countStamps(listing, "/x")).toBe(2);
	});

	it("目录不可读时返回 0 而不抛错", () => {
		const boom = (): string[] => {
			throw new Error("ENOENT");
		};
		expect(countStamps(boom, "/missing")).toBe(0);
	});

	it("STAMP_FILE_RE 与 pipeline 的 id 口径一致", () => {
		expect(STAMP_FILE_RE.test("stamp-abc123def456.md")).toBe(true);
		expect(STAMP_FILE_RE.test("stamp-b3-202609272200.md")).toBe(true);
		expect(STAMP_FILE_RE.test("stamp-abc.md")).toBe(false);
	});
});

describe("projectArchiveDir", () => {
	it("落在项目内 .stepcode/context-archive（与扩展写入位置同口径）", () => {
		expect(projectArchiveDir("/proj").replace(/\\/g, "/")).toBe("/proj/.stepcode/context-archive");
	});
});

describe("renderStatus", () => {
	const base = {
		version: "0.2.0",
		registeredSources: [] as string[],
		projectStamps: 0,
		legacyStamps: 0,
	};

	it("未登记时给出 step install 命令并说明市场为何不生效", () => {
		const text = renderStatus(base);
		expect(text).toContain(INSTALL_COMMAND);
		expect(text).toContain("未检测到代码版登记");
		expect(text).toContain("只做分发不装载");
	});

	it("已登记时列出配置来源，不再重复命令（但保留事实说明）", () => {
		const text = renderStatus({ ...base, registeredSources: ["/x/config.toml"], projectStamps: 3 });
		expect(text).toContain("/x/config.toml");
		expect(text).toContain("已登记代码版");
		expect(text).toContain("3");
	});

	it("已登记但零归档时解释这是正常现象（首次接管要等压缩阈值）", () => {
		const text = renderStatus({ ...base, registeredSources: ["/x/config.toml"] });
		expect(text).toContain("尚未产生归档文件属正常");
	});

	it("未登记但项目内已有归档时提示登记可能被移除", () => {
		const text = renderStatus({ ...base, projectStamps: 7 });
		expect(text).toContain("此前运行过");
		expect(text).toContain("7");
	});
});

describe("TOOL_SCHEMA", () => {
	it("是无参数的 JSON Schema，描述里含安装引导", () => {
		expect(TOOL_SCHEMA.name).toBe("context_archive_status");
		expect(TOOL_SCHEMA.inputSchema.type).toBe("object");
		expect(Object.keys(TOOL_SCHEMA.inputSchema.properties ?? {})).toHaveLength(0);
		expect(TOOL_SCHEMA.description).toContain("step install");
	});
});
