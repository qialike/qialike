# dsh-tui — 面向 DeepSeek Harness 的 Ink/React 终端界面

`dsh-tui` 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的全屏终端 TUI：
一个交互式、单会话 agent，实时流式输出 token，完全通过 harness 自身的 Cordis 插件扩展点驱动。
**核心源码未被修改**；本仓库是一个新的 bundle（`dsh-tui-app`）加一个 Bun 编译的单文件启动器。

## 是什么

- 一个 Cordis **bundle**（`@yourname/dsh-tui-app`）：在 `dsh-base` 之上的一层 `cordis.patch.yml`，
  加一个运行时粘合插件——创建一个 `Agent`，把它的 `session/event` 流进 Ink 转写区，
  并通过 `agent.followup()` / `agent.steer()` 把用户输入送回。
- 一个**单文件二进制**（`dist/dsh-tui`），由 `bun build --compile` 产出，把整个 harness + TUI
  bundle 打进去。所有按名引用的东西都从打包后的 `lib/` 输出解析，因此单个文件即可启动完整
  插件树，运行时无需 `node_modules`。

## 环境要求

- Node.js `^22.19 || >=24`（用于 `pnpm` 构建工具）
- 一份 DeepSeek Harness 检出（`DSH_HARNESS`，默认 `../deepseek-harness`）
- 跑真实会话时需要 `DEEPSEEK_API_KEY`（环境变量、`~/.dsh` 设置或 `.env`）

## 构建

```sh
pnpm install
pnpm build        # dist/dsh-tui（单文件可执行）
pnpm test         # 启动组合树并解析 TUI 命令（无 key 冒烟）
pnpm typecheck
```

`build.mjs` 读取 `DSH_HARNESS`（默认 `../deepseek-harness`），把每个被引用的 `@deepseek-ai/*`
包的已构建 `lib/` 复制到 `apps/tui-bin/x/`，内联那几处
`createRequire(import.meta.url)("../package.json")` 版本读取以及 Ink 的 `yoga.wasm`，从 harness
的 pnpm store 镜像第三方依赖，然后 `bun build --compile` 打包 `apps/tui-bin/src/bin.ts`。

## 运行

```sh
dist/dsh-tui                              # 继续当前目录下最近一次会话，无则开启新会话
dist/dsh-tui --workspace ~/proj           # 继续 ~/proj 下最近一次会话
dist/dsh-tui --resume <sessionId>         # 恢复指定持久化会话
dist/dsh-tui --model deepseek-v4-flash    # 选择模型
dist/dsh-tui --help
```

启动时 dsh-tui **自动恢复当前目录下最近使用过的会话**(最后活动时间优先,`~/.dsh/dsh-tui.json` 的 `resume_last: true`,默认开启),重启后接续上次工作——恢复某会话或向其发消息即标记为最近使用。状态行标注 `(resumed)`。显式 `--resume <sessionId>` 始终优先;设 `resume_last: false`(或 `DSH_TUI_RESUME_LAST=0`)则每次全新开始。

### 界面特性

- **斜杠命令面板**：输入 `/` 自动补全。命令：`/help`、`/models`、`/compact`、`/clear`、`/new`、`/sessions`、`/exit`。
  `↑/↓` 移动，`Enter` 执行，`Esc` 关闭。
- **`/compact`**：手动把当前会话的较旧历史压缩成一条摘要，与 web 界面共用 harness 的 `compaction` 服务。
  不接受参数（带参数会提示 `Usage: /compact (no arguments)`）。成功时显示 `Compacted N history items (~X tokens).`，
  无内容可压缩时显示 `No compactable history yet.`，失败时按分类（busy / cancelled / changed / summary / commit / persistence）显示对应文案。
- **`/plan`**：进入或退出**规划模式（plan mode）**（plan/mode 状态、提示词段与 `exit_plan_mode` 审批工具来自 harness base bundle）。
  `/plan`（或 `/plan <目标>`，同时把目标作为消息交给 agent）进入规划模式——agent 只规划不执行，直到计划经 `exit_plan_mode`
  审批通过或你执行 `/plan off` 退出。结果文案与 harness 命令一致（`Plan mode on/off`、`already inactive`、`applies from the next step`）。
