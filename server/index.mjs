#!/usr/bin/env node
/**
 * context-archive 安装提示服务 —— stdio JSON-RPC 接线层（零依赖，协议与
 * @modelcontextprotocol/sdk 兼容）。全部判定逻辑在 ./lib.mjs。
 *
 * 为什么需要它：宿主 v0.1.1 的插件市场只做分发、不装载（清单 entry 仅记录不加载），
 * 已安装插件的 commands/ 与 skills/ 不会注册。**内联 mcpServers 是市场插件唯一
 * 能在运行时触达模型的通道**，所以用一个小工具回答"装上了没有、没装该怎么装"，
 * 把用户引导到真正可用的 `step install` 通道。
 *
 * 诊断信息：安装/卸载含 MCP 的插件后需重启 Step Code，用 /mcp 查看加载结果。
 */
import { createInterface } from "node:readline";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import {
	countStamps,
	findRegisteredSources,
	projectArchiveDir,
	renderStatus,
	TOOL_SCHEMA,
	VERSION,
} from "./lib.mjs";

const SERVER_INFO = { name: "context-archive-status", version: VERSION };

/** 宿主 agent 目录：STEP_CODING_AGENT_DIR 优先，缺省 ~/.stepcode/agent（对齐 config.ts:197/208-215） */
function agentDir() {
	const env = process.env.STEP_CODING_AGENT_DIR?.trim();
	if (!env) return join(homedir(), ".stepcode", "agent");
	return env.startsWith("~/") ? join(homedir(), env.slice(2)) : env;
}

/**
 * 候选配置文件。宿主把 step 配置写在 agentDir 的**父目录**（config.toml），
 * 但 packages.md 写的是 agentDir/settings.json —— 两种都读，兼容两种实现。
 */
function configPaths() {
	const dir = agentDir();
	const cwd = process.cwd();
	return [
		join(resolve(dir), "..", "config.toml"),
		join(dir, "settings.json"),
		join(cwd, ".stepcode", "config.toml"),
		join(cwd, ".stepcode", "settings.json"),
	];
}

function buildState() {
	return {
		version: VERSION,
		registeredSources: findRegisteredSources(configPaths(), (p) => readFileSync(p, "utf8")),
		projectStamps: countStamps(readdirSync, projectArchiveDir(process.cwd())),
		legacyStamps: countStamps(readdirSync, join(agentDir(), "context-archive")),
	};
}

function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
	send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
	send({ jsonrpc: "2.0", id, error: { code, message } });
}

/** MCP 工具调用的结果统一用 content 数组承载文本 */
function toolResult(text) {
	return { content: [{ type: "text", text }] };
}

function handle(message) {
	const { id, method, params } = message ?? {};

	switch (method) {
		case "initialize":
			return reply(id, {
				protocolVersion: "2025-06-18",
				capabilities: { tools: {} },
				serverInfo: SERVER_INFO,
			});

		case "notifications/initialized":
		case "notifications/cancelled":
			return; // 通知无响应

		case "ping":
			return reply(id, {});

		case "tools/list":
			return reply(id, { tools: [TOOL_SCHEMA] });

		case "tools/call": {
			// 本工具无参数；仍按 MCP 规范回 isError 而不是抛协议错误
			try {
				const state = buildState();
				return reply(id, toolResult(renderStatus(state)));
			} catch (error) {
				return reply(id, {
					...toolResult(`诊断失败：${error instanceof Error ? error.message : String(error)}`),
					isError: true,
				});
			}
		}

		default:
			if (id === undefined || id === null) return; // 未知通知
			return replyError(id, -32601, `Method not found: ${method}`);
	}
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
	const trimmed = line.trim();
	if (!trimmed) return;
	let message;
	try {
		message = JSON.parse(trimmed);
	} catch {
		return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
	}
	try {
		handle(message);
	} catch (error) {
		replyError(
			message?.id ?? null,
			-32603,
			error instanceof Error ? error.message : String(error),
		);
	}
});

export { handle, buildState, configPaths, agentDir };
