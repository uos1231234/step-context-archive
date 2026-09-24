import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), "utf8");

describe("仓库元数据（防回归）", () => {
	it("双 marketplace 的 source 指向仓库根且两份内容一致", () => {
		const step = JSON.parse(read("../.step-plugin/marketplace.json"));
		const claude = JSON.parse(read("../.claude-plugin/marketplace.json"));
		expect(step.plugins[0].source).toBe(".");
		expect(step.plugins[0].name).toBe("context-archive");
		expect(claude).toEqual(step);
	});

	it("step.plugin.json 不声明 entry（宿主不加载，避免虚假预期）", () => {
		const manifest = JSON.parse(read("../step.plugin.json"));
		expect(manifest.entry).toBeUndefined();
		expect(manifest.id).toBe("context-archive");
	});

	it("README 安装说明含 -ne 防重复装载与 pipeline 成对复制", () => {
		const readme = read("../README.md");
		expect(readme).toContain("-ne");
		expect(readme).toContain("pipeline.ts");
	});
});