- **`/goal`**：为会话设置或查看一个**持久的完成目标**（用于长时间运行的任务）。`/goal` 查看当前目标；
  `/goal <objective>` 创建目标（同时武装 harness 的 round driver，它会自动逐轮朝目标工作）；
  `/goal edit <objective>` 修改目标；`/goal pause` / `/goal resume` / `/goal clear` 控制目标。
  模型确认目标达成后会把目标标记为 complete 并停止续跑。目标域、模型工具（`get_goal`/`create_goal`/`update_goal`）与
  round driver 均来自 harness base bundle——本命令只是补上 TUI 的人类命令平面。
- **`/models`**：管理模型与 API key，与 web Models 页一致。弹出 opencode 式全屏对话框，**两级导航**：第一级按供应商归类
  （每个已配置 key 的提供商一行，行尾标注其模型数，如 `OpenCode Zen · 63 models`；当前选择的模型显示在顶部）；
  `↑/↓` 选择、`Enter` 打开该供应商的**模型子列表**（第二级）、`Esc` 返回一级；
  **一级/二级/Add provider 三个列表都支持打字即过滤**（顶部边框搜索框 `⌕ type to filter`，直接输入关键字实时过滤，如 `gpt` 只显示 GPT 系列），`Backspace` 删字符、`Esc` 先清过滤再退出；
  **列表超过一页时支持 `PgUp`/`PgDn`（翻页）、`Home`/`End`（首/尾）**；
  在子列表选中模型后 `Enter` 保存（下一次请求即切换，`agentDefaultModel.saveSelection` 持久化默认选择）。
  **支持推理强度的模型**（内置 DeepSeek 的 V4 Flash / V4 Pro / Vision Exp）在子列表按 `Enter` 会先弹出第三级
  **Effort** 选择框——Off / Low / High / Max（默认 High，各带一句说明；`↑/↓` 或数字键选择、`Enter` 确认、
  `Esc` 返回模型列表）——**确认推理强度后模型选择才算完成**。选中的强度随选择一起持久化
  （`agent-default-model.reasoningEffort`），并随每次请求下发 `thinking`/`reasoning_effort`
  （Off=不思考，Low/High/Max=思考强度递增）；主界面 Model 标签与状态行显示如 `DeepSeek · DeepSeek V4 Flash · Max`。
  未声明支持推理强度的提供商（如 OpenCode Zen 等）不弹 Effort、行为不变。
  **档位集完全由模型声明驱动，不同供应商可以不同**：如 DeepSeek 为 Off/Low/High/Max，别的网关可能是
  low/medium/high/xhigh/max——列表展示、默认档预选、Ctrl+T 循环与请求下发都按该模型自己的声明走
  （每档 id 原样作为 `reasoning_effort` 发送；"关思考"档在声明里标记，缺省约定 `off`）。
  dsh-tui 另内置一份 models.dev 风格的 **effort 目录快照**（`src/effort-catalog.ts`，词汇表
  `none/minimal/low/medium/high/xhigh/max`）作兜底数据源：**静态声明始终优先**；只有端点确认真接受
  `reasoning_effort` 的路由（模板声明 `effortWire: 'reasoning-effort'`，默认仅内置 DeepSeek）才会使用目录补全
  未静态声明的模型——UI/循环/持久化零改动。
  主窗口随时按 **`Ctrl+T`**（终端占用该组合键时用 **`Alt+T`** 备用）可**循环切换**当前模型的推理强度
  （按声明档位 wrap，如 Max→Off→Low→High→…；切换即持久化并作用于后续请求）；
  composer 的 Model 标签里档名以警示色高亮显示（如 `Model: DeepSeek · DeepSeek V4 Flash · Max`，对齐 opencode 的 variant 角标）。
  选择器只显示已配置 API key 的提供商；一级列表按 **`Ctrl+D`（备用 `Alt+D`）可停用高亮供应商**
  ——**同步移除其 API key** 并从 /models 一级消失（隐藏列表持久化于 `dsh-tui.json` 的 `hidden_providers`；
  key 来自环境变量时无法删除、会提示，隐藏集仍使其不显示）；重新加入 = 到 "Add provider" 列表选择该家并
  **重新设置 API key**（保存后自动恢复显示）；隐藏的是当前所用供应商时自动切换到其它已配置供应商，**隐藏后无任何激活供应商则当前模型显示 `not set`**；
  "＋ Add provider" 列出**所有已知的提供商**——自研适配器内置模板（38 家目录：OpenAI、OpenRouter、Anthropic、
  Google Gemini、Groq、Mistral、xAI、Z.AI / Zhipu AI、OpenCode Zen / OpenCode Go 等，
  OpenAI-compatible 为主、Anthropic/MiniMax 走原生 Messages 协议；
  **OpenCode Zen / Go 由可加载的 `tui-opencode-gateways` 子插件提供**——配置文件
  `dsh-tui-opencode: { enabled: false }` 可整体卸载（模板与已配置路由都从 /models 与适配器消失，默认开启）；
  DeepSeek 官方端点不在模板目录——由内置 `deepseek-official` 默认路由提供（3 模型，免配置即用）；
  另有 4 家部署型如 Azure OpenAI / Cloudflare Workers AI 标记 `endpoint required`；OpenCode Zen / Go 是 opencode 团队的
  OpenAI 兼容模型网关，key 取自 opencode.ai/auth（Zen 按量付费、Go 为 $10/月订阅），设 key 即可用）加上 `dsh-tui-llm:` 设置节声明的路由——并标注 key 状态
  （`✓ key set` / `no key`）。**已配置的 OpenAI 兼容提供商显示网关实时模型列表**：动态 `GET {baseURL}/models`
  拉取（失败/超时回退模板预置模型）——**OpenCode Zen 是单个条目,展示全部 63 个模型**(DeepSeek/GLM/Kimi/MiniMax/
  免费 + Claude/Qwen + GPT/Grok/Muse + Gemini),选中任一模型保存后,请求时**按模型自动路由到正确协议端点**：
  `claude-/qwen` → Anthropic messages(`x-api-key`)、`gpt-/grok-/muse-` → OpenAI Responses(Bearer)、`gemini-` → Google
  generateContent(`x-goog-api-key`)、其余 → chat/completions(Bearer);四种认证均已实测通过。选中任意一个（已配置的也可以）弹出子对话框设置或**替换**其 API key
  （已有 key 时对话框提示 "replaces the current key"）；给休眠的模板路由设 key 会**当场激活**
  （把模板的完整 profile——端点与模型目录——写入 `dsh-tui-llm` 设置节并热注册路由，其模型随即出现在选择器）；
  列表支持滚动（高亮始终可见）。
  "＋ Add a custom provider" 进入逐字段表单（第一步为提供商模板下拉——DeepSeek / OpenAI / OpenRouter / Groq 等
  或自定义，自动预填 route/显示名/base URL；再填 API key / 模型 id），写入
  `dsh-tui-llm` 设置节的 OpenAI 兼容提供商并存入凭据，适配器热注册后立即可选；key 经 credentials
  服务写入 `~/.dsh/.credentials.yaml`（按各提供商的引用名）按需解析。key 不会进入 transcript/发给模型。
  （若环境变量已有对应 key 则优先，遮蔽 store。）声明支持图片输入的模型（如 DeepSeek V4 Flash Vision Exp、GPT-4o、Claude）
  可接收会话中附带的图片，适配器转成 OpenAI `image_url` parts 或 Anthropic base64 source 块。
