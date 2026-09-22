# 贡献指南

[English](CONTRIBUTING.md) | 中文

本仓库是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 之上的 TUI bundle，以
[MIT](LICENSE) 许可发布。**使用者不必构建**——装发布版二进制即可，见 [README.zh.md](README.zh.md) 的
「安装为命令」。

## 构建

前提：

- Node.js `^22.19 || >=24`，bun（供 `bun build --compile` 打包与 `pnpm test:unit`）
- 一份 **DeepSeek Harness 检出**，且**该检出本身已构建**（在其目录里先跑 `pnpm install && pnpm build`）——
  qialike 的构建直接读各包已构建的 `lib/`，未构建会失败
- 该检出须落在版本区间 `0.1.0-rc.7 .. 0.1.5-rc.2`（构建脚本按 git tag 判定，越界会明确报错）；位置用
  `DSH_HARNESS` 指定，默认 `../deepseek-harness`

```sh
pnpm install
pnpm build        # 产出 dist/qialike（单文件可执行）
```

## 测试与校验

| 命令 | 作用 |
| --- | --- |
| `pnpm test` | 冒烟：启动真实的 `dsh-base` + `qialike-app` 组合树并解析 TUI 命令面，**无需 API key** |
| `pnpm test:unit` | 单元测试（`bun test tests/`） |
| `pnpm typecheck` | 类型检查 |

交互式 token 流式输出需要 TTY 与提供商 key，因此冒烟测试止于 `--help`。`pnpm typecheck` 会报 **3 处既有的**
`wrap-ansi` TS7016（缺类型声明）；非零退出是基线，只看新增错误。

## 仓库布局

```
packages/qialike-app/   bundle：cordis.patch.yml + startup/index/invariant 插件
apps/tui-bin/           src/bin.ts（SEA/bun 启动器）+ build.mjs
examples/cordis.yml     一处部署 overlay：固化模型与工作区
tests/smoke.mjs         无 key 的 REAL-composition 启动冒烟
```

`cordis.patch.yml` 在 `dsh-base` 之上，OS 级沙箱行在所有平台都已启用。单文件里要把 Windows 那一档跑起来，
有两样必须自带：它依赖的原生 `koffi`（由 `apps/tui-bin/stub/koffi.js` 顶替），以及 **runner 进程本身**——
harness 用模块 specifier 定位它，而编译后的二进制答不了这个调用，于是 qialike 把 harness 自己的 runner
一并携带并充当其 launcher（见 `apps/tui-bin/src/windows-acl-shim.ts`）。`permission`（presets）行因此在
所有平台都已启用。用户可见的安全行为见 README 的「安全边界」。

## 作为插件 bundle 分发

**本仓库不经 npm 分发**——二进制只由 `curl | bash` 安装器与 GitHub/gitcode Releases 提供，从不需要 npm。
下面这条路径因此**当前不可用**，保留它只为说明架构上存在的能力，以及启用它需要什么。

`@yourname/qialike-app` 是一个树外（out-of-tree）Cordis bundle；若将来有一个可控的 npm 注册表与 scope，
它可以这样加到某个 profile：

```sh
dsh plugin --profile tui add <scope>/qialike-app
dsh --profile tui --workspace ~/proj
```

`dsh plugin add` 通过安装目录的 `profiles/node_modules` fallback 解析 `@deepseek-ai/*` peer 依赖，因此消费
方用的是**已安装的 harness**，而不是本检出。

要启用这条路径，需先解决三件事（这是现状记录，不是待办清单）：

- 根包是 `private: true`，`npm publish` 会直接拒绝；三处 `package.json` 的 name 都用 `@yourname/` 这个
  **不属于本项目的占位 scope**（`@yourname/qialike-root`、`@yourname/qialike-app`、`@yourname/qialike-bin`）；
  `npm view @yourname/qialike-app` 返回 404。
- peer 依赖统一声明 `^0.1.1`，而 npm 的 semver 下 `^0.1.1` **不接受**预发布版本——已发布的 harness 是
  `0.1.5-rc.2`，`semver.satisfies("0.1.5-rc.2", "^0.1.1")` 为 `false`。
- harness 本身**已在 npm 上架**（`@deepseek-ai/dsh`，`latest` = `0.1.5-rc.2`）——这一项不是障碍。

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
