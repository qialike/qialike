# qialike — 面向 DeepSeek Harness 的 Ink/React 终端界面

> **文档定位：** 本文为**用户手册**，主要描述 qialike 的使用方法。

`qialike` 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的全屏终端 TUI：
一个交互式、单会话 agent，实时流式输出 token，完全通过 harness 自身的 Cordis 插件扩展点驱动。
**核心源码未被修改**；本仓库是一个新的 bundle（`qialike-app`）加一个 Bun 编译的单文件启动器。

## 是什么

- 一个 Cordis **bundle**（`@yourname/qialike-app`）：在 `dsh-base` 之上的一层 `cordis.patch.yml`，
  加一个运行时粘合插件——创建一个 `Agent`，把它的 `session/event` 流进 Ink 转写区，
  并通过 `agent.followup()` / `agent.steer()` 把用户输入送回。
- 一个**单文件二进制**（`dist/qialike`），由 `bun build --compile` 产出，把整个 harness + TUI
  bundle 打进去。所有按名引用的东西都从打包后的 `lib/` 输出解析，因此单个文件即可启动完整
  插件树，运行时无需 `node_modules`。

## 环境要求

- Node.js `^22.19 || >=24`（用于 `pnpm` 构建工具）
- bun（用于 `pnpm build` 的 `bun build --compile` 打包与 `pnpm test:unit`；未固定版本，装最新即可，参考已验证 v1.3.14）
- 一份 DeepSeek Harness 检出（`DSH_HARNESS`，默认 `../deepseek-harness`；仅 `pnpm build` 需要，运行编译好的 `dist/qialike` 无需检出）
- 跑真实会话时需要 `DEEPSEEK_API_KEY`（环境变量、`~/.dsh` 设置或 `.env`）
- **内存**（2026-09-14 在 `0.4.15-beta` 上实测；整棵进程树、静置 12 s）：编译后的单文件可执行体启动 hero 峰值约 **250–290 MB**、加载超大会话约 **330–345 MB**，稳态常驻 **约 170 MB（hero）–225 MB（长会话）**；只读打开一个 30 MB（压缩）的转录峰值约 **320 MB**、随后稳定在约 **220 MB**。建议 **≥1 GB** 内存；512 MB 可用但偏紧（超长转录没有 swap 余量），低于 512 MB 不支持。运行时是 Bun/JSC，不会及时把已释放页面还给系统，所以 RSS 随使用缓慢上升后趋于平台——**这是 GC 策略，不是泄漏**（实测：同一负载下开 `BUN_JSC_collectContinuously=1`，RSS 不升反降）。内存紧张时该环境变量就是官方缓解手段，代价是 GC 更频繁。
- **Linux 沙箱**：受限 `bash` 走 harness 的 `bwrap` → Landlock 两级链，qialike 现在**两级都自带**。宿主有
  `bwrap`（**bubblewrap**）时优先用它；没有、或无法创建 namespace 时，链条落到 **Landlock**——qialike 用
  `bun:ffi` 自己实现该 launcher，并以本二进制自身的子命令形式重入（`--ro` / `--rw` / `--probe`）。Landlock
  不需要宿主安装、不需要 `setuid`、不需要 user namespace，只要内核启用该 LSM（≥5.13），因此 Linux 通常
  开箱即得内核级写边界。较旧的内核 ABI 会如实上报为 partial enforcement，不夸大。只有两级都无法强制时，
  `workspace-write` / `read-only` 下的 bash 才 fail-closed 报 `SANDBOX_UNAVAILABLE`，仅 `danger-full-access`
  能跑。macOS 用系统自带 Seatbelt；Windows 用 harness 的 ACL restricted-token runner（现已真实打进单文件，见下）。
- **机密文件读取防护**：工具读取 `.env` 系列文件、`.git` 内部路径、以及 harness 凭据文档一律拒绝，任何
  沙箱模式下都生效。这是机密性规则而非文件效果边界，所以 `danger-full-access` 不会解除它，也不适用
  `sandbox_permissions` 升级。`.env.example` 仍可读。该防护拦的是读**工具**；shell 命令里点名机密文件
  不会被拦——从 shell 文本反推路径不可靠，这也是 Gemini CLI 同样存在的缺口，此处如实记录而非近似实现。
