# context-archive

Step Code（宿主 extension + skill）插件：瀑布式上下文压缩——算法去重→三点摘要，stamp 归档与召回，有界工具投影。

## 一条命令装上完整功能

```bash
step install https://github.com/uos1231234/step-context-archive
```

装完即生效：`turn_end` / `session_before_compact` / `tool_result` 三个事件钩子照常工作，
长会话到 100K 自动介入、压缩前接管归档、20K 工具结果有界投影全部启用。
装完写进 `~/.stepcode/config.toml` 的 `packages`，**以后每次启动自动校验并更新**。
（`step list` 查看、`step update --extensions` 更新、`step remove` 卸载。）

> **为什么是 `step install` 而不是 `/plugin marketplace`？**
> 截至 Step Code v0.1.1，内置市场**只做分发、不装载**——
> `packages/coding-agent/src/step/plugins.ts` 原文：*"Executable plugin entries are recorded but not loaded
> by the Step marketplace facade."* 装完市场插件后，清单里的 `commands/` 与 `skills/` 不会变成斜杠命令或技能。
> 而 `step install` 走的是官方包管理器
> （`docs/packages.md`），产物经 `resource-loader` 真正加载，事件钩子可用。
> 详见下方「安装（四条路径）」；从市场安装时的用户引导见「市场副本的用户引导」。

<details>
<summary>已收录进第三方插件市场（协议副本，非功能通道）</summary>

