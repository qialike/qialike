# 更新日志（Changelog）

[English](CHANGELOG.md) | 中文

qialike 的主要变更，最新在前。本文件从 **0.6.0** 开始记录。

版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。由于内嵌的 DeepSeek Harness 仍是开发者预览，
minor 升级可能包含不兼容变更 —— 这类变更以 `!` 标出。

## [0.9.1] - 2026-10-01

### 变更

- **Releases 页现在会列出改了什么。** GitHub 与 GitCode 上的发布说明由本文件生成，标签自身的附注也带同一份内容 —— 于是 `git show <tag>` 读到的是一条更新日志，而不再只是一个版本号。
- **Windows 上不再依赖构建目录即可使用 Shell。** 内嵌的 `koffi` FFI 绑定此前在运行时按进程的工作目录解析，因此发布版只要旁边没有 `node_modules/koffi` 就会拒绝每一条受限命令；现已改为编译期内嵌。
- 版本号抬升到 0.9.1。

### 修复

- **遥测的关闭开关现在真的生效。** `DSH_TELEMETRY_DISABLED` 此前只传到 profile context 就停了 —— 启动路径上没有任何读取点 —— 于是两份 README 承诺了一个不起作用的退出方式；现在启动器把 harness 自己的规则应用到它构建的那份补丁栈上。
- **`pnpm typecheck` 不再因已知基线而失败。** 它此前会因那 3 处 `wrap-ansi` 声明错误而非零退出，而 CI 跑的是不带该规则的裸 `tsc`，还会在本来正常的文件里报 `Cannot find module '@deepseek-ai/cordis'`（harness 的检出位置不是 `tsconfig.typecheck.json` 解析的位置）；现在两者共用同一份策略，前置缺失时会指出是哪一条。
- **粘贴不再打死键盘，也不会把光标留在输入框之外。** 括号粘贴的终止符一旦丢失，解码器就会永远等它、把之后每个按键（含 Ctrl+u 与 Ctrl+C）都吞掉；而粘贴一条命令会让补全面板停在未过滤的完整列表并盖住输入框那一行，光标随之落在那上面；两者均已修复，回收以容量与静默为界。

## [0.9.0] - 2026-10-01

### 变更

- **重建于 DeepSeek Harness `0.2.0-rc.2`**（原 `0.1.7-rc.2`）；无需移动补丁锚点、无需改动源码，插件说明符 124 → 125。
- **新增的 `otel` 行是承重的，故两行遥测都保持启用** —— `session-telemetry-otel` 现在注入它，单独禁用该行会让遥测*静默失效*。
- **遥测默认端点改为 `https://dsh-otel-collector.deepseeksvc.com/v1/logs`**（原 `harness-telemetry.deepseeksvc.com`），该行另新增 `maxRequestBytes` 上限。

## [0.8.3] - 2026-09-28

### 变更

- **`qialike uninstall` 不再重复、也不再自相矛盾** —— 保留的安装目录及其删除命令只报告一次，除 `bin/` 外一无所有的 home 也不会自称无事可删。
- **npm 包页面不会再过期** —— 版本示例改回由 `scripts/release/publish-npm.sh` 替换的 `0.0.0-template` 占位符，该脚本在 README 写死版本或丢失占位符时会拒绝发布。
- **安装文档补上了 npm 途径缺失的前置条件**（Node.js ≥ 18、装完重开终端），并建议在 Windows Terminal 里运行，而不是旧控制台窗口。
- **两份 README 新增「卸载」小节** —— 四条安装路径共用同一条两步流程，并写明那个顺序陷阱：先删程序会让 `~/.dsh` 留在盘上而无命令可清。
- **「更新」章改为按安装方式组织**，于是「npm 装的怎么更新」由一张表回答。
- **`qialike upgrade` 现在认得出 npm 安装**，给出 `npm i -g @qialike/cli@latest`，而不是那种副本里根本没有的 `.zip`。
- **npm 安装在 Windows 上可以自动更新** —— 补丁版由 `npm install -g @qialike/cli@<精确版本>` 静默安装，小版本与大版本只提示，仍受 `qialike-update.auto` 管辖。
- **`qialike uninstall` 也会给出 npm 的移除命令** —— `npm uninstall -g @qialike/cli`。