- **Windows shell 沙箱**：`pwsh` 运行在 harness 的 ACL **restricted-token** runner 之下，写权限通过
  每工作台一个的 capability SID 授予，其余写入一律拒绝。它不需要提权、不需要 provisioning 账户；读、网络与
  进程可见性不受影响，并且如实上报 `partial` 级执行。要让这一档在单文件里真正跑起来，有两件事必须自带：
  它依赖的原生 `koffi`（由 `apps/tui-bin/stub/koffi.js` 顶替），以及 **runner 进程本身**——harness 用模块
  specifier 定位它，而编译后的二进制答不了这个调用，于是 qialike 把 harness 自己的 runner 打包进来、并由本
  二进制充当它的 launcher，与 Linux 上 Landlock 的做法完全一致。若某主机的执行器仍报告"无内核隔离"，则保留
  **逐次 shell 审批**作为兜底：该闸门由所挂执行器自身的能力事实驱动，提示会明说该命令拥有你的完整用户权限。
- **工作台 `delete` 与 `move` 工具**：harness 的文件 seam 只发布两个变更操作（`writeText`、`editText`），
  qialike 补上缺的两个——删除与重命名。它们**只被围栏在工作台根内**（不是 harness 的 `writableRoots()`
  临时区授权，那套是给 mkstemp 式写入用的，没有对应的删除需求），拒绝操作工作台根自身，`move` 的**两端**
  都要过围栏，`read-only` 拒绝、`danger-full-access` 放行。之所以需要它们：某些主机上 shell 要么昂贵要么
  不可用——Windows 每次 shell 调用都要起一个受限进程，而既无 `bwrap` 又无 Landlock 的 Linux 上 shell 直接
  fail-closed。`mkdir` 不需要额外工具——`writeText` 已递归创建父目录。
- **`glob` / `grep` 可用**：两个工具都经随包携带的 ripgrep 搜索，而 harness 是用模块 specifier
  （`@vscode/ripgrep-<platform>-<arch>/bin/rg`）定位它的——单文件构建会打进去那段 JavaScript，却打不进那
  5 MB 的可执行文件，于是每次调用都在启动阶段以 `ripgrep launch failed` 失败。现在产物**自带**与其构建目标
  匹配的 ripgrep：build 把可执行文件内嵌，并把工具的定位改指向它，首次搜索时把字节落盘（见
  `packages/qialike-app/src/ripgrep-shim.ts`）。

### 终端颜色档位

qialike 的主题色是 hex，交给 Ink/chalk 输出，而 chalk 从环境变量判断终端能显示多少色。**Ubuntu 24.04 上的 GNOME Terminal/VTE 支持 24 位却不导出 `COLORTERM`**，于是 chalk 落到 256 色档；qialike 在该档自己接管调色板映射（保证页面、浮起面板与输入卡片三者颜色互不相同——没有这层映射时，5 款内置皮肤会把卡片画成和页面同色）。若你的终端确实是 24 位、想要原始 hex：

```sh
export COLORTERM=truecolor      # 标准信号，所有工具都认
# 或只对这一次运行：
QIALIKE_COLOR=24bit qialike
```

`QIALIKE_COLOR` 也接受 `256` 与 `16`（可用来预览低色终端下的效果）。**16 色档**下深色皮肤的卡片与页面都是黑——调色板里没有第二个近黑色可选，属**设计上的降级**；实测数据见工作区文档 `qialike-color-depth-fix-design.md`。

### 帧重绘（光标 + 同步输出）

每一帧都**先隐藏硬件光标再绘制**，帧尾后缀再把 caret 的形状与位置放回——因此光标不会被（可见地）拖着扫过重绘涉及的行。每一帧同时被终端的**同步输出**模式括起来（`ESC[?2026h` … `ESC[?2026l`）：一帧是整宽重绘（打开命令面板实测 120×30 下约 5.5 KB、240×30 下约 7.4 KB），而 pty 会把超过约 4095 字节行规程缓冲的写入分成多次交给终端，没有这个模式时半绘制的帧会短暂可见（输入卡片的边框/状态行从弹层里透出来）。不认这个模式的终端会忽略它；若某个终端处理不当，用 `QIALIKE_NO_SYNC=1` 写普通帧。

## 构建

```sh
pnpm install
pnpm build        # dist/qialike（单文件可执行）
pnpm test         # 启动组合树并解析 TUI 命令（无 key 冒烟）
pnpm typecheck
```

`build.mjs` 读取 `DSH_HARNESS`（默认 `../deepseek-harness`），把每个被引用的 `@deepseek-ai/*`
包的已构建 `lib/` 复制到 `apps/tui-bin/x/`，内联那几处
`createRequire(import.meta.url)("../package.json")` 版本读取以及 Ink 的 `yoga.wasm`，从 harness
的 pnpm store 镜像第三方依赖，然后 `bun build --compile` 打包 `apps/tui-bin/src/bin.ts`。

## 运行

