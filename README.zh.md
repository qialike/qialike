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
dist/dsh-tui                              # 在当前目录开启新会话
dist/dsh-tui --workspace ~/proj           # 在 ~/proj 中操作
dist/dsh-tui --resume <sessionId>         # 恢复已持久化的会话
dist/dsh-tui --model deepseek-v4-flash    # 选择模型
dist/dsh-tui --help
```

### 界面特性

- **斜杠命令面板**：输入 `/` 自动补全。命令：`/help`、`/models`、`/compact`、`/clear`、`/resume`、`/exit`。
  `↑/↓` 移动，`Enter` 执行，`Esc` 关闭。
- **`/models`**：管理模型与 API key，与 web Models 页一致。弹出 opencode 式全屏对话框：`↑/↓` 选择模型
  （DeepSeek V4 Flash / V4 Pro / V4 Flash Vision Exp），掩码输入 API key，`Enter` 保存、`Esc` 取消。
  保存后下一次请求即切换为所选模型（`agentDefaultModel.saveSelection` 持久化默认选择）；选择器只显示已配置 API key 的提供商；
  "＋ Add provider" 列出**所有已知的提供商**——自研适配器内置模板（DeepSeek、OpenAI、OpenRouter、Anthropic、Groq、Mistral、
  Together、Fireworks、xAI、Cerebras，OpenAI-compatible 为主、Anthropic 走原生 Messages 协议）加上 `dsh-tui-llm:` 设置节声明的路由——并标注 key 状态
  （`✓ key set` / `no key`）。选中任意一个（已配置的也可以）弹出子对话框设置或**替换**其 API key
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
- **`--resume` / `/resume` 会话选择**：列出持久化会话并恢复所选。
- **opencode 式布局**：对话列 + Activity 面板（工具调用/结果）+ 底部输入框。

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
