# context-archive

Step Code（宿主 extension + skill）插件：瀑布式上下文压缩——算法去重→三点摘要，stamp 归档与召回，有界工具投影。

## 工作原理

```
100K 介入线（THRESHOLDS.enterTokens = 100_000）
   └─ 80% 门限（THRESHOLDS.foldPercent = 80）→ decision=summarize → 主动 ctx.compact
900K 级兜底：宿主强制压缩，真实公式 contextTokens > contextWindow - reserveTokens
   （reserveTokens 默认 16384；出处 coding-agent/docs/compaction.md:32、
     src/core/compaction/branch-summarization.ts:305）
```

三个钩子（算法全部在 `src/pipeline.ts`，`src/index.ts` 只接线）：

1. **turn_end**：读 `ctx.getContextUsage()`，`decideFold` 判定后向 stderr 打一行
   诊断；判 `summarize` 时带自定义指令发起 `ctx.compact`（模块级 inFlight 防重入）。
   此钩子只观察，不直接改会话。
2. **session_before_compact**（核心接管）：`semanticChunks` 切块 → 每块**原文**写入
   `archiveDir` 下的 `stamp-<id>.md` → `dedupChunk` 去重 → 去重后仍 >800 token 的块
   并行走三点摘要（单块失败降级为首行，整体不 throw）→ 返回 `{compaction:{summary}}`，
   summary = 协议头 + 每块一行 `#STAMP <id> → <路径> — <摘要>`。
3. **tool_result**：超 20K token 的工具结果先归档全文再投影截断（归档失败则不投影，
   原文保留在会话里）。

## 安装（三条路径，第 3 条为无头实测）

1. **复制安装**（官方发现目录，最直接；**两个 TS 文件缺一不可**）：
   - `src/` 整目录 → `~/.stepcode/agent/extensions/context-archive/{index.ts, pipeline.ts}`
     （发现规则认子目录 `index.ts`；`import "./pipeline.js"` 指同目录文件，
     **只复制 index.ts 会加载失败**）
   - `skills/context-archive/` → `~/.stepcode/agent/skills/context-archive/`
   - 应用内 `/reload` 热载。
2. **settings.json 引用**：
   ```json
   { "extensions": ["/path/to/repo/src/index.ts"], "skills": ["/path/to/repo/skills/context-archive"] }
   ```
3. **临时加载（已无头实测 exit 0）**：
   `step -e ./src/index.ts -ne --skill ./skills/context-archive -p "..."`
   —— **`-ne` 必须带**（禁用发现目录、显式 `-e` 仍生效）：否则 `-e` 与已安装副本会
   重复装载同一扩展（实测同一会话 `activate` 执行 4 次）。

项目级放置：`.stepcode/extensions/*.ts`（项目需先信任）、`.stepcode/skills/`。

关于 marketplace（如实说明）：

- `/plugin marketplace add`、`/plugin install`、`/reload` 是 **TUI 交互命令，
  `step -p` 无头模式下不会执行**（实测：本地市场目录未创建、`~/.stepcode/plugins`
  无新插件）——最终安装须在交互界面完成；无头验证只用路径 3。
- 即使经 marketplace 安装成功，`step.plugin.json` 不含 `entry`，宿主当前也**不会**
  经 marketplace 装载本扩展的 TS 入口（面向 `mcpServers`/`provision` 声明）——
  真实装载链就是路径 1/2 的 extension 发现目录。
- 双 marketplace 声明（`.step-plugin` 与 `.claude-plugin` 同内容）的 `source` 为
  `"."`（仓库根即插件源，**不是**缺省规则 `plugins/<name>`）。

## 使用

- `/context-archive` —— 打印归档目录、文件数、上次接管时间、当前 usage、CONFIG。
- `/recall-stamp <stamp>` —— 按 stamp 读回归档原文（stdout 输出）。
- `recall_by_stamp` 工具 —— 模型侧按 stamp 召回。
- stderr 诊断行：`[context-archive] usage=... decision=...`（非 UI 消息）。

## 配置