```sh
dist/qialike                              # 开启新会话并显示 hero 首屏（从不自动续接）
dist/qialike resume                       # 继续当前目录下最近一次会话
dist/qialike --workspace ~/proj           # 在 ~/proj 下操作（其自身的会话）
dist/qialike --resume <sessionId>         # 恢复指定持久化会话
dist/qialike --model deepseek-flash       # 选择模型（DeepSeek V4.1 Flash）
dist/qialike --help
```

裸执行 qialike 会**开启新会话**并显示 hero 首屏,从不自动续接;要接续上次工作请执行 qialike resume——它继续**当前目录下**最近使用过的会话(最后活动时间优先),直接进入会话界面(该目录下尚无有内容的会话时,也进入会话界面而非 hero 首屏)。恢复某会话或向其发消息即标记为最近使用,状态行标注 `(resumed)`。显式 `--resume <sessionId>` 始终优先。**每次启动都自动续接**为可选项:设 `~/.dsh/qialike.json` 的 `resume_last: true`(或 `QIALIKE_RESUME_LAST=1`)——默认为 `false`,即每次启动全新开始。

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
- **`/models`**：管理模型与 API key，与 web Models 页一致。弹出全屏对话框，**两级导航**：第一级按供应商归类
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
  qialike 另内置一份 models.dev 风格的 **effort 目录快照**（`src/effort-catalog.ts`，词汇表
  `none/minimal/low/medium/high/xhigh/max`）作兜底数据源：**静态声明始终优先**；只有端点确认真接受
  `reasoning_effort` 的路由（模板声明 `effortWire: 'reasoning-effort'`，默认仅内置 DeepSeek）才会使用目录补全
  未静态声明的模型——UI/循环/持久化零改动。
  主窗口随时按 **`Ctrl+T`**（终端占用该组合键时用 **`Alt+T`** 备用）可**循环切换**当前模型的推理强度
  （按声明档位 wrap，如 Max→Off→Low→High→…；切换即持久化并作用于后续请求）；
  composer 的 Model 标签里档名以警示色高亮显示（如 `Model: DeepSeek · DeepSeek V4 Flash · Max`）。
  选择器只显示已配置 API key 的提供商；一级列表按 **`Ctrl+D`（备用 `Alt+D`）可停用高亮供应商**
  ——**同步移除其 API key** 并从 /models 一级消失（隐藏列表持久化于 `qialike.json` 的 `hidden_providers`；
  key 来自环境变量时无法删除、会提示，隐藏集仍使其不显示）；重新加入 = 到 "Add provider" 列表选择该家并
  **重新设置 API key**（保存后自动恢复显示）；隐藏的是当前所用供应商时自动切换到其它已配置供应商，**隐藏后无任何激活供应商则当前模型显示 `not set`**；
  "＋ Add provider" 列出**所有已知的提供商**——自研适配器内置模板 + 可加载网关子插件（61 家目录：OpenAI、OpenRouter、Anthropic、
  Google Gemini、Groq、Mistral、xAI、Z.AI / Zhipu AI、OpenCode Zen / OpenCode Go 等，
  OpenAI-compatible 为主、Anthropic/MiniMax 走原生 Messages 协议；
  **OpenCode Zen / Go 由可加载的 `tui-opencode-gateways` 子插件提供**——配置文件
  `qialike-opencode: { enabled: false }` 可整体卸载（模板与已配置路由都从 /models 与适配器消失，默认开启）；
  **中国网关 七牛（`qiniu-ai`）与硅基流动（`siliconflow` / `siliconflow-cn`）由可加载的 `tui-china-gateways` 子插件提供**——
  `qialike-china-gateways: { enabled: false }` 可整体卸载（默认开启）；
  **国外多模型网关/托管平台（OpenRouter、Vercel AI Gateway、Cloudflare(AI Gateway/Workers AI)、Hugging Face、Baseten、
  Fireworks AI、Together AI、Nvidia、Groq、Cerebras）由可加载的 `tui-foreign-gateways` 子插件提供**——
  `qialike-foreign-gateways: { enabled: false }` 可整体卸载（默认开启）；
  DeepSeek 官方端点不在模板目录——由内置 `deepseek-official` 默认路由提供（3 模型，免配置即用）；
  另有部署型（目录内 Vertex AI / Databricks / Snowflake Cortex，Azure 与 Cloudflare 行由可加载插件提供）标记 `endpoint required`；OpenCode Zen / Go 是 opencode 团队的
  OpenAI 兼容模型网关，key 取自 opencode.ai/auth（Zen 按量付费、Go 为 $10/月订阅），设 key 即可用）加上 `qialike-llm:` 设置节声明的路由——并标注 key 状态
  （`✓ key set` / `no key`）。**已配置的 OpenAI 兼容提供商显示网关实时模型列表**：动态 `GET {baseURL}/models`
  拉取（失败/超时回退模板预置模型）——**OpenCode Zen 是单个条目,展示全部 63 个模型**(DeepSeek/GLM/Kimi/MiniMax/
  免费 + Claude/Qwen + GPT/Grok/Muse + Gemini),选中任一模型保存后,请求时**按模型自动路由到正确协议端点**：
  `claude-/qwen` → Anthropic messages(`x-api-key`)、`gpt-/grok-/muse-` → OpenAI Responses(Bearer)、`gemini-` → Google
  generateContent(`x-goog-api-key`)、其余 → chat/completions(Bearer);四种认证均已实测通过。选中任意一个（已配置的也可以）弹出子对话框设置或**替换**其 API key
  （已有 key 时对话框提示 "replaces the current key"）；给休眠的模板路由设 key 会**当场激活**
  （把模板的完整 profile——端点与模型目录——写入 `qialike-llm` 设置节并热注册路由，其模型随即出现在选择器）；
  列表支持滚动（高亮始终可见）。
  配色方案（vim 风格 `:colorscheme`）：直接输入 `/theme`（不带参数）弹出**主题选择对话框**——`↑/↓` 移动、直接打字过滤、移动时**实时预览**、`Enter` 应用并持久化、`Esc` 取消并还原；也支持 `/theme dark`（或唯一前缀，如 `d` 或 `da`）、`/theme <name>`、`/theme <role> <hex>` 快捷路径。内置 **16 套**方案：`dark`（DeepSeek Harness 网页深色设计令牌——仓库 `deepseek-harness` MIT：`design-platform.css` 的 `body[data-ds-dark-theme]` 别名块）与 `light`（Atom One Light——原 `one-light` 可选皮肤提升为默认浅色，官方仓库 GitHub Inc. MIT），外加可选皮肤 `one-dark`（Atom 官方仓库，GitHub Inc. MIT）+ **13 套经典皮肤** `catppuccin`/`dracula`/`everforest`/`falcon`/`flexoki`/`gruvbox`/`jellybeans`/`kanagawa`/`nord`/`panda`/`rosepine`/`solarized`/`solarized-light`（solarized-light 为同一上游仓库的官方浅色面；12 套解析自上游项目官方仓库——falcon 与 flexoki 为各自官方 MIT 仓库、panda 取 Atom 原版 MIT 配色、`jellybeans` 按 MIT vim colorscheme 语义映射；**全部 MIT/宽松许可**，来源与许可见 `classic-schemes.ts` 与 THIRD_PARTY_NOTICES），外加 `~/.dsh/themes/*.json` 用户文件；`qialike-theme: { colorscheme: light }` 持久化。方案的 `bg` 会作为全屏背景层涂色，字素由补丁帧写入器强制 `theme.bg`/`theme.text`，切换 dark/light 时整屏底色与字色（不止边框/文字）随之变化。
  Add-provider 列表按显示名 A–Z 排序，一级列表 `＋ Add provider` 行尾显示可加供应商总数。
  "＋ Add a custom provider" 进入逐字段表单（步骤以 `[ N ]` 标示；第一步为提供商模板下拉——DeepSeek / OpenAI / OpenRouter / Groq 等
  或自定义，自动预填 route/显示名/base URL；再填 API key / 模型 id），写入
  `qialike-llm` 设置节的 OpenAI 兼容提供商并存入凭据，适配器热注册后立即可选；key 经 credentials
  服务写入 `~/.dsh/.credentials.yaml`（按各提供商的引用名）按需解析。key 不会进入 transcript/发给模型。
  （若环境变量已有对应 key 则优先，遮蔽 store。）声明支持图片输入的模型（如 DeepSeek V4 Flash Vision Exp、GPT-4o、Claude）
  可接收会话中附带的图片，适配器转成 OpenAI `image_url` parts 或 Anthropic base64 source 块。