## [0.8.2] - 2026-09-27

### 变更

- **`qialike uninstall` 保留安装目录** —— 它清空 harness home（`$DSH_HOME`，默认 `~/.dsh`）下除 `<home>/bin` 之外的一切，并打印可彻底移除它的平台命令。
- **移除改名前的 `dsh-tui` 兼容层** —— 状态文件、settings 段名、`DSH_TUI_*` 环境变量与旧插件标识符都不再被迁移或读取。

## [0.8.1] - 2026-09-26

### 变更

- **新增 Windows 的 npm 渠道：`npm i -g @qialike/cli`**（Windows Terminal 没有 `bash`，shell 安装器在那里跑不了）—— 几 KB 的启动器，加上每个架构一个由 `os`/`cpu` 限定的 `optionalDependencies` 包（`@qialike/cli-win32-x64`、`@qialike/cli-win32-arm64`）；**仅限 Windows，这是刻意的**。
- 版本号抬升到 0.8.1。TUI 与 harness 均无面向用户的变化。

## [0.8.0] - 2026-09-26

### 变更

- **重建于 DeepSeek Harness `0.1.7-rc.2`**（原 `0.1.7-alpha.2`）；无需移动补丁锚点，插件说明符 123 → 124。
- **TUI 组合中禁用 `llm-deepseek-account`** —— 上游把 DeepSeek 供应商插件一分为二，而新增的账号令牌路由在终端客户端里没有登录入口。

## [0.7.2] - 2026-09-25

### 修复

- **两个宿主不再能同时往同一份会话日志里追加** —— harness 的文件锁曾被换成空操作桩，于是与 `dsh web` 或第二个 qialike 共用 `~/.dsh/sessions` 时会交叉追加到会话拒绝打开；该桩现已改为真实的非阻塞 `flock(2)`。
- **另一进程正在写的会话，删除会被拒绝** —— `/sessions` 先以只读方式探测租约，并指明持有者。
- **"已被占用"现在给出可执行的指示**，而不是把 harness 的原始错误照搬出来。
- **`qialike web` 会拒绝被更新版 harness 迁移过的会话仓库**，并指名道姓地点出那个 `session.vN` 文件。
- **首次发布不再死锁** —— 现在按 HTTP 状态码判定，而不是把 `404 Not Found` 的响应体读成"发布已存在"。

### 变更

- **侧栏脚注不再显示内嵌 harness 的版本号**，脚注预留行数因此由 3 行减到 2 行。
- **默认的"全目标"构建又能跑冒烟了** —— `tests/smoke.mjs` 原先硬编码 `dist/qialike`，而 `BUILD_TARGETS=ALL` 根本不产这个文件；现在按 `$QIALIKE_BIN` → `dist/qialike` → 宿主目标三级解析。
- **发布测试拆成两半** —— 仓库内是 `scripts/release/test-required.sh`，真机/PTY 套件（`~/deepseek/cli-test/full-suite.sh`）留在仓库外、选做。

## [0.7.1] - 2026-09-23

### 新增

- **安装器会校验下载到的东西** —— 每个发布版都在 6 个二进制旁附一份 `dist/sha256sums.txt`，摘要不符直接拒绝，而不是解包。

### 修复

- **这段校验早就写好了，但从来没执行过** —— 清单缺失、以及清单里没列出该资产，都被当成"无需校验"；**本版之前的发布版都没有清单**，因此从它们安装会被拒绝，除非设 `QIALIKE_ALLOW_UNVERIFIED=1`。

### 变更

- 发布脚本现在就在本仓库的 `scripts/release/` 下，所以"官方发布做了什么"可以读，而不是靠猜。

## [0.7.0] - 2026-09-23

### 变更

