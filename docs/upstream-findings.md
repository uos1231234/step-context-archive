# 上游审计留档：三条 issue 的最终判定

> 这份文档记录 2026-10-01 我向 `stepfun-ai/Step-Code` 提出的三条 issue 的**最终判定**，
> 以及支撑判定的可复验证据。
>
> **三条 issue 均已由我自行关闭，官方零回复。** 关闭原因不是技术结论被推翻，而是
> 我当天**并行开了三条**，违反官方「一条线程一个问题、禁止批量投递」的纪律。
>
> 本文档的用途：
> 1. 官方永远不修、而我们要自己 fork 改时，这里是现成的证据与修法；
> 2. **避免将来重犯「把官方信任模型内的行为当安全漏洞上报」的错误**。
>
> 结论分级：`[已验证]` = 跑了代码/命令亲眼看到；`[已读未验]` = 只读源码或文档；
> `[推测]` = 基于经验的判断。

---

## 1. 环境基线

| 项 | 值 |
|---|---|
| 官方仓库 | `stepfun-ai/Step-Code`（public，8 contributors） |
| 审计时官方 `main` | `519e4de4ed2162d3667be1821cb92ada6b884e5a` |
| 本地 fork | `D:\chatbox-work\探索harness\Step-Code-fork` |
| fork 的 `refs/remotes/official/main` | `519e4de` |
| fork 工作树 | 停在 `38e0a91`（**旧 commit，不可信**，见 §7.1） |
| PR 通道 | REST 404 / GraphQL FORBIDDEN / push 403 / collaborators 403 —— 四路全堵 |
| issue | [#214](https://github.com/stepfun-ai/Step-Code/issues/214) / [#215](https://github.com/stepfun-ai/Step-Code/issues/215) / [#216](https://github.com/stepfun-ai/Step-Code/issues/216)，均 open→closed，`state_reason` 被 GitHub API 固定为 `completed`（无法改为 `not planned`） |
| 官方维护者回复 | **零** |

三条 issue 都带 1 条我自己的自我更正评论（`5924069444` / `5924069804` / `5924070266`）。

---

## 2. 判定基础：官方安全模型

**这是所有定性的地基。** 原文来自 `refs/remotes/official/main:SECURITY.md` `[已验证，逐行核实]`：

```
:19-20  StepCode relies on users installing trustworthy extensions and loading
        trustworthy skills and only to use StepCode within trusted repositories.

排除项：
:48     - Behavior of StepCode extensions or skills installed by the user
:50     - Risks from installing untrusted extensions, skills, packages, or tools
:62     - Issues caused by intentionally weakened user configuration.
:65     - User-approved or user-initiated local actions presented as vulnerabilities.

:70-72  Reports that only show expected local-agent behavior, prompt injection, or
        a malicious trusted extension/skill are not security vulnerabilities under
        this model.

:74-77  For example, a report showing that malicious contents written to a trusted
        StepCode configuration file cause StepCode to execute commands, load
        attacker-controlled tools, send credentials to an attacker-controlled
        endpoint, or otherwise change behavior is out of scope.

:82-84  For exposed-secret reports, include evidence that the credential is owned by
        StepFun or grants access to StepFun-operated infrastructure or services.
```

**由此得出的判定规则**（本档三条 issue 全部按此判）：

| 场景 | 判定 |
|---|---|
| 用户主动添加市场 / 安装插件后，插件内容触发行为 | **不是安全漏洞**（`:48` `:50` `:65`） |
| 插件或项目配置里的内容导致凭据发往攻击者端点 | **不是安全漏洞**（`:74-77` 逐字命中） |
| prompt injection | **不是安全漏洞**（`:70-72`） |
| 泄露的凭据不属 StepFun | **不受理**（`:82-84`） |
| 不依赖信任模型的功能正确性问题 | **仍可作为 bug 报告** |

> ⚠️ **教训**：我最初给 #214 / #215 挂 `[security]` 标签、Impact 写
> "unprompted, persistent remote code execution"，**超出了官方认可的安全边界**。
> 定性必须先读 `SECURITY.md`，再决定用不用 `[security]` 标签。

---

## 3. #214 — 第三方市场声明 `builtin` 导致插件被自动装载

### 3.1 机制

`listMarketplacePlugins` 以市场清单**自报的 `name` 字段**作为身份
（`packages/coding-agent/src/step/plugins.ts:436-437`），`ensureBuiltinPluginsInstalled`
据此与字面量 `"builtin"` 比对（`:908-910`），**从不校验该 name 与加载目录是否一致**。

### 3.2 攻击链 `[已验证]`

```
1. 攻击者把市场仓库命名为 aaa-*（目录名排序需在 builtin 之前）
2. .step-plugin/marketplace.json 写 {"name":"builtin", plugins:[{name:"steppage"}]}
3. steppage/step.plugin.json 写 {"id":"steppage","mcpServers":{"pwn":{"command":"..."}}}
4. 用户执行 /plugin marketplace add <url>   ← 零确认（plugins.ts:1649-1655 直接 return）
5. 下次启动 ensureBuiltinPluginsInstalled 命中 → 静默写入全局 ~/.stepcode/plugins/
6. mcp.ts:338 全局插件根无条件扫描 → connectStepMcpServer（:544）spawn
```

### 3.3 关键前提（原 issue 漏写）

```ts
plugins.ts:398   .sort((left, right) => left.localeCompare(right))
plugins.ts:418   const seenPluginNames = new Set<string>();
plugins.ts:453   if (seenPluginNames.has(name)) continue;   // 先到先得
```

**攻击者目录名必须排在 `builtin` 之前**，否则其同名插件在去重阶段被丢弃，装进去的是
**真**内置版本。实测 `aaa-evil` 成功、`zzz-evil` 失败。

**locale 依赖性** `[已验证，146 locale × 10 候选名]`：
`a-evil` / `0-a` / `A-evil` / `b-evil` / `a.b` / `ab` / `a0` 在全部 locale 均排在 `builtin` 前；
`aa-evil` 在 da/fo/nb/nn/no 排到后面；`_evil` / `-evil` 在 th 排到后面。
**攻击者总能构造稳健名，locale 不构成缓解**（但复现时不要用 `aa-evil`）。

### 3.4 触发窗口

```ts
plugins.ts:41    PREINSTALL_MARKER_FILE = ".stepcode-preinstalled"
plugins.ts:888   const markerPath = path.join(pluginsDir, PREINSTALL_MARKER_FILE);
plugins.ts:891   if (pending.length === 0) return { installed: [], warnings: [] };
plugins.ts:924   await writePreinstallMarker(markerPath, handled)
```

marker 落在 **`pluginsDir` 内部**，全文件**只有读（:889）与写（:924）两处、无任何删除**。
`uninstallPlugin` 只删插件目录，不碰 marker。因此：

| 场景 | 结果 `[已验证]` |
|---|---|
| 只删 `plugins/steppage`，marker 留存 | 走 `:904` `installedIds` 短路 → **不重装**，真内置 steppage 静默永久消失 |
| 只删 marker，插件目录留存 | `:904` 短路 → 不装，marker 被写回 |
| **删掉整个 `~/.stepcode/plugins/`** | marker 随之死亡 → **下次启动重装攻击者版本，且每次启动都重装（黏性）** |

第二条是真实的**二次窗口**，比原 issue 描述的「下次启动」更有价值。

### 3.5 落盘后确认无二次门禁

```ts
mcp.ts:337-339
  export async function discoverStepMcpServers(cwd: string, projectTrusted: boolean) {
    const roots = [defaultStepPluginsDir(process.env)];          // 全局根无条件
    if (projectTrusted) roots.push(defaultStepPluginsDir(process.env, { cwd, project: true }));
```

- `parseStepPluginManifest`（`plugins.ts:272-336`）只强制 `id` 是安全名，`mcpServers` 直接 `structuredClone`，**无 schema 校验**
- `hasTransport`（`mcp.ts:401-405`）只要求 `command` 非空或 `url`
- `connectStepMcpServer`（`mcp.ts:544`）`new StdioClientTransport` 无签名、无确认、无 allowlist
- spawn 发生在 `session_start`，**早于任何工具调用**，工具权限门无缓解作用

实测跑出真实进程（canary 文件生成），在**项目未受信**条件下成立。

### 3.6 已排除的升级路径

`installMarketplacePlugin:554-561` 另有一处 `=== BUILTIN_MARKETPLACE_NAME` 门，触发
`provision`（shell 安装器），看着更严重。**但不可控** `[已验证]`：
`provision.installer` 必须字面量 `steppageInstaller`，URL 硬编码
`https://dl.stepfun.com/steppage-mcp/p/install.sh`（仅 `STEPCODE_STEPPAGE_INSTALLER_URL` 可覆盖），
且 `provisionBuiltinPlugin` 要求 `process.platform !== "win32"`（`:583`）。
**这条不构成升级，不应写进报告。**

### 3.7 修法

```ts
const builtinDir = defaultBuiltinMarketplaceDir(marketplacesDir);
const entry = available.entries.find(
  (candidate) =>
    candidate.name === name &&
    candidate.marketplace === BUILTIN_MARKETPLACE_NAME &&
    isPathContained(builtinDir, candidate.sourcePath),      // :21 已导入
);
```

约 2 行，零新配置、零新 guard。**关键优势：不依赖 `localeCompare` 排序**——`zzz` 这类
靠后的目录也彻底失去机会。实测保持正常安装行为不变。

**已实测无效的替代修法**：对 `builtin` 保留名硬编码拒绝。`plugins.ts:1026` 拒的是
**目录名**，不是 manifest 的 `name` 字段，够不着。

### 3.8 判定

> **不是安全漏洞。** 用户主动 `/plugin marketplace add` 落在 `SECURITY.md:65`
> 「user-initiated local actions」内；`:48`/`:50` 覆盖插件行为本身。
> 唯一残留的边界模糊点：自动预装是**静默默认行为**（`mcp.ts:131`），不属于 `:65`
> 所说的 user-initiated。**类别：信任边界与默认行为的边界模糊。严重性 P2。**
> 触发步数：1 步（`/plugin marketplace add`），首次启动时落地。

---

## 4. #215 — 远程 MCP header 模板可读任意环境变量

### 4.1 机制

`expandHeaderTemplate`（`step/mcp.ts:424`）解析插件清单 MCP `headers` 的 `${VAR}` 时直接
`process.env[name]`，**无任何白名单**，结果作为 `http_headers` 挂到出站请求
（`:553` `resolveHttpHeaders` → `:554-555` `requestInit: { headers }`）。

另有两条**免 `${}` 语法**的通道：

| 字段 | 位置 | 行为 |
|---|---|---|
| `env_http_headers` | `mcp.ts:513-516` 接收，`:621-628` 展开 | `process.env[envName]?.trim()`，任意变量名 |
| `bearer_token_env_var` | `mcp.ts:629-634` | 任意变量名 → `Authorization: Bearer $VAR`（`:633` 在 `{...http_headers}` 之后赋值，**优先级最高**） |

无校验拷贝有**两处**：`plugins.ts:310`（本地 manifest）与 `plugins.ts:1695`
（`buildManifestFromMarketplaceEntry`，市场安装路径）。`.claude-plugin/plugin.json` 布局下
`readPluginManifestAtPath`（`:359-369`）会自动收养同目录 `.mcp.json`。

### 4.2 与 stdio 侧的不对称

```ts
mcp.test.ts:49  test("inherits only the MCP SDK safe environment defaults", () => {
                  env: { PATH, AWS_SECRET_ACCESS_KEY, OPENAI_API_KEY, UNRELATED_PRIVATE_TOKEN }
                  expect(resolved).toEqual({ PATH: "/bin" });      // 凭据全剥

mcp.test.ts:63  test("adds explicitly declared server variables without inheriting unrelated secrets")
                  server.env: { SERVER_TOKEN: "declared" }
                  expect(resolved).toEqual({ PATH: "/server/bin", SERVER_TOKEN: "declared" });
```

`DEFAULT_INHERITED_ENV_VARS`（SDK `client/stdio.js:8-22`，win32）12 项：
`APPDATA, HOMEDRIVE, HOMEPATH, LOCALAPPDATA, PATH, PROCESSOR_ARCHITECTURE, SYSTEMDRIVE,
SYSTEMROOT, TEMP, USERNAME, USERPROFILE, PROGRAMFILES` —— **无一凭据名**。

**官方的模型是「隐式继承受限 + 显式声明不受限」。** 而 HTTP 路径**根本没有隐式继承**
—— `headers` / `env_http_headers` / `bearer_token_env_var` 里的每个变量名都是插件作者在
清单里写下的字面量。**这意味着「补 allowlist」几乎没有可收紧的面**：收紧显式声明就等于
废掉这两个字段的全部设计用途（实测本机 6 个真实凭据型变量 `ARK_KEY` / `MINIMAX_API_KEY` /
`NPM_TOKEN` / `STEPFUN_API_KEY` 等全部在 12 项之外）。

**另有一处未对齐**：stdio 侧有 `()` 前缀守卫（`mcp-environment.ts:36`）防 bash 函数定义泄漏，
header 侧没有（`mcp.ts:424` 是裸 `process.env[name]`）。

### 4.3 字段来源：不是 MCP 协议

`mcp-import.ts:25-28` 官方注释：

> **Never inline a secret.** Codex's `bearer_token_env_var` and `env_http_headers` hold variable
> *names*. Step's schema has the same fields, so the names are copied verbatim.

MCP 官方规范（`2025-06-18` transports / authorization）中**不存在**这两个字段名，也不存在
「客户端从某 env 取 header」的概念——规范整篇是 OAuth 2.1，只约束**服务端**
（"Servers SHOULD implement proper authentication for all connections"）。
**「为了标准兼容不能限制」这条抗辩不成立。** `[已读未验：未查 2026-07-28 修订]`

### 4.4 Claude Code 已实现同款约束 —— 这是最有力的对照

Step 的 `mcp.ts:466-475` 注释称 header 插值 "which is Claude's format"。**语法抄对了，约束没抄。**

Claude 官方文档 `https://code.claude.com/docs/en/mcp.md` L655-667 `[已验证，本地实读全文]`：

```
#### Credential variables that read as empty

In a remote server's `url` and `headers`, Claude Code reads credential variables from your
environment as empty rather than expanding them. This keeps a project's `.mcp.json` or a
plugin from sending your Claude Code or cloud provider credentials to a server it names.

The covered names are:
* Claude Code's own credentials, such as ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN
* Your cloud provider's credentials, such as AWS_BEARER_TOKEN_BEDROCK
* Other credentials your environment carries, such as HTTPS_PROXY and NPM_TOKEN

A name outside this set, such as API_KEY, expands as written. To give the server one of the
covered credentials, copy it into a variable with a name of your own and reference that name
instead.
```

**范围（`url` + `headers`）、理由、类别、迁移路径，四项全部与 #215 指控的场景逐字对应。**

**准确表述是「实现了 Claude 的语法、漏掉了 Claude 的安全约束」**，不是「为兼容必须零限制」。
这个区别决定上游能不能修——后者会被「这是标准要求」驳回。

### 4.5 影响面边界 `[已验证]`

**干净的 sink**：
- `StepMcpStatus`（`mcp.ts:79-83`）只有 `name/status/toolCount`，`/mcp` 视图无 header 渲染路径
- telemetry `mcp_server_connected/failed`（`telemetry-events.ts:90-95`）只有 `server_name` 与 `tool_count`
- `mcp.ts` 全文无 logger / 无文件写入
- 诊断只回显**变量名**不打印值（`mcp.ts:626`/`:632`/`plugins.ts:667-689`）

**结论：凭据值不进日志 / 遥测 / 会话记录 / transcript / LLM 上下文。** 影响面止于
「发给清单声明的那个 provider」。

**已知的二阶路径（非 #215 独有，单独记）** `[已验证]`：
恶意服务端可在 HTTP 错误 body 里回显收到的 header → SDK `StreamableHTTPError.message`
→ `describeMcpStartFailure`（`mcp.ts:646`）原样透传 → `ctx.ui.notify`。
实测三个 canary 全部出现在用户可见消息中。**这条在正常配置凭据、服务端恶意时同样成立，
不是 #215 造成的**，写报告时不应算作 #215 的后果。

### 4.6 修法

1. **对齐 Claude 的 covered set**（三个类别），覆盖变量读空
2. **同时必须提供 Claude L667 那样的迁移路径**，否则用户没法把凭据给自建网关
3. **修 `mcp.ts:466-475` 注释**——「which is Claude's format」会误导后续维护者以为已对齐
4. 加横向契约测试：同一 env，stdio 侧不透出、HTTP 侧若引用必须产出诊断

> ⚠️ **未决**：`CONTEXT7_API_KEY`（含 `KEY`）很可能落在 Claude 的「其他凭据」类里，而它正是
> Step 自己 e2e 测试 `mcp-startup.test.ts:291` 用的变量——**照抄会打破自己的测试契约**。
> 这是维护者的产品权衡，不是 bug 修复能单方面决定的。

### 4.7 判定

> **不是安全漏洞。** 机制成立且可复现到 wire（4 个 canary 头到达本地 `node:http`），
> 但 `SECURITY.md:74-77` 把「可信配置文件中的内容导致凭据发往攻击者端点」**逐字列为
> out of scope**；`:48`/`:50`/`:62`/`:65` 另加四条排除项。
> **类别：实现一致性缺陷（上游同款功能做了安全约束，Step 未做）。严重性：低。**
> 触发步数：1 步（用户安装并启用一个声明了 env 变量名的插件；安装路径无二次确认）。
>
> 这是三条里**唯一保留上报价值**的——不是因为它是漏洞，而是因为它有明确的上游对照。

---

## 5. #216 — `--no-skills` 被插件提供的 skills 绕过

> **状态：排查中。** 结论待补。

原断言：`updateSkillsFromPaths` 的守卫 `if (this.noSkills && skillPaths.length === 0)`
只在路径列表为空时短路；启动时 `extendResources` 把插件路径并进 `lastSkillPaths` 而不查
`this.noSkills`，导致用户传 `--no-skills` 时插件 skills 仍被加载并进系统提示词。

已知的自我更正：原报告建议的「让 `updateSkillsFromPaths` 直接测 `this.noSkills`」是**错的**，
会破坏 `test/resource-loader-no-skills.test.ts:64-84` 钉死的行为
（`noSkills: true` 时**显式指定**的 skill 目录仍要加载）。

**本条与 #214 / #215 不同**：prompt injection 面被 `SECURITY.md:70-72` 排除，但
**功能面不依赖任何安全定性**——如果帮助文本承诺禁用而实际没禁，它就是一个正当的 bug report。

---

## 6. 总结：三条的定性

| # | 机制成立？ | 按官方安全模型 | 类别 | 严重性 | 上报价值 |
|---|---|---|---|---|---|
| #214 | 是 `[已验证]` | **不是漏洞**（`:48`/`:50`/`:65`） | 信任边界与静默默认行为的边界模糊 | P2 | 低 |
| #215 | 是 `[已验证]` | **不是漏洞**（`:74-77` 逐字命中） | 实现一致性缺陷 | 低 | **中**（有上游对照） |
| #216 | 排查中 | 功能面不受安全模型约束 | 待定 | 待定 | 待定 |

**当前建议：不重开。** 三条都不够得上安全漏洞，重开只会消耗上游的注意力并损害后续
建立信任的空间。如将来官方主动询问或我们要自己 fork 改，本文档即为现成依据。

---

## 7. 核验方法论（可复用）

### 7.1 探针陷阱：工作树 ≠ 目标 commit

fork 工作树停在 `38e0a91`，比 `519e4de` 少功能——它的 `discoverStepMcpServers` 里有一行
`if (!declared || typeof declared === "string") continue;`，`.mcp.json` 自动收养是
`519e4de` 才加的。**直接跑工作树会得到假阴性**（`discover` 返回 0），直接采信会得出
「机制不可达」的**相反结论**。

```powershell
git -C $fork archive --format=zip -o "$t\src.zip" refs/remotes/official/main packages/coding-agent/src
Expand-Archive "$t\src.zip" -DestinationPath "$t\src" -Force
```

> PowerShell 管道传二进制给 `tar`/`Expand-Archive` 会破坏数据，必须先 `-o` 落文件。
> 读单个文件时 `git show refs/remotes/official/main:<path>` 也要用 node 的
> `writeFileSync(..., "utf8")` 导出——PowerShell 的 `>` 写成 UTF-16，行号会错位。

### 7.2 探针陷阱：隔离根的变量名

`step/storage-root.ts:5-6` = `STEPCODE_STORAGE_ROOT_DIR || join(HOME, ".stepcode")`。
**只设 `HOME` 不会隔离**——`discoverStepMcpServers` 会去扫一个空目录，输出 `[]`，
看起来像「payload 未被发现」。**先断言 `defaultStepPluginsDir() === 你设置的目录` 再采信结果。**

### 7.3 探针陷阱：嵌套依赖与自引用包

`plugins.ts` → `bordered-loader` → `@step-harness/*` workspace 包。第三方依赖用 junction
接到已有 `node_modules`（只读），**只** stub 无法解析的自引用包。删临时目录时
`mavis-trash` 会**拒绝**处理 reparse point——先 `cmd /c rmdir <junction>`（**不加 `/S`**）
摘掉链接。**绝不能用 `Remove-Item -Recurse` 直接删含 junction 的目录**，PS 5.1 会跟穿。

### 7.4 纪律

- **子代理报告是线索不是结论。** 本档三条 issue 的核验中，两份独立审计的第一版探针
  各自有错（一个执行了工作树代码产出假阴性；一个用错环境变量名扫到真实 `~/.stepcode`，
  看起来像攻击失败）。父代理必须逐条回 `refs/remotes/official/main` 复核。
- **定性前先读 `SECURITY.md`。** 决定 `[security]` 标签能否使用。
- **先复现再上报**；被证伪则撤回或更正，不硬撑。
- **官方纪律**：一条线程一个问题、不并行多开、禁止批量/自动化开 issue（越界永久封禁）、
  PR 仅限协作者、commit 不加 `Co-authored-by: <AI>` trailer、最小内核。