- **审批对话框**：某工具请求审批时，带内弹窗显示工具名与原因。`y`/`a` 允许一次，`n`/`Esc` 拒绝。
  （无沙箱 profile 下当前无工具会请求审批，故对话框默认休眠——已在需要时接线就绪。）
- **`/sessions` 会话管理器（唯一的会话选择入口）**：全屏对话框——列出持久化会话（**仅当前工作目录**，与 `resume` 同目录语义一致）（**标题**/id，不显示日期时间——日期由分组组头承载），**打字即过滤**（标题/id/cwd），`Enter` 恢复所选、`Ctrl+R` 改名所选（本地持久，重启仍有效）、`Ctrl+F` 置顶/取消置顶（置顶会话在顶部 `📌 Pinned` 组，持久）、`Ctrl+D` 删除所选历史会话（两次确认；当前会话受保护）、`Esc` 两级退出；列表超页支持 `PgUp`/`PgDn`/`Home`/`End`，**按创建时间倒序（最新在前）并按创建日期分组**（`Today` / `Yesterday` / 日期组头）。每行以会话**标题**打头——即**第一个任务的摘要**（如 `你是谁 · @9/1/2026, 5:47:18 PM · /home/pipo/temp`）：harness 的 `session-title` 服务从会话第一条消息折叠生成（确定性 fallback，可被 LLM 标题提供者润色），随会话持久化——包括 `/new` 切换掉的旧会话。该对话框只承载历史会话记录——开启全新会话由 `/new` 负责。内容级搜索暂不可用（harness 单文件进程无 remote 层的会话内容搜索 API）。
- **`/new` 新会话**：就地开启一个全新会话。取消当前回合、创建新 agent、拆除旧 agent——harness 对所有会话自动持久化，因此之前的对话仍可从 `/sessions` / `--resume` 找回；当前模型选择与工作目录保留。
- **`/export` 会话导出**：输入 `/export` 弹出**导出对话框**（格式 JSON/Markdown、文件名可编辑、脱敏开关；`↑/↓` 移动字段、`←/→` 切换、输入文件名、`Enter` 导出）；带参数直达：导出会话为 **JSON**（机器可读）或 **Markdown**（人类可读回放）。`/export` 导出当前会话、`/export <sessionId>` 指定会话、`--markdown` 切换格式、`--sanitize` 脱敏（文本/工具输出替换为 `[redacted:…]`）、`--output <名称>` 自定义文件名（自动加扩展名,可含子目录,如 `notes/summary`）。写入**工作区根目录** `export-<时间>-<id>.(json|md)`，状态行显示路径。
- **`/sidebar` 右侧栏开关**：右侧 **Steps** 面板（`session <id>` + `Steps X/Y` 进度 + 步骤清单；模型未用 `todo_write` 时显示 `no plan yet`）默认在终端足够宽（≥110 列）时自动显示。输入 `/sidebar` 可切换——无参时循环 `auto → on → off`，`/sidebar on|off|auto` 直接设档；**鼠标左键点击 Steps 标题栏**同样可切换。`auto` 随宽度、`on` 恒显（窄窗也显示）、`off` 恒隐（消息列与输入框随之变宽，等同窄窗布局）。选择持久化到 `~/.dsh/qialike.json` 的 `sidebar_mode`（默认 `auto`）；消息列/输入框宽度、换行、光标格、鼠标点击、选区保护等全部几何与显隐判定一致，切换后布局与光标不会错位。
- **布局**：对话列（转写区 + 底部输入框）+ 右侧 Steps 面板（≥110 列自动显示，或经 `/sidebar` 强制显隐）；旧的 Activity 面板与 `/activity` 命令早已移除。
- **运行状态"活性指示"（界面不会"看起来像卡死"）**：agent 运行期间，底部状态栏持续显示**相位与经过秒数**——`⠙ thinking · 12s · Esc to pause`（模型思考）、`⠴ answering · Ns`（正文流式）、工具调用时显示**当前工具名**（并行折叠为 `name ×n`），事件静默 ≥4s 会标出 `Ns since last event`——长任务中画面始终在动。若渲染循环真停摆（agent 仍在后台工作），**内置看门狗**自动两级强制重绘（并在 `~/.dsh/qialike.log` 记录 `[watchdog]` 行），按任意键也可立即救回画面；单条异常消息导致的渲染错误只把该行降级为 `⚠ row dropped` 警告（`[row]` 日志），不会冻结整个界面。工具行完成后默认**折叠为摘要卡片**（bash/read/todo 等按参数生成摘要，如 `✓ bash · ls -la …`、`✓ todo_write · 3/5`；成功/失败着色、可展开标记 `…`），**鼠标点击该行**或 **`/think`**（统一展开/收起下方内容：Think 推理全文 + 全部工具行正文）展开/收起完整结果（限长，完整内容保留在会话日志——对齐 web 的摘要+展开语义）；模型输出达到长度上限且未产出正文时，对话区会给出明确提示（可发送任意消息继续，或用 Ctrl+T 调低推理档减少额度消耗）。
- **用户提问弹窗（`ask_user_question`，卡片式 + 悬窗 + Tab）**：一次询问含多题时使用**单卡片**逐题作答——标题显示 `Ask question k/N`，每题一个可点击 **Tab**（题目短标/题号，已答 `✓`、当前 `[n]`）；答题后自动进入下一题、`←/→`（或 Tab）回看改答、全部答完一次提交、Esc 取消整批；题多放不下时 Tab 栏自动**分页翻滚**（`…` 标记 + `←/→` 翻页）。选 **Other…** 时直接在**选项列表正下方行内输入**（不另弹框，Enter 提交并进入下一题）；弹窗为**悬窗式**——浮动在消息区上方、不压缩/不跳动会话区。问题与选项一律**完整换行不截断**，内容超高时弹窗内部滚动查看。鼠标可点选选项与 Tab（多行选项、已答标记均正确映射）。
- **工具行运行中活性**：Bash/Read/Write 等工具**执行期间**该行动态显示——行首转圈、行尾实时耗时 `· Ns`（与 web 运行态 sweep 对应的终端动效），完成后回到静态图标行并可点击展开结果。

