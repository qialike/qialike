# 贡献指南

[English](CONTRIBUTING.md) | 中文

本仓库是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 之上的 TUI bundle，以
[MIT](LICENSE) 许可发布。**使用者不必构建**——装发布版二进制即可，见 [README.zh.md](README.zh.md) 的
「安装为命令」。

## 构建

前提：

- Node.js `^22.19 || >=24`，bun **`>= 1.4.2`**（供 `bun build --compile` 打包与 `pnpm test:unit`）。
  这条 bun 下限不是形式要求：`--compile` 会把**构建机上的 bun 运行时**烘进每一个目标产物，而 1.3.x
  构建出的 Windows 二进制会在首次模型调用前就结束每一轮 —— 所以构建脚本会直接拒绝更旧的 bun。
- 一份 **DeepSeek Harness 检出**，且**该检出本身已构建**（在其目录里先跑 `pnpm install && pnpm build`）——
  qialike 的构建直接读各包已构建的 `lib/`，未构建会失败。位置用 `DSH_HARNESS` 指定，默认
  `../deepseek-harness`。
- 该检出须落在构建脚本强制的版本区间内。**该区间的唯一事实来源是 `apps/tui-bin/build.mjs`**
  （`HARNESS_VERSION_MIN` / `HARNESS_VERSION_MAX`）—— 请去那里读，不要相信任何文档里写的数字，包括本文。
  CI 在 `HARNESS_REF` 里钉同一个发布版；抬高上限时，先用新版本验证，再把两者一起改。

### 安装与构建 DeepSeek Harness

```sh
cd yourpath
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
git checkout dsh-v0.1.7-rc.2   # 检出的版本应与 qialike 支持的版本相同
pnpm install
pnpm run build
```

### 安装与构建 qialike

```sh
cd yourpath
git clone https://github.com/qialike/qialike.git
cd qialike
pnpm install
pnpm build        # 产出 dist/qialike（单文件可执行）
```

> 两个检出必须放在**同一个父目录**下，`../deepseek-harness` 这个默认值才成立；否则请用
> `DSH_HARNESS` 指向你的 harness 检出。

`pnpm build` 同时会建出解析农场（`node_modules/@deepseek-ai/*` 以及本仓库自己的 scope），单元测试在运行时
正是通过它 import 的。**请在 `pnpm test:unit` 之前先跑构建**，否则那些 import 了 harness 包的测试会解析
失败 —— 那不是你的改动弄坏的。

## 测试与校验

| 命令 | 作用 |
| --- | --- |
| `pnpm test` | 冒烟：在打包后的二进制里启动真实的 `dsh-base` + `qialike-app` 组合树并解析 TUI 命令面，**无需 API key**；需先 `pnpm build` |
| `pnpm test:unit` | 单元测试（`bun test tests/`）；需先 `pnpm build`（见上） |
| `pnpm typecheck` | 类型检查 |

交互式 token 流式输出需要 TTY 与提供商 key，因此冒烟测试止于 `--help`。`pnpm typecheck` 会报 **3 处既有的**
`wrap-ansi` TS7016（缺类型声明）；非零退出是基线，只看新增错误。

**CI 只覆盖上面这些命令，仅此而已。** 官方构建所用的发布门还会跑一套真机 pty 套件（52 个场景，每个约 17 分钟，
在真实终端里驱动打包后的二进制、配一份预置 `$HOME`）以及一次文档审计。**该套件当前不在本仓库内**——它位于维护者
的发布工作区——所以 CI 无法替你跑它，**CI 全绿本身不等于可以发版**。请把「本仓库里没有这套件」当作一个已知缺口，
而不是把 CI 的结论信到超出它的范围。它缺失也不阻塞你的改动：CI 里没有任何一环依赖它。

**发布脚本在本仓库内**，位于 `scripts/release/` —— `build-qialike.sh`（升版、编译、可选打标签与归档）、
`tag-qialike.sh`（提交与 annotated tag）、`release-archive.sh`（源码 `.tar.gz` / `.zip`）、
`push-qialike-release.sh`（把 6 个二进制与 `sha256sums.txt` 上传到两个发布源）。官方发布跑的就是它们，
所以你可以读到一次发布究竟做了什么，也能复现打包过程。你无法复现的是它们所依赖的那套 pty 套件。

`push-qialike-release.sh` **不含任何凭据** —— 令牌只从环境变量 `GITHUB_TOKEN` / `GITCODE_TOKEN` 读，
所以它与其余三个放在一起是安全的。它是唯一需要那两个令牌的一步，且普通编译绝不会触发它。

## 贡献

- **许可**：贡献按本仓库现行的 [MIT](LICENSE) 许可接收（inbound = outbound）。提交 pull request 即表示你
  确认有权按该条款提交这份工作；没有单独的 CLA 需要签。
- **安全**：漏洞**不要**开公开 issue —— 见 [SECURITY.zh.md](SECURITY.zh.md)。
- **提交**：沿用 Conventional Commits（见文末）。一个改动要能独立评审；历史按主题合并，不按作者。

## 仓库布局

```
packages/qialike-app/   bundle：cordis.patch.yml + startup/index/invariant 插件
apps/tui-bin/           src/bin.ts（SEA/bun 启动器）+ build.mjs
scripts/release/        发布脚本（CI 不跑它们，见「测试与校验」）
packages/qialike-app/repro-*.mjs
                        真机渲染缺陷用的 headless 复现装置
examples/cordis.yml     一处部署 overlay：固化模型与工作区
tests/smoke.mjs         无 key 的 REAL-composition 启动冒烟
```

