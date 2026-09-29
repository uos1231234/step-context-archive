import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

	it("插件清单不含 mcpServers（宿主不注入插件 cwd，相对 args 永远起不来）", () => {
		const manifest = JSON.parse(read("../step.plugin.json"));
		// mcp.ts:238-241 不把插件目录作为 cwd 注入；相对 args 会按用户项目 cwd 解析
		expect(manifest.mcpServers).toBeUndefined();
	});

	it("插件清单的 description 带 step install 引导（UI 会渲染 description）", () => {
		const manifest = JSON.parse(read("../step.plugin.json"));
		// plugins.ts:1445-1446 把 description 交给 /plugin browse、/plugin list 与安装诊断
		expect(manifest.description).toContain("step install https://github.com/uos1231234/step-context-archive");
		expect(manifest.description).toContain("市场安装只交付文件");
	});

	it("仓库里不再有 MCP 提示服务产物", () => {
		expect(existsSync(fileURLToPath(new URL("../server", import.meta.url)))).toBe(false);
	});

	it("package.json 声明 pi 清单（step install 装载通道的命门）", () => {
		const pkg = JSON.parse(read("../package.json"));
		// 官方 DefaultPackageManager 读 package.json 的 pi 字段决定装载哪些资源
		expect(pkg.pi.extensions).toEqual(["./src/index.ts"]);
		expect(pkg.pi.skills).toEqual(["./skills/context-archive"]);
	});

	it("pi 与 step 两个清单键内容一致（文档正文叫 step、示例与实现叫 pi，双写兜底）", () => {
		const pkg = JSON.parse(read("../package.json"));
		expect(pkg.step).toEqual(pkg.pi);
	});

	it("带 pi-package 关键字（官方 package gallery 的收录标记）", () => {
		const pkg = JSON.parse(read("../package.json"));
		expect(pkg.keywords).toContain("pi-package");
	});

	it("pi 清单指向的文件真实存在（清单与仓库结构不能漂移）", () => {
		const pkg = JSON.parse(read("../package.json"));
		const root = new URL("../", import.meta.url);
		for (const rel of [...pkg.pi.extensions, ...pkg.pi.skills]) {
			expect(existsSync(fileURLToPath(new URL(rel, root)))).toBe(true);
		}
	});

	it("README 安装说明含 -ne 防重复装载与 pipeline 成对复制", () => {
		const readme = read("../README.md");
		expect(readme).toContain("-ne");
		expect(readme).toContain("pipeline.ts");
	});
});