## 插件化架构（"一切皆插件"）

### 无需重编译的扩展方式

两条通道都只吃数据文件 —— 不需要构建、也不需要安装：

- **Skills** —— 把技能包放到 `$DSH_HOME/skills/<name>/SKILL.md`（或项目的 `.dsh/skills/`、
  或 `~/.agents/skills/`），harness 的文件系统 provider 会自动发现，没有开关要开。
- **MCP server** —— 本构建把 MCP 客户端**打进包但不挂载**，所以在自己的 overlay
  `$DSH_HOME/profiles/tui/cordis.patch.yml` 里挂：

  ```yaml
  - insert:
      - id: mcp-github
        name: '@deepseek-ai/dsh-mcp-client'
        config:
          serverName: github
          transport: stdio
          command: npx
          args: ['-y', '@modelcontextprotocol/server-github']
  ```

  挂上之后，该 server 的工具以 `mcp__github__<tool>` 出现在模型面前。

`qialike plugin` 可以代你操作这些文件：

```sh
qialike plugin list [--available]   # 三层与各行；--available 列出本构建打包的全部插件
qialike plugin add-mcp <name> <command> [args...] [--project]
qialike plugin remove-mcp <name> [--project]
```

`--project` 作用于**仓库级** overlay（`<repo>/.dsh/tui.cordis.patch.yml`）而非个人那份。
启用/禁用不需要命令：**不带** `insert`、内容为 `disabled: true` 的行按 `id` 改内建行即可。