[Neriah-Ado/stepcode-plugins](https://github.com/Neriah-Ado/stepcode-plugins)（PR #1 已于 2026-09-27 合并）。
市场里那份是**声明式协议副本**（清单 + 命令文本 + 技能提示词），与本仓库的**代码版扩展**是同一设计的两份实现，
共享同一套 `#STAMP` 索引格式与三点摘要协议。在该市场安装**不会**让 `/archive` 出现，原因见上。

</details>

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
   项目内 `.stepcode/context-archive/stamp-<id>.md` → `dedupChunk` 去重 → 去重后仍 >800 token 的块
   并行走三点摘要（单块失败降级为首行，整体不 throw）→ 返回 `{compaction:{summary}}`，
   summary = 协议头 + 每块一行 `#STAMP <id> → <项目相对路径> — <摘要>`。
   归档**不覆盖同名文件**：内容相同幂等跳过，内容不同则拒绝写入且该块不发索引行
   （宁可只剩摘要，也不给出指向错内容的指针）。
   每次归档后重写 `.stepcode/context-archive/INDEX.md` 磁盘索引；**即使压缩被宿主中止
   （`signal.aborted`），原文与索引仍会落盘，只是不接管摘要**——保证「压缩前归档原文」
   这个承诺在任何路径下都不破。
3. **tool_result**：超 20K token 的工具结果先归档全文再投影截断（归档失败则不投影，
   原文保留在会话里）。

## 验证记录（真实项目，非玩具仓库）

两个真实项目在 **Step Code + step-3.7-flash** 下跑通「长会话 → 压缩接管 → 归档 → 按 stamp 取回早期事实」全链路。
测试均在 deepswe-eval 的**副本**上进行，未改动原 fixture。

| | 项目 1：Atlas Sync 长程任务 | 项目 2：Effect HttpApi SSE |
|---|---|---|
| 目标 | deepswe-eval `agent-shell-long-horizon` | deepswe-eval `repos/effect-sse-httpapi-streaming`（Effect-TS/effect 的一部分，**2240 文件** TS monorepo） |
| 性质 | 长程基准（跨多阶段的真实开发任务） | 真实工程 feature 请求（响应端 + 请求端 SSE、编解码器、客户端、文档、测试） |
| 归档产出 | **7 块 / 1067 KB 原文** | **165 块 / 1032.2 KB 原文** |
| 索引 ↔ 原文一致性 | ✅ 抽查确认全部为块原文 | ✅ **0 缺失、0 字节数不符、0 预览与原文首行不符，165/165 为块原文** |
| 摘要与原文冲突 | 未发现 | 未发现 |
| 召回取回细节 | ✅ 不再读文件，答出 30 个文件之前埋设的早期事实 | ✅ 只读 `INDEX.md` → `recall_by_stamp` 取回 → 答出 **33 个文件的完整清单** |
| 宿主确认 | CompactionEntry `fromHook: true`、`tokensBefore: 228691` | 该次压缩被宿主中止，靠**磁盘索引**兜底完成召回 |

项目 2 还顺带验证了一件事：模型自装依赖、真实改动 7 个文件、3 个测试全部通过——
**插件与真实工程工作可以共存，不构成干扰。**

### 过程中修掉的三个真问题

1. **异步钩子在压缩被中止时不被等待** → `await writeStamp` 全量丢失（369 条 entries、0 归档）→ 改同步写盘。
2. **会话并发拆卸会让 `ctx.getContextUsage()` 抛异常**，若无 `try/catch` 会**静默吞掉后续全部逻辑**，表现只是"诊断行打了一行、后面什么都没发生"。
3. 因此把**不依赖 `ctx` 的同步归档整体前置**到任何 ctx / 模型调用之前；模型摘要阶段单独 `try/catch`，
   失败只影响摘要、不会影响已落盘的归档。`INDEX.md` 磁盘索引即为此设——压缩被中止、`#STAMP` 没进会话时，
   原文与可召回清单都还在盘上。

## 安装（四条路径，第 1 条推荐、第 4 条为无头实测）

1. **`step install`（推荐，官方包管理器，已实测）**：
   ```
   step install https://github.com/uos1231234/step-context-archive
   ```
   宿主会 clone 仓库、读 `package.json` 的 `pi` 清单、把扩展登记进
   `~/.stepcode/config.toml` 的 `packages`，并在会话启动时经 resource-loader
   **真正加载**——`pi.on(...)` 事件钩子照常工作。相关命令：`step list` / `step update` / `step remove`。
   （依赖 `package.json` 的 `pi.extensions` + `pi.skills` 字段；安装时 `npm install --omit=dev`，不拉 devDependencies。）
2. **复制安装**（官方发现目录，最直接；**两个 TS 文件缺一不可**）：
   - `src/` 整目录 → `~/.stepcode/agent/extensions/context-archive/{index.ts, pipeline.ts}`
     （发现规则认子目录 `index.ts`；`import "./pipeline.js"` 指同目录文件，
     **只复制 index.ts 会加载失败**）
   - `skills/context-archive/` → `~/.stepcode/agent/skills/context-archive/`
   - 应用内 `/reload` 热载。
3. **settings.json 引用**：
   ```json
   { "extensions": ["/path/to/repo/src/index.ts"], "skills": ["/path/to/repo/skills/context-archive"] }
   ```
4. **临时加载（已无头实测 exit 0）**：
   `step -e ./src/index.ts -ne --skill ./skills/context-archive -p "..."`
   —— **`-ne` 必须带**（禁用发现目录、显式 `-e` 仍生效）：否则 `-e` 与已安装副本会
   重复装载同一扩展（实测同一会话 `activate` 执行 4 次）。

项目级放置：`.stepcode/extensions/*.ts`（项目需先信任）、`.stepcode/skills/`。

关于 marketplace 与 `step install` 的关系（如实说明）：

- **两条通道是并存的，能力不同**。`step install` 走官方包管理器
  （`DefaultPackageManager`），装完的扩展由 `resource-loader` **真正加载**，
  事件钩子可用；`/plugin marketplace add` 走市场门面，**只分发不装载**
  （`plugins.ts` 原文：*"Executable plugin entries are recorded but not loaded
  by the Step marketplace facade."*）。**要自动触发请走 `step install`。**
- `/plugin marketplace add`、`/plugin install`、`/reload` 是 **TUI 交互命令，
  `step -p` 无头模式下不会执行**（实测：本地市场目录未创建、`~/.stepcode/plugins`
  无新插件）——最终安装须在交互界面完成；无头验证只用路径 4。
- 市场那份**只交付文件**，不装进扩展通道：`step.plugin.json` 不含 `entry`，
  宿主不会经 marketplace 装载本扩展的 TS 入口（面向 `mcpServers`/`provision` 声明）。
- 双 marketplace 声明（`.step-plugin` 与 `.claude-plugin` 同内容）的 `source` 为
  `"."`（仓库根即插件源，**不是**缺省规则 `plugins/<name>`）。

## 市场副本的用户引导（`step.plugin.json` 的 `description`）

市场安装只交付文件，**没有任何东西会在运行时告诉用户"你装的是壳"**。
本仓库因此把启用指引直接写进插件清单的 `description`——宿主在
`step/plugins.ts:1445-1446` 会把 `description` 交给 `/plugin browse`、`/plugin list`
与安装诊断渲染，**这是 v0.1.1 上唯一确定能触达用户的通道**（不依赖 cwd、不依赖 MCP）：

> 瀑布式上下文压缩（extension）：100K 自动介入、压缩前归档原文、20K 工具投影。
> 注意：市场安装只交付文件，不装载 commands/skills；
> 启用完整功能请运行 `step install https://github.com/uos1231234/step-context-archive`

**曾尝试过内联 `mcpServers` 提示服务，已移除。** 原因（源码定论）：
`step/mcp.ts:238-241` 构造 `DiscoveredServer` 时**不注入插件目录作为 `cwd`**，
`:297-303` 的 `StdioClientTransport` 里 `cwd` **只来自声明自身**且 `normalizeDeclaration`
**不做变量展开**。于是清单里 `args: ["server/index.mjs"]` 这类相对路径会相对
**用户项目的 cwd** 解析，而非插件目录 → 插件自带的 MCP server 永远起不来。
清单的 `cwd` 字段也救不了：只能写绝对路径，不可分发。
（该缺陷对任何用相对 `args` 的插件 MCP server 一视同仁。）

## 使用

- `/context-archive` —— 打印归档目录（新旧两处）、文件数、上次接管时间、当前 usage、CONFIG。
- `/recall-stamp <stamp>` —— 按 stamp 读回归档原文（stdout 输出）。
- `recall_by_stamp` 工具 —— 模型侧按 stamp 召回。
- `.stepcode/context-archive/INDEX.md` —— **磁盘召回索引**（自动生成）：列出所有可召回块的
  stamp、相对路径、字节数与原文首行。压缩被中止、`#STAMP` 没进会话时，靠它仍能查到可召回什么。
- stderr 诊断行：
  - `[context-archive] usage=… window=… enter=… percent=… decision=…`（阈值判定）
  - `[context-archive] session_before_compact reason=… preparation=… aborted=… entries=…`（接管入口）
  - `[context-archive] session_compact_failed reason=… aborted=… fromExtension=…`（压缩失败/被中止，如实报告不假装成功）

## 配置

模块顶部 `export const CONFIG`（`src/index.ts` 顶部常量区）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enterTokens` | `null` | **绝对介入线覆盖**；`null` = 按当前模型的上下文窗口自适应（默认行为） |
| `enterPercent` | `0.25` | 自适应比例：窗口的百分之多少开始介入 |
| `enterFloor` | `100_000` | 自适应的绝对下限，防止小窗口下过早介入 |
| `foldPercent` | 80 | 实际占用达到窗口的这个百分比才发起压缩摘要（镜像 `THRESHOLDS`） |
| `projectionMax` | 20_000 | 工具投影上限，改 `CONFIG.projectionMax` 这一行 |
| `summarizeMinTokens` | 800 | 触发模型摘要的最小块，改 `CONFIG.summarizeMinTokens` 这一行 |

**介入线按模型窗口自适应**（`pipeline.ts` 的 `effectiveEnterTokens`）：
`生效线 = max(enterFloor, contextWindow × enterPercent)`，宿主未给 `contextWindow` 时退化为 `enterFloor`（行为不因缺信息漂移）。

| 模型窗口 | 生效介入线 | 说明 |
| --- | --- | --- |
| 128K / 200K / **256K**（step-3.7-flash） | **100K** | 25% 低于下限，被兜到 100K——与 0.2.0 之前行为**完全一致** |
| **1M**（step-5-preview） | **250K** | 修正旧版固定 100K 只用 10% 窗口就压缩的浪费 |
| 未知 | 100K | 退化为下限 |

`/context-archive` 面板会显示**本会话实际生效的介入线 + 依据的窗口**，便于换模型后确认。
`turn_end` 的 stderr 诊断行也带上 `window=` 与 `enter=`。

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

[AGPL-3.0-only](LICENSE) © 2026 uos1231234

- **自 v0.6.0 起由 MIT 改为 AGPL-3.0-only**，与所属插件市场的集合许可保持一致，
  避免用户看到同一设计的两份实现却挂着不同许可而产生困惑。
- 更早的版本（≤ v0.5.2）以 MIT 发布；那些版本的内容**继续按 MIT**，
  MIT 允许著作权人后续另行许可，故不构成追溯冲突。
- AGPL 的关键条款是 **§13 Remote Network Interaction**：把本程序改成网络服务对外提供时，
  必须向使用者提供你的修改源码。修改与分发本程序时，同样需保持本许可并公开你的改动。
- 完整条款见 [LICENSE](LICENSE)（GNU AGPL v3 官方原文，未作任何改动）。

## 与市场副本的关系

同一个设计的两份实现，**同一份 AGPL-3.0-only 许可**：

| | 本仓库（代码版） | [Neriah-Ado/stepcode-plugins](https://github.com/Neriah-Ado/stepcode-plugins)（声明式副本） |
| --- | --- | --- |
| 形态 | TypeScript 扩展（`src/index.ts` + `src/pipeline.ts`，776 行） | `step.plugin.json` + `commands/*.md` + `skills/*/SKILL.md` |
| 装载通道 | `~/.stepcode/agent/extensions/`、settings.json、`step -e`（**这条路现在可用**） | `/plugin marketplace add` + `/plugin install`（**装得上但宿主暂不装载**） |
| 自动触发 | 有：100K 介入线 + 压缩前接管 + 20K 有界投影 | 无：靠模型自觉执行 |
| 协议 | `#STAMP` 索引行 = **项目相对路径** + 三点摘要「目标 / 关键决策 / 是否完成」+ 承认 `b` 前缀退化 id + 同名文件不覆盖 | 同左（以市场协议为准，本仓库已对齐） |
| 状态 | v0.6.0，AGPL-3.0-only | v1.0.0，in-progress（[PR #1](https://github.com/Neriah-Ado/stepcode-plugins/pull/1) 已合并；`SCA-100-4` 真实项目验证已完成，已汇报待维护者回写） |

选哪份：**想要自动压缩用本仓库**（走安装三条路径）；想要“一键装进 Step Code 会话”用市场副本，
但需等宿主开放插件装载通道。两者共享同一套 `#STAMP` 索引格式与三点摘要协议，
归档都落在项目内 `.stepcode/context-archive/`，可分别独立使用。