`cordis.patch.yml` 在 `dsh-base` 之上，OS 级沙箱行在所有平台都已启用。单文件里要把 Windows 那一档跑起来，
有两样必须自带：它依赖的原生 `koffi`（由 `apps/tui-bin/stub/koffi.js` 顶替），以及 **runner 进程本身**——
harness 用模块 specifier 定位它，而编译后的二进制答不了这个调用，于是 qialike 把 harness 自己的 runner
一并携带并充当其 launcher（见 `apps/tui-bin/src/windows-acl-shim.ts`）。`permission`（presets）行因此在
所有平台都已启用。用户可见的安全行为见 README 的「安全边界」。

## 作为插件 bundle 分发

**本仓库当前不经 npm 分发**——二进制只由 `curl | bash` 安装器与 GitHub/gitcode Releases 提供，从不需要 npm。
下面这条路径因此**当前不可用**，保留它只为说明架构上存在的能力，以及启用它还需要什么。它是生态最主要的
发现通道（插件市场、`awesome-*` 榜单、`dsh plugin add`），所以关掉它是个分发决策，不是细节。

`@qialike/qialike-app` 是一个树外（out-of-tree）Cordis bundle；各包现已使用 `@qialike` scope，
所以它会长这样：

```sh
dsh plugin --profile tui add @qialike/qialike-app
dsh --profile tui --workspace ~/proj
```

`dsh plugin add` 通过安装目录的 `profiles/node_modules` fallback 解析 `@deepseek-ai/*` peer 依赖，因此消费
方用的是**已安装的 harness**，而不是本检出。

目前仍挡在这棵树与那条命令之间的东西（这是现状记录，不是待办清单）：

- **scope 必须真的在注册表上被本项目控制。** 三处 `package.json` 的 name 是 `@qialike/qialike-root`、
  `@qialike/qialike-app`、`@qialike/qialike-bin`；只有当 npm 上的 `@qialike` scope 归本项目所有，
  发布才成立，且 `npm view @qialike/qialike-app` 必须不再返回 404。
- **根包是 `private: true`**，所以 `npm publish` 在根目录会被直接拒绝。这是对的——只有
  `packages/qialike-app` 是可发布的 bundle——但意味着发布必须在该目录里执行（或用 `--filter`），
  绝不能在根目录执行。
- **所有 peer 依赖都声明 `^0.1.1`，而 npm 的 semver 下 `^0.1.1` 不接受预发布版本。** 构建所针对的 harness
  是预发布版，所以 `semver.satisfies(<该版本>, "^0.1.1")` 为 `false`；消费方安装这个 bundle 时，peer 会被
  报为未满足。要修，要么把声明的范围放宽到实际的预发布版本，要么等 harness 脱离预发布后改用正式的 caret 范围。
- harness 本身**已在 npm 上架**（`@deepseek-ai/dsh`）——这一项不是障碍。

## 编写自己的插件

overlay 只能挂**打进本二进制**的插件。要跑自己的插件，把它当作普通包装进 profile 再显式信任：

```sh
# 1. 放到加载器查找的位置（npm install / pnpm 均可；软链也行）
#    ~/.dsh/profiles/tui/node_modules/my-plugin/{package.json,index.cjs}
#    module.exports = { name: 'my-plugin', inject: [], apply(ctx) { … } }
# 2. 在 overlay 里引用：  - insert: [{ id: my-plugin, name: 'my-plugin' }]
# 3. 审阅之后记录这次决定（hash + harness 版本）
qialike plugin trust my-plugin
```

加载器强制三件事：插件必须位于 `<profile>/node_modules` **之内**（软链会做 realpath 校验）；必须针对
**本二进制内嵌的 harness 版本**被信任（升级后会重新询问）；信任之后插件**自身**的文件**不得变化**——任何
改动都会让信任失效（`node_modules/` 与 `.git/` 刻意不在哈希内：重装依赖不算篡改，所以哈希覆盖的是你审阅过
的代码，不是它拉进来的依赖树）。本地插件**在本进程内以完整权限运行**，所以信任是显式、逐个、可撤销的
（`qialike plugin untrust <name>`）。

overlay **最后应用**，所以**不带** `insert` 的行还能按 `id` 改内建行（换 persona、关掉某个工具）。两种写错
会被明确拒绝并给出原因——插件加载器自己对这两种都是静默的：`insert` 里写了本构建未打包的插件，或行的 `id`
匹配不到任何内建行。

界面由 Cordis 插件组合而成（与 harness 一致）：`tui-startup`（CLI 参数）、`tui-llm`（自研供应商层）、
`tui-models`（提供商枚举 / Add-provider 写入）、`tui-runtime`（内核：Store、面板注册表、按键分发、agent
接线），以及向 `tui` 服务注册的功能插件——`tui-panel-conversation`（主界面）、`tui-panel-approval`、
`tui-panel-question`、`tui-panel-models`（`/models` 对话框）、`tui-sessions`（`/sessions` 对话框）、
`tui-export`（`/export` 对话框）、`tui-new`（`/new` 就地切换会话）。第三方插件通过 `ctx.get('tui')`
（`panels.register` / `commands.register` / `notify`）与 `ctx.get('tuiStore')` 接入；插件契约与示例见
`packages/qialike-app/src/panels/`。

## 提交信息

沿用 Conventional Commits：`type(scope): 说明`；破坏性变更在 type 或 scope 后加 `!`（如
`refactor!: rename dsh-tui to qialike`）。仓库内最常用的是 `fix`、`feat`、`chore`。