**仓库 overlay 在启动时自动应用，所以它有自己的一套策略。** 仓库不等于你本人：`git clone <仓库> && qialike`
不能悄悄跑起一个进程、也不能悄悄放宽你的沙箱。两条后果：

- **会 spawn 进程的行需要一次 per-repo 决定。** MCP server 行会在启动时执行它的 `command`，所以只有**这个文件**
  被显式信任时才生效 —— 在仓库里跑 `qialike plugin trust-overlay`，把内容哈希与 harness 版本记进
  `<profile>/overlays.trust.json`；文件一旦被改动就会重新询问，`qialike plugin list` 会显示状态。未信任时
  启动**直接拒绝**并给出修法。
- **安全类行一律拒绝。** 改（或关掉）`sandbox` / `sandbox-policy` / `fs-sandbox` / `bash-sandbox` /
  `pwsh-sandbox` / `approval` / `permission` / `fs-observation-policy` 的行只能写在**你自己的** overlay 里；
  仓库无权决定你的文件效果边界，信任也买不到它们。

仓库 overlay 生效时 hero 会明说（`⚠ repo overlay applied: …`）；`--no-project-overlay`（或
`QIALIKE_NO_PROJECT_OVERLAY=1`）这一次启动直接忽略该层；`qialike plugin list` 会打印该层、其中会跑进程的行
以及信任状态。

overlay 只能挂**打进本二进制**的插件。要跑自己的插件，把它当作普通包装进 profile 再显式信任：

```sh
# 1. 放到加载器查找的位置（npm install / pnpm 均可；软链也行）
#    ~/.dsh/profiles/tui/node_modules/my-plugin/{package.json,index.cjs}
#    module.exports = { name: 'my-plugin', inject: [], apply(ctx) { … } }
# 2. 在 overlay 里引用：  - insert: [{ id: my-plugin, name: 'my-plugin' }]
# 3. 审阅之后记录这次决定（hash + harness 版本）
qialike plugin trust my-plugin
```