模块顶部 `export const CONFIG`（`src/index.ts` 顶部常量区）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enterTokens` / `foldPercent` | 100_000 / 80 | 镜像 `pipeline.ts` 的 `THRESHOLDS`，判定实际发生在 `decideFold` 内；要改请改 `src/pipeline.ts` 的 `THRESHOLDS` |
| `projectionMax` | 20_000 | 工具投影上限，改 `CONFIG.projectionMax` 这一行 |
| `summarizeMinTokens` | 800 | 触发模型摘要的最小块，改 `CONFIG.summarizeMinTokens` 这一行 |

未选用 `pi.registerFlag`：该 API 仅支持 `boolean | string`
（`src/core/extensions/types.ts:1382-1395`），且阈值判定封装在 `decideFold` 内、
无法注入，做成 flag 会给出“可覆盖”的假象，故退化为模块常量。

## 与上游对齐（宿主 API 出处）

- `pi.on("turn_end")` + `ctx.getContextUsage()` —— `examples/extensions/trigger-compact.ts`、`docs/extensions.md:601/1066`、`src/core/extensions/types.ts:332/386/1335`
- `pi.on("session_before_compact")` 返回 `{compaction:{summary,firstKeptEntryId,tokensBefore}}` —— `examples/extensions/custom-compaction.ts:21-116`、`types.ts:640-650/1217-1220`
- `pi.on("tool_result")` 返回 `{content}` 改写工具结果 —— `types.ts:1002-1010/1190-1195`、应用点 `src/core/agent-session.ts:533-563`
- `ctx.compact({customInstructions,onComplete,onError})` 单签名 —— `types.ts:340-344/388`、`docs/extensions.md:1077-1091`
- `ctx.modelRegistry.complete(model,{systemPrompt,messages},{signal,maxTokens})` —— `examples/extensions/qna.ts:86-90`、`custom-compaction.ts:79-88`；`messages.content` 允许 `string | 块数组`（`packages/providers/src/types.ts:358-362`）
- `pi.registerTool({name,label,description,parameters,execute})` —— `types.ts:497-546`、`examples/extensions/dynamic-tools.ts`；`parameters` 用纯 JSON Schema（TypeBox 产物即 JSON Schema），不 import `typebox`
- `pi.registerCommand(name,{description,handler(args,ctx)})` —— `types.ts:1275-1281/1370`、`examples/extensions/trigger-compact.ts:43-49`
- agentDir：`process.env.STEP_CODING_AGENT_DIR || ~/.stepcode/agent` —— `src/config.ts:197/208-215`
- 发现目录与 settings 键 —— `docs/extensions.md:109-135`、`docs/skills.md:20-42`（SKILL frontmatter 必填 `name`+`description`）

## 目录

`src/index.ts`（接线）、`src/pipeline.ts`（算法，另建）、`skills/context-archive/`、
`step.plugin.json`、`.step-plugin/marketplace.json`、`.claude-plugin/marketplace.json`、
`README.md`、`LICENSE`、`.gitignore`。

## 许可

本项目采用 **agent-shell License v1.0**，全文见 [LICENSE](LICENSE)——基于
[PolyForm Small Business License 1.0.0](https://polyformproject.org/licenses/small-business/1.0.0)
修改而来（改动：小型企业门槛改为 45 人 / 上年营收 2,000 万人民币，并新增商用许可条款）。

- **个人与非商业用途**（个人、社区、教育、研究）：免费。
- **公司**：同时满足「总人数少于 45 人（含雇员与外包）」且「上一纳税年度总营收不超过
  2,000 万人民币」时免费。
- **超出上述规模的商业使用**：须先与作者商定商业许可，联系 2424105750@qq.com。
- **署名要求**：向他人分发本软件时，必须一并传递本许可条款（或指向它的 URL），以及
  `Required Notice:` 署名行。

Required Notice: Copyright (c) 2026 uos1231234
(https://github.com/uos1231234/step-context-archive)

本许可文本与 agent-shell 项目共用同一份 `agent-shell License v1.0`（出处
https://github.com/uos1231234/agent-shell）；上面的版权声明与署名行按本项目填写。