- **审批对话框**：某工具请求审批时，带内弹窗显示工具名与原因。`y`/`a` 允许一次，`n`/`Esc` 拒绝。
  （无沙箱 profile 下当前无工具会请求审批，故对话框默认休眠——已在需要时接线就绪。）
- **`/sessions` 会话管理器（唯一的会话选择入口）**：opencode 风格全屏对话框——列出持久化会话（**仅当前工作目录**，与自动恢复同目录语义一致）（**标题**/id，不显示日期时间——日期由分组组头承载），**打字即过滤**（标题/id/cwd），`Enter` 恢复所选、`Ctrl+R` 改名所选（本地持久，重启仍有效）、`Ctrl+F` 置顶/取消置顶（置顶会话在顶部 `📌 Pinned` 组，持久）、`Ctrl+D` 删除所选历史会话（两次确认；当前会话受保护）、`Esc` 两级退出；列表超页支持 `PgUp`/`PgDn`/`Home`/`End`，**按创建时间倒序（最新在前）并按创建日期分组**（`Today` / `Yesterday` / 日期组头）。每行以会话**标题**打头——即**第一个任务的摘要**（如 `你是谁 · @9/1/2026, 5:47:18 PM · /home/pipo/temp`）：harness 的 `session-title` 服务从会话第一条消息折叠生成（确定性 fallback，可被 LLM 标题提供者润色），随会话持久化——包括 `/new` 切换掉的旧会话。该对话框只承载历史会话记录——开启全新会话由 `/new` 负责。内容级搜索暂不可用（harness 单文件进程无 remote 层的会话内容搜索 API）。
- **`/new` 新会话**：就地开启一个全新会话（对应 opencode 的 "New session" 入口）。取消当前回合、创建新 agent、拆除旧 agent——harness 对所有会话自动持久化，因此之前的对话仍可从 `/sessions` / `--resume` 找回；当前模型选择与工作目录保留。
- **`/export` 会话导出**：输入 `/export` 弹出**导出对话框**（格式 JSON/Markdown、文件名可编辑、脱敏开关；`↑/↓` 移动字段、`←/→` 切换、输入文件名、`Enter` 导出）；带参数直达：导出会话为 **JSON**（机器可读，opencode `export` 同型）或 **Markdown**（人类可读回放）。`/export` 导出当前会话、`/export <sessionId>` 指定会话、`--markdown` 切换格式、`--sanitize` 脱敏（文本/工具输出替换为 `[redacted:…]`）、`--output <名称>` 自定义文件名（自动加扩展名,可含子目录,如 `notes/summary`）。写入**工作区根目录** `export-<时间>-<id>.(json|md)`，状态行显示路径。
- **opencode 式布局**：对话列 + Activity 面板（工具调用/结果）+ 底部输入框。