加载器强制三件事：插件必须位于 `<profile>/node_modules` **之内**（软链会做 realpath 校验）；
必须针对**本二进制内嵌的 harness 版本**被信任（升级后会重新询问）；信任之后插件**自身**的文件**不得变化**——
任何改动都会让信任失效（`node_modules/` 与 `.git/` 刻意不在哈希内：重装依赖不算篡改，所以哈希覆盖的是你审阅过的代码，不是它拉进来的依赖树）。本地插件**在本进程内以完整权限运行**，所以信任是显式、逐个、可撤销的
（`qialike plugin untrust <name>`）。

overlay **最后应用**，所以**不带** `insert` 的行还能按 `id` 改内建行（换 persona、关掉某个工具）。
两种写错会被明确拒绝并给出原因 —— 插件加载器自己对这两种都是静默的：`insert` 里写了本构建未打包的插件名；
行的 `id` 匹配不到任何内建行。`qialike --dump-config` 会打印三层的组合结果以及每个插件来自哪一层。

界面由 Cordis 插件组合而成（与 harness 一致）：`tui-startup`（CLI 参数）、`tui-llm`（自研供应商层）、
`tui-models`（提供商枚举 / Add-provider 写入）、`tui-runtime`（内核：Store、面板注册表、按键分发、agent 接线），
以及向 `tui` 服务注册的功能插件——`tui-panel-conversation`（主界面）、
`tui-panel-approval`、`tui-panel-question`、`tui-panel-models`（`/models` 对话框）、
`tui-sessions`（`/sessions` 对话框）、`tui-export`（`/export` 对话框）、`tui-new`（`/new` 就地切换会话）。
第三方插件通过 `ctx.get('tui')`（`panels.register` / `commands.register` / `notify`）与
`ctx.get('tuiStore')` 接入；插件契约与示例见 `packages/qialike-app/src/panels/`。

## 安装为命令

```sh
curl -fsSL https://qialike.com/install | bash      # 已发布二进制 → ~/.dsh/bin
# 参数（两种调用形式均可用）：
#   bash -s -- --version 0.6.0    安装指定版本（接受 v 前缀）
#               --no-modify-path  不改动 ~/.bashrc / ~/.zshrc
#               --dry-run         只打印计划，不做任何改动
qialike                  # 此后任意目录可直接执行
qialike --help
qialike uninstall        # 从二进制内部卸载：清空整个 harness home（$DSH_HOME，默认 ~/.dsh——
                         #   config、日志、主题、settings.yaml、sessions、profiles、storages、
                         #   attachments、exports 及 ~/.dsh/bin 那份拷贝），并移除安装器追加到
                         #   ~/.bashrc/~/.zshrc 的 PATH 导出行，以及旧版 ~/.local/bin/qialike
                         #   开发软链
qialike web [flags]      # 打开 DeepSeek Harness 浏览器 UI（转发已安装的 `dsh web` CLI，Web
                         #   界面保持为 harness 自有实现）：需要 `dsh` 在 PATH 上
                         #   （`npm install -g @deepseek-ai/dsh`）或设置 $QIALIKE_DSH；
                         #   web 参数（--port/--no-open/...）原样透传
                         #   （--host 0.0.0.0 会被 web profile 拒绝）
pnpm uninstall:local     # （历史遗留）移除旧版 scripts/install.sh 创建的
                         #   ~/.local/bin/qialike 软链
```

在检出里可以直接跑同一个安装器——它下载的是**已发布**二进制，**不是**你的工作树：

```sh
bash scripts/install                 # 与上面那个 URL 提供的是同一个脚本
pnpm install:remote                  # 等价
```

`scripts/install` 的源在 `scripts/install.d/*.sh`，由 `scripts/build-install.sh` 拼接成单一自包含
文件——因为入口是把它管道给 `bash` 的。安装目录固定为 `~/.dsh/bin`，**刻意不跟随 `$DSH_HOME`**：
`qialike uninstall` 只扫 `$HOME/.dsh/bin` 与 `$HOME/.local/bin`。六个目标**全部已发布**——
`linux-x64`、`linux-arm64`、`darwin-x64`、`darwin-arm64`、`windows-x64`、`windows-arm64`——
解包工具由归档名决定（linux 用 `tar.gz`，其余用 `zip`）。Windows 安装为 `qialike.exe`。
其余平台会在写入任何东西之前按名字明确报错。

二进制在构建时已内嵌 DeepSeek Harness，因此 `qialike` 运行时**不需要** harness 检出、`pnpm` 或
`node_modules`——只需 `DEEPSEEK_API_KEY`（环境变量 / `~/.dsh` settings / `.env`）与一个工作区
（默认 `cwd`，或 `--workspace`）。会话状态、设置与凭据存放在 `~/.dsh`。

