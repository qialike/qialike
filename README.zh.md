# qialike — 基于 DeepSeek Harness 构建的 AI 编程 Agent 终端界面（TUI）

[English](README.md) | 中文

```
########  ##    ######  ##        ##  ##    ##  ########
##    ##  ##        ##  ##        ##  ##  ##    ##    ##
##    ##  ##  ########  ##        ##  ####      ########
##    ##  ##  ##    ##  ##        ##  ##  ##    ##
########  ##  ########  ########  ##  ##    ##  ########
      ##
```

> **文档定位：** 本文为**用户手册**，主要描述 qialike 的使用方法。

`qialike` 是基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 构建的编程 Agent 终端 TUI：
支持系统：Linux、macOS、Windows，全屏、会话恢复、沙箱执行、单文件二进制、任意模型、插件化设计。

## 目录

- [是什么](#是什么)
- [快速使用](#快速使用)
- [环境要求](#环境要求)
- [安全边界](#安全边界)
- [数据与责任](#数据与责任)
- [从源码构建](#从源码构建)
- [安装为命令](#安装为命令)
- [更新](#更新)
- [运行](#运行)
- [插件化架构（"一切皆插件"）](#插件化架构一切皆插件)
- [文件放在哪里](#文件放在哪里)
- [故障排查](#故障排查)
- [问题反馈与参与](#问题反馈与参与)
- [致谢](#致谢)
- [许可证](#许可证)

## 是什么

qialike 是一个跑在终端里的全屏 AI 编程 Agent：你在项目目录里启动它，用自然语言说清要做什么，它自己读代码、
改文件、执行命令，并把每一步与模型的流式输出实时显示在同一屏上。

- **接着上次继续**：会话自动持久化——`qialike resume` 接续当前目录最近一次会话，`/sessions` 列出历史会话，
  可搜索、改名、置顶、删除。
- **模型自己挑**：内置 DeepSeek 官方端点（配好 `DEEPSEEK_API_KEY` 即可用）；`/models` 的 `＋ Add provider`
  列出 **62 家**供应商，国外如 OpenAI、Anthropic、Google Gemini、xAI、Mistral、OpenRouter、Groq、
  Hugging Face，国内如通义千问 Qwen、智谱 GLM、Kimi、MiniMax、火山引擎、硅基流动；选中即接入（OpenAI 兼容
  为主，Anthropic/MiniMax 走原生 Messages 协议），`Ctrl+T` 循环切换推理强度。
- **操作集中在 `/`**：输入 `/` 弹出补全面板——`/models`、`/sessions`、`/theme`、`/export`、`/plan`、
  `/goal`、`/compact`、`/sidebar` 等，`↑/↓` 选择、`Enter` 执行。
- **也能开在浏览器里**：`qialike web` 启动 DeepSeek Harness 自带的 Web 界面——把整条调用原样转发给已安装
  的 `dsh` CLI（`dsh web`，即 `dsh --profile web` 的官方别名）。该界面由 harness 自己提供，qialike 不复刻
  它；所需的 `dsh` 前提见「环境要求」。两端**共用同一份会话存储**：同一工作区下，web 里开的会话可直接用
  `qialike resume` 接续，qialike 的会话也会出现在 web 里（启动时挂到对应工作区以便分组）。
- **有边界地动手**：bash / pwsh 在 OS 级沙箱内运行；`.env`、`.git` 内部路径与凭据文件一律拒绝读取；执行器
  无内核隔离时，每次 shell 调用逐次审批。
- **装上就能跑**：Linux / macOS / Windows 各一个单文件可执行体，运行时既不需要 `node_modules`，也不需要
  harness 检出。
- **扩展不用重编译**：放入 skills 目录或挂上 MCP server 即可生效，无需构建、无需安装。

## 快速使用

三步就能开始。这里只给最短路径，每一步的完整说明在对应章节。

### 1. 安装

```sh
curl -fsSL https://qialike.com/install | bash
```

适用于 **Linux、macOS、WSL，以及 Windows 上的 Git Bash / MSYS2 / Cygwin**——各含 x64 与 arm64，共六个
发布目标，均已发布。需要 `bash` 与 `curl`；Linux 用系统 `tar` 解包，macOS 与 Windows 的 `.zip` 另需 `unzip`。

Windows 原生终端（Windows Terminal / PowerShell / cmd）里没有 bash，所以上面这条**安装命令**用不了——
需手动下载解压、自行配置环境变量：见 [Windows 终端](#windows-终端powershell--cmd)。注意这**只影响安装**，装好后的 `qialike.exe` 是原生
程序，在 Windows Terminal / PowerShell 里照常运行。

装到 `~/.dsh/bin`。安装器会把该目录写进 shell profile，但**当前这个 shell 里还没生效**——按它打印的提示
`source ~/.bashrc`（zsh 用 `~/.zshrc`），或直接**重开终端**；之后任意目录都可直接执行 `qialike`，用
`qialike --version` 校验。参数（指定版本、不改 PATH、只打印计划）见「安装为命令」。

### 2. 启动 qialike

进入工作区运行。

```sh
qialike
```

首次启动显示 hero 首屏；此时若还没配模型，首屏会提示 `No provider yet — use /models to add one`，模型标
签显示 `not set`。配置模型：

- **添加模型厂商**（共 62 家）：启动后输入 `/models`，在 `＋ Add provider` 里选一家并设置 API key（已配
  置的提供商会显示网关实时模型列表）；也可在 `＋ Add a custom provider` 里填自定义端点。
  **key 需自己到该提供商的官网/控制台申请**，qialike 不代申请、也不内置任何 key。

详见「界面特性」与「提供商目录与推理强度声明」。

### 3. 开启会话

模型配好后**不必重启**——就在当前界面输入你的要求并回车，hero 首屏随即让位给会话界面，会话自此开始。

进入后随时输入 `/` 唤起命令面板（`/models`、`/sessions`、`/theme`、`/export` 等），`/exit` 退出。会话
自动持久化，之后输入 `/sessions` 挑一个历史会话即可继续，或在 shell 里用 `qialike resume`。详见「运行」。

## 环境要求

- **平台**：Linux（含 WSL）、macOS、Windows；各 x64 / arm64，共六个发布目标。**运行**只需对应的原生
  可执行体（Windows 上即 `qialike.exe`）；只有 `curl | bash` 那条**安装命令**要 bash，故 Windows 上需经
  Git Bash / MSYS2 / Cygwin 或 WSL。其余平台不受支持，见「安装为命令」。
- **终端**：需要真正的 TTY——全屏界面、流式输出与鼠标交互都以交互式终端为前提。
- **无需预装运行时**：产物是单一可执行文件，运行时不需要 Node.js、bun、`pnpm`、`node_modules`，也不需要一
  份 harness 检出。
- **API key**：跑真实会话至少需要一个提供商的 key——内置 DeepSeek 端点用 `DEEPSEEK_API_KEY`（环境变量、
  `~/.dsh` 设置或 `.env`），换别的提供商在 `/models` 里设 key 即可。key 一律由**各提供商自己签发**（到其官网
  /控制台申请），qialike 不代申请、也不内置任何 key。
- **工作区**：默认当前目录（`cwd`），或用 `--workspace` 指定；会话状态、设置与凭据存放在 `~/.dsh`。
- **磁盘**：下载归档约 45–58 MB（因平台而异），解包后的单文件约 96 MB。
- **`qialike web` 另需**：系统里已装 `dsh` CLI（在 PATH 上，或设 `$QIALIKE_DSH` 指向它），且版本不低于本构
  建内嵌的 harness——版本不符时告警并打印安装命令，不一致则不启动 web（见「无头 / 远程访问」）。
- **内存**：建议 **≥1 GB**，512 MB 可用但偏紧（超长转录无 swap 余量），低于 512 MB 不支持。RSS 缓慢上升
  属 GC 策略而非泄漏；内存紧张时可用 `BUN_JSC_collectContinuously=1` 缓解。

### 终端颜色档位

颜色档位由 qialike 自动判断，通常无需设置。例外是**终端支持 24 位色、却不向程序声明**——已知 Ubuntu 24.04 的 GNOME Terminal/VTE 就是如此（不导出 `COLORTERM`），于是只按 256 色输出，深色方案下输入卡片的底色可能与页面糊成一片。qialike 在该档会自行映射调色板，让页面、面板与卡片保持可分辨，但拿不到主题原本的 hex。若你的终端确实支持 24 位，两种改法：

```sh
export COLORTERM=truecolor      # 标准信号，所有工具都认
# 或只对这一次运行：
QIALIKE_COLOR=24bit qialike
```

`COLORTERM` 只认 `truecolor` 这一个值——写成 `24bit` 不生效（那是 `QIALIKE_COLOR` 的写法）。`QIALIKE_COLOR` 也可取 `256` 或 `16`，用来预览低色终端下的效果。**16 色档**下深色方案的卡片与页面同为黑——调色板里没有第二个近黑色可选，属**设计上的降级**。

## 安全边界

- **写受限、读不限**：受限的 `bash`（Windows 上是 `pwsh`）在 OS 级沙箱内运行，**只有写**被约束在工作区内，
  读、网络与进程可见性不受影响。三个平台都开箱即用：Linux 优先用宿主的 bubblewrap，没有则落到 qialike 自带
  的 Landlock（需内核启用该 LSM，≥5.13），macOS 用系统 Seatbelt，Windows 用 harness 的 ACL
  restricted-token runner。
- **挡不住就拒绝**：沙箱无法强制时，`workspace-write` / `read-only` 下的 bash 直接 fail-closed，报
  `SANDBOX_UNAVAILABLE`（只有 `danger-full-access` 能跑）；执行器不提供内核隔离时，再由**逐次 shell 审批**
  兜底，提示会说明该命令拥有你的完整用户权限。
- **机密文件读不到**：`.env` 系列、`.git` 内部路径与 harness 凭据文档一律拒绝读取（`.env.example` 例外）。
  这条在任何沙箱模式下都生效，`danger-full-access` 也不解除。**它只拦读工具**：shell 命令里点名这些文件仍
  读得到——这是如实记录的缺口，Gemini CLI 同样存在。

**仓库 overlay 在启动时自动应用，所以它有自己的一套策略。** 仓库不等于你本人：
`git clone <仓库> && qialike` 不能悄悄跑起一个进程，也不能悄悄放宽你的沙箱。两条后果：

- **会 spawn 进程的行需要一次 per-repo 决定**：MCP server 行会在启动时执行它的 `command`，所以只有
  **这个文件**被显式信任时才生效——在仓库里跑 `qialike plugin trust-overlay`，把内容哈希与 harness 版本记
  进 `<profile>/overlays.trust.json`；文件一旦被改动就会重新询问，`qialike plugin list` 会显示状态。未
  信任时启动**直接拒绝**并给出修法。
- **安全类行一律拒绝**：改（或关掉）`sandbox` / `sandbox-policy` / `fs-sandbox` / `bash-sandbox` /
  `pwsh-sandbox` / `approval` / `permission` / `fs-observation-policy` 的行只能写在**你自己的** overlay
  里；仓库无权决定你的文件效果边界，信任也买不到它们。

仓库 overlay 生效时 hero 会明说（`⚠ repo overlay applied: …`）；`--no-project-overlay`（或
`QIALIKE_NO_PROJECT_OVERLAY=1`）这一次启动直接忽略该层；`qialike plugin list` 会打印该层、其中会跑进程的
行以及信任状态。

## 数据与责任

以下是 qialike 无法替你决定、但你应该知道的数据流向。

- **发给你选定的模型厂商**：每次请求都会把对话发给你在 `/models` 里选定的提供商——包括你的消息、agent 的
  工具调用，以及**工具结果**（agent 读到的文件内容就在其中）。qialike 让你在 62 家厂商中任选，因此
  **适用哪一家的隐私与保留政策取决于你选了谁**；qialike 无法代其作出承诺，请按所选厂商查阅。
- **harness 的反馈门控遥测**：组合 profile 默认挂载 `session-telemetry-otel`，模式为 `FEEDBACK_ONLY`，
  端点为 `https://harness-telemetry.deepseeksvc.com/v1/logs`。默认**不上传任何东西**——只有
  **新的显式反馈**才会释放一段截止该事件的有界会话前缀（可能包含消息文本、工具参数与结果、workspace 路径）；
  普通请求、生命周期事件与已存反馈都不触发。释放是**按提供方**进行的：即便你用第三方厂商，反馈仍发往上述
  DeepSeek 端点。关闭方式：`DSH_TELEMETRY_MODE=DISABLED`，或把 `DSH_TELEMETRY_DISABLED` 设为任意非空值（含
  `0`）。qialike 的 TUI **未接入 `/feedback`**（该命令注册在 harness 的 commands 服务上，本界面不消费它），
  所以目前没有可触发它的界面入口。
- **qialike 自身**：没有自有的分析或遥测。它自己发起的网络请求有三类——发给**你配置的提供商**（模型列表
  与对话请求）、**你主动执行 `/upgrade`** 时的版本检查与下载（GitHub / gitcode / qialike.com），以及**启动
  约 1 秒后的一次自动更新检查**（可用 `QIALIKE_DISABLE_AUTOUPDATE=1` 关闭，见「更新」）。API key 不会进入
  transcript、也不会发给模型。

## 从源码构建

**使用者不必构建**——装发布版二进制即可（见「安装为命令」）。自行构建的完整步骤，包括工具链、harness 检出与其
版本要求，见 [CONTRIBUTING.zh.md](CONTRIBUTING.zh.md)。

## 安装为命令

```sh
curl -fsSL https://qialike.com/install | bash      # 已发布二进制 → ~/.dsh/bin
# 参数（两种调用形式均可用）：
#   bash -s -- --version 0.6.0    安装指定版本（接受 v 前缀）
#               --no-modify-path  不改动 ~/.bashrc / ~/.zshrc
#               --dry-run         只打印计划，不做任何改动
qialike                  # 此后任意目录可直接执行
qialike --help
qialike uninstall        # 从二进制内部卸载：清空整个 qialike home（与 dsh 共用；$DSH_HOME，
                         #   默认 ~/.dsh——config、日志、主题、settings.yaml、sessions、
                         #   profiles、storages、attachments、exports、凭据 .credentials.yaml
                         #   及 ~/.dsh/bin 内的二进制），并移除安装器追加到
                         #   ~/.bashrc/~/.zshrc 的 PATH 导出行，以及旧版 ~/.local/bin/qialike
                         #   开发软链；凭据不会自动恢复，需重新填写 API key。
qialike web [flags]      # 打开 DeepSeek Harness 浏览器 UI（转发已安装的 `dsh web` CLI，Web
                         #   界面保持为 harness 自有实现）：需要 `dsh` 在 PATH 上
                         #   （`npm install -g @deepseek-ai/dsh`）或设置 $QIALIKE_DSH；
                         #   web 参数（--port/--no-open/...）原样透传
                         #   （--host 0.0.0.0 会被 web profile 拒绝）
```

安装目录固定为 `~/.dsh/bin`，**刻意不跟随 `$DSH_HOME`**：`qialike uninstall` 只扫 `$HOME/.dsh/bin` 与
`$HOME/.local/bin`。六个发布目标——`linux-x64`、`linux-arm64`、`darwin-x64`、`darwin-arm64`、`windows-x64`、
`windows-arm64`——解包工具由归档名决定（linux 用 `tar.gz`，其余用 `zip`）。Windows 安装为 `qialike.exe`；
其余平台会在写入任何东西之前按名字明确报错。

二进制在构建时已内嵌 DeepSeek Harness，因此 `qialike` 运行时**不需要** harness 检出、`pnpm` 或
`node_modules`——只需 `DEEPSEEK_API_KEY`（环境变量 / `~/.dsh` settings / `.env`）与一个工作区
（默认 `cwd`，或 `--workspace`）。会话状态、设置与凭据存放在 `~/.dsh`。

### Windows 终端（PowerShell / cmd）

Windows Terminal 里没有 bash，上面那条 `curl | bash` 用不了，只能手动安装：

1. 从 [Releases](https://github.com/qialike/qialike/releases) 下载 `qialike-windows-x64.zip`（ARM 设备选
   `-arm64`；镜像站点见 `gitcode.com/qialike/qialike/releases`）。

2. 解压得到单个 `qialike.exe`，放进 `%USERPROFILE%\.dsh\bin\`——`qialike uninstall` 只扫这个目录与
   `~/.local/bin`，放这里才能被它一并清除。

3. 把该目录加入**用户** PATH（系统设置 → 环境变量，或用下面这条 PowerShell），然后**重开终端**。

   ```powershell
   [Environment]::SetEnvironmentVariable('Path',
     "$env:USERPROFILE\.dsh\bin;" + [Environment]::GetEnvironmentVariable('Path', 'User'), 'User')
   ```

4. 启动后用 `/models` 添加提供商。

校验：`qialike --version`。上面四步是目前唯一途径——联网安装器只在 bash 下运行；若把 `qialike.exe` 放
在别处，`qialike uninstall` 不会替你删掉它。

## 更新

Linux 与 macOS **自动更新**：启动约 1 秒后，后台以子进程检查一次新版本（不阻塞界面，失败静默）。只有
**补丁版**（patch）会**静默安装**；**小版本**（minor）与 **大版本**（major）只在状态栏提示。

- **能被自动更新的前提**：二进制位于安装目录 `~/.dsh/bin`（即 `curl` 安装器装的那份）。自行编译的
  检出构建不会被替换，也不参与自动更新。
- **关闭或改为只提示**：设置项 `qialike-update.auto` 可取 `true`（默认，静默装补丁版）/ `false`（完
  全不检查）/ `"notify"`（只提示、从不自动装）；也可用 `QIALIKE_DISABLE_AUTOUPDATE=1` 全局关闭，或用
  `QIALIKE_ALWAYS_NOTIFY_UPDATE=1` 强制只提示。
- **手动更新**：`qialike upgrade` 升级到最新版、`qialike upgrade <版本>` 装指定版本、
  `qialike upgrade --check` 只报告不安装。TUI 内也可用 `/upgrade`。

**Windows 只能手动更新**：运行中的 `.exe` 无法被替换，安装器也是 bash，所以 Windows 上没有自动更新。
`qialike upgrade --check` 只检查并打印下载链接，更新方式即[手动安装](#windows-终端powershell--cmd)：
下载新 `.zip`、退出 qialike、替换 `qialike.exe`。

## 运行

装好后直接运行 `qialike`（从源码构建的产物在 `dist/qialike`）：

```sh
qialike                              # 开启新会话并显示 hero 首屏（从不自动续接）
qialike resume                       # 继续当前目录下最近一次会话
qialike --resume <sessionId>         # 恢复指定持久化会话
qialike --workspace ~/proj           # 在 ~/proj 下操作（其自身的会话）
qialike --model deepseek-flash       # 选择模型（DeepSeek V4.1 Flash）
qialike --help                       # 全部参数（--dump-config、--no-project-overlay 等）
```

关于续接：

- 裸执行 `qialike` 总是**开启新会话**并显示 hero 首屏，从不自动续接。
- `qialike resume` 继续**当前目录下**最近使用过的会话（最后活动时间优先），直接进入会话界面；该目录下尚无
  有内容的会话时，也进入会话界面而非 hero 首屏。
- 恢复某会话或向其发消息即标记为最近使用，状态行标注 `(resumed)`。显式 `--resume <sessionId>` 始终优先。
- 想让**每次启动都自动续接**，设 `~/.dsh/qialike.json` 的 `resume_last: true`（或环境变量
  `QIALIKE_RESUME_LAST=1`）——默认 `false`，即每次启动全新开始。

### 浏览器 UI 与无头 / 远程访问

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

#### 本机跑服务，别机浏览器访问

服务端保持默认回环绑定（`127.0.0.1`），从**有浏览器的那台机器**做 SSH 隧道即可——服务全程不暴露到网络，任何
网络下都可以照此使用。**不要**用 `--host 0.0.0.0` 直接对外提供：web profile 会拒绝
（`error: --host 0.0.0.0 is intentionally not supported yet …`）。隧道做法：

```sh
# 无头 / 纯终端主机上（无本地浏览器，故加 --no-open）
qialike web --no-open                  # 记下打印出的 http://127.0.0.1:3080/?token=… 这条 URL

# 在有浏览器的机器上
ssh -L 3080:localhost:3080 user@headless-host
# 然后在本机浏览器打开上面那条打印出来的 URL（http://127.0.0.1:3080/?token=…）
```

本机 3080 也被占用时，**只改本地映射**即可——服务端不用重启，token URL 也不变：
`ssh -L 8080:localhost:3080 user@headless-host`，再打开 `http://127.0.0.1:8080/?token=…`。只有**服务端**
3080 被占用时才需要 `qialike web --port <n>`，并同步改用新的隧道目标与 URL。

### 界面特性

- **斜杠命令面板**：输入 `/` 自动补全。命令：`/help`、`/models`、`/compact`、`/clear`、`/new`、
  `/sessions`、`/exit`。`↑/↓` 移动，`Enter` 执行，`Esc` 关闭。
- **`/compact`**：手动把当前会话的较旧历史压缩成一条摘要，与 web 界面共用 harness 的 `compaction` 服务。
  不接受参数（带参数会提示 `Usage: /compact (no arguments)`）；成功、无内容可压缩、失败各有对应提示。
- **`/plan` 规划模式**：agent 只规划不执行，直到计划经 `exit_plan_mode` 审批通过，或你执行 `/plan off`
  退出。`/plan <目标>` 进入的同时把目标作为消息交给 agent。
- **`/goal` 持久目标**：为长时间运行的任务设置一个完成目标。`/goal` 查看当前目标，`/goal <objective>`
  创建，`/goal edit <objective>` 修改，`/goal pause` / `resume` / `clear` 控制。创建后会自动逐轮朝目标工
  作，模型确认达成即停止续跑。
- **`/models` 模型选择**：全屏对话框，**两级导航**——第一级按供应商归类（每个已配置 key 的提供商一行，
  行尾标注模型数，如 `OpenCode Zen · 63 models`；当前模型显示在顶部），`Enter` 进入该供应商的
  **模型子列表**，`Esc` 返回。**各列表都支持打字即过滤**（顶部 `⌕ type to filter`），超页时 `PgUp`/
  `PgDn` 翻页、`Home`/`End` 首尾。在子列表选中模型后 `Enter` 保存，**下一次请求即切换**。
- **推理强度（reasoning effort）**：声明支持强度的模型在子列表按 `Enter` 会先弹出第三级 **Effort**
  选择框——**档位与默认档完全由该模型自己声明**（内置 DeepSeek 为 Off / Low / High / Max，默认 High），
  **确认强度后模型选择才算完成**。选中档位随选择持久化，并随每次请求下发；未声明支持强度的提供商不弹此步。
  主窗口随时按 **`Ctrl+T`**（终端占用该组合键时用 **`Alt+T`**）可循环切换，当前档位在 Model 标签与状态行
  高亮显示。
- **提供商与 API key**：`＋ Add provider` 列出**所有已知提供商**并标注 key 状态（`✓ key set` / `no key`）；
  已配置的 OpenAI 兼容提供商会显示网关**实时模型列表**。选中任一提供商可设置或替换其 API key，给休眠的
  模板路由设 key 会**当场激活**。列表里按 **`Ctrl+D`**（备用 `Alt+D`）可停用高亮供应商——
  **同步移除其 API key** 并使其从一级列表消失；隐藏的若是当前供应商会自动切换到其它已配置的，
  **若无任何可用供应商则当前模型显示 `not set`**，重新加入即再设一次 key。`＋ Add a custom provider`
  进入逐字段表单，可填自定义端点与模型 id。
- **`/theme` 配色方案**（vim 风格 `:colorscheme`）：裸 `/theme` 弹出**主题选择对话框**——`↑/↓` 移动、直接
  打字过滤、移动时**实时预览**、`Enter` 应用并持久化、`Esc` 取消并还原；也支持 `/theme <name>` 与
  `/theme <role> <hex>` 快捷路径。内置 **16 套**方案，另可放 `~/.dsh/themes/*.json` 自定义。
- **`/sessions` 会话管理器（唯一的会话选择入口）**：全屏对话框，列出**当前工作目录**的持久化会话（**标题**
  /id；按创建时间倒序、按日期分组为 `Today` / `Yesterday` / 日期组头）。**打字即过滤**（标题/id/cwd）；
  `Enter` 恢复、`Ctrl+R` 改名（本地持久）、`Ctrl+F` 置顶/取消置顶（置顶会话在顶部 `📌 Pinned` 组）、
  `Ctrl+D` 删除（两次确认，当前会话受保护）、`Esc` 两级退出；超页支持 `PgUp`/`PgDn`/`Home`/`End`。每行的
  标题即该会话**第一个任务的摘要**。该对话框只承载历史会话——开启全新会话由 `/new` 负责。
- **`/new` 新会话**：就地开启一个全新会话（取消当前回合、创建新 agent、拆除旧 agent）。当前模型选择与工
  作目录保留；之前的对话仍可从 `/sessions` 或 `--resume` 找回。
- **`/export` 会话导出**：裸 `/export` 弹出**导出对话框**（格式 JSON/Markdown、文件名可编辑、脱敏开关）；
  也可带参数直达——`/export <sessionId>` 指定会话、`--markdown` 切换格式（默认 JSON）、`--sanitize` 脱敏
  （文本与工具输出替换为 `[redacted:…]`）、`--output <名称>` 自定义文件名（可含子目录）。写入
  **工作区根目录** `export-<时间>-<id>.(json|md)`，状态行显示路径。
- **`/sidebar` 右侧栏开关**：右侧 **Steps** 面板（`session <id>` + `Steps X/Y` 进度 + 步骤清单；模型未用
  `todo_write` 时显示 `no plan yet`）在终端宽度 ≥110 列时自动显示。无参 `/sidebar` 循环 `auto → on → off`，
  `/sidebar on|off|auto` 直接设档，
  **鼠标点击 Steps 标题栏**同样可切换；选择持久化到 `~/.dsh/qialike.json`。
- **布局**：对话列（转写区 + 底部输入框）+ 右侧 Steps 面板。
- **运行状态"活性指示"（界面不会"看起来像卡死"）**：agent 运行期间，底部状态栏持续显示**相位与经过秒数**
  ——`⠙ thinking · 12s · Esc to pause`（模型思考）、`⠴ answering · Ns`（正文流式）；工具调用时显示当前工
  具名（并行折叠为 `name ×n`），事件静默 ≥4s 会标出 `Ns since last event`。工具行完成后默认
  **折叠为摘要卡片**（如 `✓ bash · ls -la …`、`✓ todo_write · 3/5`），**鼠标点击该行**或 **`/think`** 可
  展开/收起完整结果（完整内容始终保留在会话日志）。若模型输出达到长度上限且未产出正文，对话区会给出明确
  提示，可发送任意消息继续或用 `Ctrl+T` 调低推理档。
- **用户提问弹窗（`ask_user_question`）**：一次询问含多题时用**单卡片**逐题作答——标题显示
  `Ask question k/N`，每题一个可点击 Tab（已答 `✓`、当前 `[n]`）；答题后自动进入下一题、`←/→` 回看改答、
  全部答完一次提交、`Esc` 取消整批。选 **Other…** 时在选项列表正下方行内输入。问题与选项
  **完整换行不截断**，内容超高时弹窗内部滚动。
- **审批对话框**：某工具请求审批时，带内弹窗显示工具名与原因。`y`/`a` 允许一次，`n`/`Esc` 拒绝。在沙箱无
  法强制的主机上，逐次 shell 审批即由此对话框承载。
- **工具行运行中活性**：Bash/Read/Write 等工具**执行期间**该行动态显示——行首转圈、行尾实时耗时 `· Ns`，
  完成后回到静态图标行并可点击展开结果。

### 工具（模型可调用）

- **`delete` / `move`**：在工作区内删除、重命名或移动文件与目录。harness 内建的文件工具只能创建、覆写与
  编辑，不能删除或改名，这两个由 qialike 补上。**围栏**：只能在**工作区根内**操作，**拒绝工作区根本身**，
  `move` 的**两端**都要在工作区内；`read-only` 下拒绝，`danger-full-access` 下放行。`delete`
  **不可撤销**（没有回收站），删除非空目录需显式 `recursive: true`；创建文件则无需 `mkdir`，父目录会自动
  建好。
- **`glob` / `grep`**：按路径模式查找文件、按内容搜索。两者由随包携带的 ripgrep 驱动，**开箱即用**——无需
  另行安装 ripgrep，也无需配置路径。

## 插件化架构（"一切皆插件"）

qialike 的一切都是插件——界面本身也是。因此**扩展不需要重新编译**，两条通道都只吃数据文件：

- **Skills**：把技能包放到 `$DSH_HOME/skills/<name>/SKILL.md`（或项目的 `.dsh/skills/`、
  `.agents/skills/`，或 `~/.agents/skills/`），harness 会自动发现，没有开关要开。
- **MCP server**：`qialike plugin add-mcp <名字> <命令> [参数...]` 把 stdio MCP server 追加到你的
  overlay；其工具随即以 `mcp__<名字>__<tool>` 出现在模型面前。`remove-mcp` 删除该行。

`qialike plugin` 可以代你操作这些文件，不必手写 YAML：

```sh
qialike plugin list [--available]   # 各层与其中的行；--available 再列出本构建打包的全部插件
qialike plugin add-mcp <名字> <命令> [参数...] [--project]
qialike plugin remove-mcp <名字> [--project]
```

`--project` 作用于**仓库级** overlay（`<repo>/.dsh/tui.cordis.patch.yml`）而非你个人的那份。启用或禁用内
建行不需要命令：写一条**不带** `insert`、内容为 `disabled: true` 的行按 `id` 覆盖即可。
`qialike --dump-config` 会打印各层组合结果与每个插件的来源层。

### 提供商目录与推理强度声明

`/models` 的 `＋ Add provider` 列出**所有已知提供商**——自研适配器的内置模板加上可加载的网关子插件，共
**62 家**（61 家模板 + 内置 `deepseek-official` 官方端点）。其中三组由**可加载子插件**提供，都默认开启、
可整体卸载：在 `qialike.json` 写对应开关，模板与已配置路由会一并从 `/models` 与适配器消失。

| 子插件 | 开关 | 提供商 |
| --- | --- | --- |
| `tui-opencode-gateways` | `qialike-opencode: { enabled: false }` | OpenCode Zen / Go |
| `tui-china-gateways` | `qialike-china-gateways: { enabled: false }` | 七牛、硅基流动（含 cn 端点） |
| `tui-foreign-gateways` | `qialike-foreign-gateways: { enabled: false }` | OpenRouter、Vercel AI Gateway、Cloudflare、Hugging Face、Baseten、Fireworks AI、Together AI、Nvidia、Groq、Cerebras |

以 OpenAI 兼容协议为主，Anthropic 与 MiniMax 走原生 Messages 协议。DeepSeek 官方端点不在模板目录里，由内
置 `deepseek-official` 默认路由提供（3 个模型，免配置即用）。另有部署型端点（Vertex AI、Databricks、
Snowflake Cortex，以及插件提供的 Azure 与 Cloudflare 行）标记 `endpoint required`。

已配置的 OpenAI 兼容提供商会显示网关**实时模型列表**（动态 `GET {baseURL}/models`，失败或超时回退模板预
置模型）；OpenCode Zen 是单个条目，展示全部 63 个模型，选中任一模型保存后，请求时按模型自动路由到正确
协议端点——`claude-`/`qwen-` 前缀走 Anthropic messages、`gpt-`/`grok-`/`muse-` 走 OpenAI Responses、
`gemini-` 走 Google generateContent，其余走 chat/completions，四种认证均已实测通过。

**推理强度**的档位集同样由数据驱动：优先用提供商与模型的**静态声明**；只有端点确认接受
`reasoning_effort` 的路由（模板声明 `effortWire: 'reasoning-effort'`，默认仅内置 DeepSeek）才会用随包携
带的 models.dev 风格目录快照（`src/effort-catalog.ts`）补全未静态声明的模型。因此不同供应商的档位可以不
同，列表展示、默认档预选、`Ctrl+T` 循环与请求下发都按该模型自己的声明走。

API key 经 credentials 服务写入 `~/.dsh/.credentials.yaml`（按各提供商的引用名）按需解析，环境变量同名时
优先。声明支持图片输入的模型（如 DeepSeek V4 Flash Vision Exp、GPT-4o、Claude）可接收会话中附带的图片，
适配器转成 OpenAI `image_url` parts 或 Anthropic base64 source 块。

## 文件放在哪里

| 路径 | 内容 |
| --- | --- |
| `~/.dsh/bin/qialike` | 程序本体。安装目录固定在此，**刻意不跟随 `$DSH_HOME`** |
| 工作区（默认 `cwd`） | agent 读写的地方；`/export` 的输出也写到这里 |
| `~/.dsh/qialike.json` | 本界面的设置：`resume_last`、`sidebar_mode`、`hidden_providers` |
| `~/.dsh/settings.yaml` | harness 设置 |
| `~/.dsh/.credentials.yaml` | 各提供商的 API key |
| `~/.dsh/sessions/` | 会话日志，与 `dsh` 及 web 界面共用同一份 |
| `~/.dsh/themes/*.json` | 自定义配色方案 |
| `~/.dsh/profiles/tui/cordis.patch.yml` | 你自己的 overlay（挂 MCP、启用/禁用内建行） |
| `~/.dsh/skills/` | 技能包（也可放项目的 `.dsh/skills/`） |
| `~/.dsh/qialike.log` | 出错与崩溃日志；超过阈值轮转为 `.log.1` |

`qialike uninstall` 会清空 `~/.dsh`（**含上面的凭据**），见「安装为命令」。

## 故障排查

按你看到的现象查；每条末尾指向展开说明的章节。

**`qialike: command not found`（刚装完）**：PATH 写进了 profile，但当前 shell 还没读到——
  `source ~/.bashrc`（zsh 用 `~/.zshrc`）或**重开终端**。见「快速使用」第 1 步。

**`Model: not set` / 首屏提示 `No provider yet`**：还没配模型，或已配的都被隐藏了——`/models` 里添加或重新
  设 key。见「界面特性」。

**`Terminal too small — keys paused`**：终端高度不足，此界面最小需要 **14 行**（宽 ≥110 列才显示右侧栏）
  ——把窗口调高即可，按键会自动恢复。

**`SANDBOX_UNAVAILABLE`**：本机两级沙箱（bubblewrap / Landlock）都无法强制，`workspace-write` /
  `read-only` 下 bash 直接拒绝——改用文件工具，或（知情前提下）切到 `danger-full-access`。见「安全边界」。

**深色方案下输入卡片与页面糊成一片**：终端支持 24 位色却没声明，qialike 落到 256 色档——设
  `COLORTERM=truecolor` 或 `QIALIKE_COLOR=24bit`。**16 色终端**下这是已知降级，无法修复。见
  「终端颜色档位」。

**`401 dsh web authentication required`**：用了不带 token 的地址——用服务启动时打印的那条 URL，且别在
  `127.0.0.1` 与 `localhost` 之间切换。

**`EADDRINUSE`**：端口被占。**服务端**冲突用 `qialike web --port <n>` 换端口；**只在本机**冲突则只改 SSH
  映射即可（`-L 8080:localhost:3080`），服务端不必重启、token URL 也不变。

**`SessionPersistenceCorruptionError`**：系统里的 `dsh` 比本构建内嵌的 harness 旧——升级它（
  `npm install -g @deepseek-ai/dsh`）。见「安装为命令」。

## 问题反馈与参与

- **报告问题 / 提需求**：[GitHub Issues](https://github.com/qialike/qialike/issues)。
- **参与开发**：见 [CONTRIBUTING.zh.md](CONTRIBUTING.zh.md)——构建前提、测试与校验命令、插件编写与信任契约、提交规范。
- **报告漏洞**：**不要**走公开 issue——见 [SECURITY.zh.md](SECURITY.zh.md)：私密渠道、受理范围，以及哪些行为属于设计而非缺陷。
- **看改了什么**：[CHANGELOG.zh.md](CHANGELOG.zh.md) 从 0.6.0 起记录；更早的版本见
  [releases 页](https://github.com/qialike/qialike/releases)。

## 致谢

qialike 基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 构建。qialike 是独立的社区
项目，与深度求索不存在隶属、合作、授权或背书关系。"DeepSeek Harness" 是深度求索公司的注册商标，此处仅用于准
确说明技术来源及与上游软件的关系。

## 许可证

[MIT](LICENSE)

**名称与字标不在许可证授权范围内**：MIT 授予的使用、修改与再分发权利只覆盖**软件本身**，不包含对
`qialike` 名称或字标的任何授权——它们仅用于标识本项目。再分发或修改代码时，请勿暗示官方背书或合作。

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