## 插件化架构（"一切皆插件"）

界面由 Cordis 插件组合而成（与 harness 一致）：`tui-startup`（CLI 参数）、`tui-llm`（自研供应商层）、
`tui-models`（提供商枚举 / Add-provider 写入）、`tui-runtime`（内核：Store、面板注册表、按键分发、agent 接线），
以及向 `tui` 服务注册的功能插件——`tui-panel-conversation`（主界面）、
`tui-panel-approval`、`tui-panel-question`、`tui-panel-models`（`/models` 对话框）、
`tui-sessions`（`/sessions` 对话框）、`tui-export`（`/export` 对话框）、`tui-new`（`/new` 就地切换会话）。
第三方插件通过 `ctx.get('tui')`（`panels.register` / `commands.register` / `notify`）与
`ctx.get('tuiStore')` 接入；插件契约与示例见 `packages/dsh-tui-app/src/panels/`。

## 安装为命令

```sh
bash scripts/install      # 把 dist/dsh-tui 拷贝到 ~/.dsh/bin，并把 ~/.dsh/bin 加入 PATH
# （等价于 pnpm install:local；工作台根执行：bash dsh-tui/scripts/install）
dsh-tui                  # 此后任意目录可直接执行
dsh-tui --help
dsh-tui uninstall        # 从二进制内部卸载生产安装：删除 ~/.dsh/dsh-tui.{log,json}
                         #   与追加到 ~/.bashrc/~/.zshrc 的 PATH 行；运行中的
                         #   ~/.dsh/bin/dsh-tui 拷贝给出手动删除提示
pnpm uninstall:local     # （历史遗留）移除旧版 scripts/install.sh 创建的
                         #   ~/.local/bin/dsh-tui 软链
```

二进制在构建时已内嵌 DeepSeek Harness，因此 `dsh-tui` 运行时**不需要** harness 检出、`pnpm` 或
`node_modules`——只需 `DEEPSEEK_API_KEY`（环境变量 / `~/.dsh` settings / `.env`）与一个工作区
（默认 `cwd`，或 `--workspace`）。会话状态、设置与凭据存放在 `~/.dsh`。

## 作为插件 bundle 安装

一旦 harness 发版，`@yourname/dsh-tui-app` 可作为树外 bundle 添加到某个 profile：

```sh
dsh plugin --profile tui add @yourname/dsh-tui-app
dsh --profile tui --workspace ~/proj
```

`dsh plugin add` 通过安装目录的 `profiles/node_modules` fallback 解析 `@deepseek-ai/*` peer
依赖；预发布 harness 尚未上架，需先发版。

## 目录结构

```
packages/dsh-tui-app/   bundle：cordis.patch.yml + startup/index/invariant 插件
apps/tui-bin/           src/bin.ts（SEA/bun 启动器）+ build.mjs
examples/cordis.yml     一处部署 overlay：固化模型与工作区
tests/smoke.mjs         无 key 的 REAL-composition 启动冒烟
```

`cordis.patch.yml` 在 `dsh-base` 之上，并禁用 OS 沙箱行（单文件不带原生 addon），保留
`workspace-write + ask` 的审批边界与本地 `bash`/`fs` provider。
