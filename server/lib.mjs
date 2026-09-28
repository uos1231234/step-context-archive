/**
 * context-archive 安装提示服务 —— 纯逻辑层（零运行时依赖）。
 *
 * 存在意义：声明式/市场副本装上后，宿主的 `commands/` 与 `skills/` 不会被装载，
 * 全仓库唯一能在运行时触达模型的是内联 `mcpServers`。所以用一个小工具回答
 * 「我到底该装哪个、装上了没有」，把用户从"只分发不装载"的市场通道
 * 引导到真正可用的 `step install` 通道。
 *
 * 协议与 @modelcontextprotocol/sdk 兼容；stdio 接线在 ./index.mjs。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** 本插件代码版的仓库（step install 的唯一来源） */
export const REPO_URL = "https://github.com/uos1231234/step-context-archive";

/** 一条命令装上完整功能 */
export const INSTALL_COMMAND = `step install ${REPO_URL}`;

/** 与本仓库 package.json 同源；读不到时降级为 0.0.0，绝不因此让服务起不来 */
export const VERSION = (() => {
	try {
		const pkg = JSON.parse(
			readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "..", "package.json"), "utf8"),
		);
		return typeof pkg.version === "string" ? pkg.version : "0.0.0";
	} catch {
		return "0.0.0";
	}
})();

/** 归档目录（与 pipeline.ts 的 projectArchiveDir 同口径：项目内、跨机器可解析） */
export function projectArchiveDir(projectRoot) {
	return join(projectRoot, ".stepcode", "context-archive");
}

/** 归档文件名（与 pipeline.ts 的 STAMP_FILE_RE 同源口径：12-hex 主格式 + b 前缀退化 id） */
export const STAMP_FILE_RE = /^stamp-(?:[0-9a-f]{12}|b\d+-\d{10,14})\.md$/;

/**
 * 判断一段配置文本里是否登记了本插件的代码版源。
 * 故意只做「包含 REPO_URL 的字符串」判断，不解析 TOML/JSON 语法——
 * 提示服务只需要回答"登没登记"，不需要理解配置的其余部分。
 */
export function mentionsRepo(text) {
	return typeof text === "string" && text.includes(REPO_URL);
}

/**
 * 从一组候选配置文件路径中找出登记了我们源的那些（存在的、可读的）。
 * 不存在的路径静默跳过——首次安装前它们本来就不存在，不该报错。
 */
export function findRegisteredSources(paths, readFile) {
	return paths.filter((p) => {
		try {
			return mentionsRepo(readFile(p));
		} catch {
			return false;
		}
	});
}

/** 统计目录下的归档文件数；目录不存在返回 0（不抛错） */
export function countStamps(readdirSync, dir) {
	try {
		return readdirSync(dir).filter((name) => STAMP_FILE_RE.test(name)).length;
	} catch {
		return 0;
	}
}

/**
 * 渲染状态报告。纯函数，便于测试断言。
 * @param {{registeredSources: string[], projectStamps: number, legacyStamps: number, version: string}} state
 */
export function renderStatus(state) {
	const lines = [];
	const registered = state.registeredSources.length > 0;

	lines.push(`context-archive 安装状态（提示服务 v${state.version}）`);
	lines.push("");

	if (registered) {
		lines.push("已登记代码版：以下配置里能找到本插件的源");
		for (const p of state.registeredSources) lines.push(`  - ${p}`);
		lines.push("");
		lines.push(
			`归档文件：项目内 ${state.projectStamps} 个，旧版目录 ${state.legacyStamps} 个。`,
		);
		if (state.projectStamps === 0) {
			lines.push(
				"尚未产生归档文件属正常——扩展会在会话接近压缩阈值时才首次接管。请新建会话或继续长会话观察。",
			);
		}
		lines.push(
			"提示：本扩展的三个事件钩子（turn_end / session_before_compact / tool_result）在会话启动时注册；若刚执行安装，请重启 Step Code 或用 /reload 热载。",
		);
		return lines.join("\n");
	}

	lines.push("未检测到代码版登记：当前只有声明式/市场副本被安装，它不会装载命令或技能。");
	lines.push("");
	lines.push("要让自动压缩真正生效，请运行这一条命令：");
	lines.push("");
	lines.push(`  ${INSTALL_COMMAND}`);
	lines.push("");
	lines.push("说明：");
	lines.push(
		"  · 宿主 v0.1.1 的插件市场只做分发不装载（清单 entry 仅记录不加载），",
	);
	lines.push(
		"    只有内联 mcpServers 会启动——也就是你现在看到的这个提示服务本身。",
	);
	lines.push(
		"  · step install 走官方资源包通道，产物经资源加载器真正加载，",
	);
	lines.push("    pi.on() 事件钩子可用（100K 自动介入、压缩前接管、20K 工具投影）。");
	lines.push(
		"  · 装完写进 step 配置的 packages，之后每次启动会自动校验并更新。",
	);
	if (state.projectStamps > 0) {
		lines.push("");
		lines.push(
			`注意：项目内已有 ${state.projectStamps} 个归档文件，说明扩展此前运行过；登记信息可能只是被移除。`,
		);
	}
	return lines.join("\n");
}

/** 工具的 JSON Schema（纯 JSON，不依赖 typebox） */
export const TOOL_SCHEMA = {
	name: "context_archive_status",
	description:
		"查询 context-archive 上下文归档压缩的安装状态。若未检测到代码版登记，" +
		"本工具会返回让功能真正生效所需的 `step install` 命令（声明式/市场副本不装载命令与技能）。",
	inputSchema: {
		type: "object",
		properties: {},
	},
};