- **重建于 DeepSeek Harness `0.1.7-alpha.2`**（原 `0.1.5-rc.2`，跨 3,148 个上游提交）。
- **设置迁入 `qialike.json`**，因为 0.1.7 移除了运行时设置命名空间；一次性迁移**绝不覆盖你已有的值**，该文件权限为 `0600`。

### 修复

- **插件信任闸恢复为致命** —— 0.1.7 曾把**可选**启动条目的失败降级为告警，信任检查因此被悄悄变成"仅供参考"。
- **一个无关会话的日志不可读，不再打死 resume** —— qialike 会指出那个文件并让你要恢复的会话保持完好；**你请求恢复的那个**日志不可读仍然致命。
- 损坏/截断的会话文件按 0.1.7 的容忍方式处理，不再中止启动。

## [0.6.4] - 2026-09-23

### 新增

- **子框内拖拽框选并拷贝** —— 问题子框、审批子框、命令面板与 `@file` 弹窗；选区取自**帧缓冲**，所以框**背后**的会话内容绝不会被拷走。三个**全屏**面板（`/models`、`/theme`、`/sessions`）刻意不做。

### 修复

- **拷贝会丢掉所有以反显绘制的行** —— 现在"取文本"与"加高亮"分开判定。

## [0.6.3] - 2026-09-22

### 变更

- hero 那行改为 `Ver: <版本> <通道> . URL: <站点>`，产物因此能自报版本与构建通道，不必再跑 `--version`。

### 修复

- **macOS 上 `curl … | bash` 会中止** —— bash 3.2 在 `set -u` 下把空数组的 `"${arr[@]}"` 当成未绑定变量，而那个数组**恰好只在成功路径上为空**；现在每一处展开都加了护。

### 文档

- 两份 README 按用户实际会做的事重写，并补齐了中英配对的 `CONTRIBUTING`。

## [0.6.2] - 2026-09-21

### 新增

- **Windows：只检测、只提示的更新通知** —— 它替换不了正在运行的 `.exe`、也没有 `bash`，现在**把这件事说出来**而不是静默失败。
- **安装器改为测量后选发布源**，因为"可达"的源照样可能龟速；`--source github|gitcode|auto` 可钉住选择。
- **选源是四例决策，且有顺序**：只有 GitHub 通 → GitHub；只有 gitcode 通 → gitcode；都通 → 量吞吐取最快；都不通 → 停止并保留已装版本（退出码 3，不算错误）。

### 修复

- **绝不把更旧的 tag 当成更新** —— 否则源报出一个**更旧**的版本时会静默覆盖更新的安装。
- **Windows 上 GitHub 明明可用却选了镜像**，因为探测用了 `-o /dev/null`，而 Windows 的 curl 不把它映射到空设备。

## [0.6.1] - 2026-09-21

### 新增

- **镜像回退：GitHub 不可达时改用 gitcode** —— **连得上但传不动**也会被放弃。
- **安装器与升级链的端到端测试**，对着一台真实本地发布主机跑。

### 修复

- **更新器解析版本时没走注入的环境**，于是把调用方指向一台发布主机、却拿到另一台的答案。
- 用 `--base-url` / `QIALIKE_INSTALL_BASE_URL` 钉住的源仍是**恰好一个源、不附加回退**。

## [0.6.0] - 2026-09-20

### 变更

- **安装器改为联网下载器** —— `curl -fsSL https://qialike.com/install | bash` 拉取已发布二进制而不是落位本地构建，安装到 `~/.dsh/bin`。
- **发布 6 个目标** —— Linux、macOS、Windows，各含 x64 与 arm64；Windows 装为 `qialike.exe`，`.zip` 归档需要 `unzip`。
- 刻意按 minor 升：这一版改变的是 qialike 的**交付方式**。

### 新增

- **自动更新** —— 命令行 `qialike upgrade`、TUI 内 `/upgrade`，启动后不久还会后台检查；patch 静默安装，minor 只提示，`QIALIKE_DISABLE_AUTOUPDATE=1` 可整体关闭。