`qialike web` 运行已安装的 `dsh` CLI，其版本应不低于本 qialike 构建内嵌的 harness 版本：
两端读写同一份 `~/.dsh/sessions` 日志，更旧的 `dsh` 读取器会把新版范围压缩的
`sourceEventSeqs` 误判为损坏历史（`SessionPersistenceCorruptionError`）。启动前会先核对
`dsh`：未安装或版本与本 qialike 内嵌不一致时，告警并打印安装命令（版本不一致时不启动 web、
直接退出）。

`dsh web` 绑定 `127.0.0.1:3080`，启动后打印一条**带本次运行认证 token 的 URL**
（`http://127.0.0.1:3080/?token=…`）并用默认浏览器打开它。请**就用那条 URL**：不带 token
访问会得到 `401 dsh web authentication required; reopen the URL printed by dsh web.`；
它种下的认证 cookie 只对签发时的那一个 authority 有效（`127.0.0.1:3080` 与
`localhost:3080` 是两个不同的 authority），所以选定一个主机名后别再换。`--port <n>` 可换端口；
若端口已被占用，第二个服务会以 `EADDRINUSE` 退出，而浏览器仍在跟旧的那个服务说话——它的
token 你并没有。

### 无头 / 远程访问：本机跑服务，别机浏览器访问

服务端保持默认回环绑定，从**有浏览器的那台机器**做 SSH 隧道即可。`--host 0.0.0.0`
**不可用**——web profile 会直接拒绝（`error: --host 0.0.0.0 is intentionally not supported yet
for safety: it would expose remote code execution to the network; use 127.0.0.1 instead`）：

```sh
# 无头 / 纯终端主机上（无本地浏览器，故加 --no-open）
qialike web --no-open                  # 记下打印出的 http://127.0.0.1:3080/?token=… 这条 URL

# 在有浏览器的机器上
ssh -L 3080:localhost:3080 user@headless-host
# 然后在本机浏览器打开上面那条打印出来的 URL（http://127.0.0.1:3080/?token=…）
```

3080 被占用时两端都用 `--port <n>`；**仅建议在可信网络/内网/VPN 下使用**。

### 从 `dsh-tui` 升级

命令已改名：`dsh-tui` 不再存在——仓库目录是 `qialike/`、二进制是 `dist/qialike`。状态文件、
设置与环境变量会自动迁移，但**命令名不会**：shell profile 或脚本里若仍写着 `dsh-tui`，只会得到
`dsh-tui: command not found`；指向旧检出目录的 PATH 行同样解析不到任何东西。安装器**已不再报告**
这些失效行（它改为下载器时一并移除了该迁移），请自行检查：
`grep -n 'dsh-tui' ~/.bashrc ~/.zshrc`。`~/.dsh/bin` 下的旧名二进制**仍会被清理**——由
`qialike uninstall` 完成，它同样扫这个旧名。改完请**新开一个终端**——`export PATH=…` 只对重新
读取 profile 的 shell 生效，已开着的终端仍旧用旧 PATH。

## 作为插件 bundle 安装

一旦 harness 发版，`@yourname/qialike-app` 可作为树外 bundle 添加到某个 profile：

```sh
dsh plugin --profile tui add @yourname/qialike-app
dsh --profile tui --workspace ~/proj
```

`dsh plugin add` 通过安装目录的 `profiles/node_modules` fallback 解析 `@deepseek-ai/*` peer
依赖；预发布 harness 尚未上架，需先发版。

## 目录结构

```
packages/qialike-app/   bundle：cordis.patch.yml + startup/index/invariant 插件
apps/tui-bin/           src/bin.ts（SEA/bun 启动器）+ build.mjs
examples/cordis.yml     一处部署 overlay：固化模型与工作区
tests/smoke.mjs         无 key 的 REAL-composition 启动冒烟
```

`cordis.patch.yml` 在 `dsh-base` 之上；**OS 级沙箱行在所有平台都已启用**——bash 经 `ctx.sandbox.confine()`
运行（Linux 用 bwrap 或 qialike 自带的 Landlock launcher、macOS 用 Seatbelt），Windows 上 `pwsh` 经 ACL
restricted-token runner 运行，`danger-full-access` 不加隔离直跑。这一组里**已无任何 stub**：Windows 那一档
曾被两样"原生形状"的东西挡住，现在都已自带——`koffi` 由内置的 `bun:ffi` shim 顶替；runner 进程由 qialike
自己携带并启动（见 `apps/tui-bin/src/windows-acl-shim.ts`）。`permission`（presets）行因此也在所有平台启用
（它拒绝挂在无约束的执行器之上）。纯 JS `fs-sandbox` 栅栏、机密文件读取防护、以及**执行器不提供内核隔离时的
逐次 shell 审批闸门**，共同构成其余的边界。
