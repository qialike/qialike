#!/usr/bin/env bash
# qialike 通用编译脚本（仓库内 scripts/release/）：版本号 + 编译 + 可选打标签 + 可选归档。
# 打标签的**实现**在独立脚本 `./tag-qialike.sh`（打新标签 / 升级已有标签）；本脚本只在
# BUILD_TAG=1 时按「编译校验通过 → 打标签 → 归档」的顺序**编排调用**它。
#
# 功能：
#   1) 在 qialike 仓库执行 `pnpm build --single`（构建会先清空 dist/，并校验
#      deepseek-harness 版本门禁），产出单文件二进制 dist/qialike。
#   2) 用 `--version` 校验构建产物版本号与期望版本一致，不一致则失败退出。
#   3) 带版本参数时：若目标版本与当前版本不同，先交互询问是否继续；用户同意后，将
#      3 处 package.json（根 / packages/qialike-app / apps/tui-bin）的 version 改为目标
#      版本，再编译；若相同则不改动版本号、直接编译。输入非 y/yes（或无可交互
#      输入）即中止，且不改动任何文件。交互提示 `printf ... >&2` 后 `read`，因此
#      stdin 为管道/非终端时提示也可见。
#      无论是否升版，都会**互查三处 package.json 的 version 是否一致**（期望值只从根读，
#      另两处不会自动跟着变）：任何一处不符 → 打印该文件实际值 → exit 1（编译/打标签/归档都不执行）。
#      升版写完三处后会再复核一次（防漏写/格式怪异的文件）。
#   4) 构建日志同时输出到终端并写入仓库根 build.log。
#   5) BUILD_TAG=1 时（默认 0）：构建 + 版本校验通过后调用 `./tag-qialike.sh` ——
#      提交改动（升版 → 新增提交；版本未变 → `--amend --no-edit`）并打/移 `v<版本>` 标签。
#      旧开关名兼容：`BUILD_NO_GIT` 显式设为非 1 等价于 BUILD_TAG=1。
#   6) BUILD_ARCHIVE=1 时调用 release-archive.sh，生成
#      qialike-<版本>.tar.gz / .zip（输出目录默认仓库同级的 releases-qialike/，即仓库外、
#      不会被提交，可用 BUILD_ARCHIVE_OUT 覆盖）。归档要求 tag `v<版本>` **已存在**（release-archive.sh
#      自行校验并报错），所以归档必须排在打标签之后（步骤 5 打开，或先手动跑 tag 脚本）。
#   7) BUILD_TARGETS 控制编译范围：ALL = `pnpm build --package`（全平台 6 目标
#      二进制 + dist/ 内打包 tar.gz/zip）；SINGLE = `pnpm build --single`
#      （仅当前系统，默认）。其它值报错退出。
#
# 用法：
#   ./build-qialike.sh                          # 沿用当前版本号，重新编译（不碰 git）
#   ./build-qialike.sh 0.1.2                    # 交互确认后将 3 处 package.json 版本改为 0.1.2 再编译
#   BUILD_TAG=1 ./build-qialike.sh 0.1.2        # 升版 + 编译 + 提交 + 打标签 v0.1.2
#   BUILD_NO_GIT=0 ./build-qialike.sh 0.1.2     # 同上（旧开关名兼容写法）
#   BUILD_TAG=1 BUILD_TAG_DRY=1 ./build-qialike.sh   # 打标签步骤只预演（不做任何改动）
#   BUILD_TAG=1 BUILD_TAG_YES=1 ./build-qialike.sh   # 打标签步骤免确认（无 TTY/自动化）
#   BUILD_ARCHIVE=1 ./build-qialike.sh          # 重建 + 归档到默认 releases-qialike/（tag 须已存在）
#   ./release-archive.sh                        # 单独归档（不编译，直接归档当前版本的 tag；见下）
#   BUILD_TAG=1 BUILD_ARCHIVE=1 ./build-qialike.sh 0.1.2   # 升版 + 编译 + 打标签 + 归档（一条命令）
#   BUILD_TARGETS=ALL ./build-qialike.sh        # 全平台二进制 + 打包
#   BUILD_ARCHIVE=1 BUILD_TARGETS=ALL ./build-qialike.sh    # 全平台二进制 + 打包 + 源码归档
#
# 典型发版顺序（两种等价写法；在仓库内 scripts/release/ 下执行即可，脚本自行定位仓库根）：
#   一条命令：BUILD_TAG=1 BUILD_ARCHIVE=1 ./build-qialike.sh 0.5.0
#   分步：    ./build-qialike.sh 0.5.0     # 升版 + 编译 + 校验
#             ./tag-qialike.sh -n          # 预演（可选）
#             ./tag-qialike.sh             # 提交 + 打 v0.5.0
#             ./release-archive.sh         # 只归档（不必再编译：源码归档取自 tag 树，
#                                          #   编译不改变归档内容；BUILD_ARCHIVE=1 ./build-qialike.sh
#                                          #   只是"编译 + 归档"的合体写法）
#
# 环境变量：
#   BUILD_TAG      设为 1 时在编译校验后调用 tag-qialike.sh（默认 0 = 纯编译，不碰 git）
#   BUILD_TAG_DRY  设为 1 时给 tag 步骤传 `-n`（预演，不改动仓库）
#   BUILD_TAG_YES  设为 1 时给 tag 步骤传 `-y`（免确认）
#   BUILD_NO_GIT   旧开关名：显式设为非 1（如 0）等价于 BUILD_TAG=1
#   BUILD_ARCHIVE  设为 1 时调用 release-archive.sh 归档（默认不执行；要求 tag 已存在）
#   BUILD_ARCHIVE_OUT  归档输出目录，默认仓库同级的 releases-qialike/（仓库外，不入库）
#   BUILD_TARGETS  ALL=全平台编译+打包（pnpm build --package）；SINGLE=仅当前系统
#                    （pnpm build --single，默认）；其它值报错退出
#
# 前置条件：本脚本位于仓库内 scripts/release/（据上溯两级定位仓库根），同级存在
# tag-qialike.sh/release-archive.sh，且仓库根已 `pnpm install`（构建依赖仓库
# node_modules 中的 semver 与 bun）。
set -euo pipefail

# 步骤 1：解析路径与常量
#   仓库根 = 本脚本所在目录（<repo>/scripts/release/）上溯两级；与调用时的 cwd 无关。
#   PKG_FILES 为版本号需同步的 3 处 package.json（根 / qialike-app / tui-bin）。
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
#   同级的 tag / 归档脚本（本脚本只编排调用它们）。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_FILES=(
  "$REPO/package.json"
  "$REPO/packages/qialike-app/package.json"
  "$REPO/apps/tui-bin/package.json"
)

# 步骤 1.1：编译范围校验——BUILD_TARGETS 仅允许 ALL / SINGLE（默认 SINGLE）
BUILD_TARGETS="${BUILD_TARGETS:-SINGLE}"
case "$BUILD_TARGETS" in
  ALL | SINGLE) ;;
  *) echo "qialike: invalid BUILD_TARGETS='$BUILD_TARGETS' (ALL | SINGLE)" >&2; exit 1 ;;
esac

# 步骤 2：前置检查——qialike 仓库必须存在，否则无法编译
[[ -d "$REPO" ]] || { echo "qialike: repo not found at $REPO" >&2; exit 1; }

# 步骤 3：工具函数
#   current_version：读取根 package.json 的当前版本（唯一权威来源）。
#   set_version：用 node 精确替换某个 package.json 顶部 `"version"` 字段（保留原格式）。
#   host_target_name：把当前主机映射为 build.mjs 的目标名（如 linux-x64），
#     用于 ALL 模式下定位当前平台二进制。
current_version() { node -p "require('$REPO/package.json').version"; }

host_target_name() {
  local os arch
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    MINGW*|MSYS*|CYGWIN*) os=windows ;;
    *) os=unknown ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) arch=unknown ;;
  esac
  echo "$os-$arch"
}

set_version() {
  node -e '
    const fs = require("fs");
    const [file, version] = process.argv.slice(1);
    const text = fs.readFileSync(file, "utf8");
    if (!/"version"\s*:/.test(text)) throw new Error("no version field in " + file);
    fs.writeFileSync(file, text.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`));
  ' "$1" "$2"
}

# check_pkg_versions <期望版本>：**三处 package.json 一致性互查**（根 / packages/qialike-app /
#   apps/tui-bin）。期望版本只从根读，另两处不会自动跟着变，所以这里逐个核对：
#   任何一处不等于期望版本 → 打印文件路径与实际值 → exit 1（编译、打标签、归档都不会发生）。
check_pkg_versions() {
  local expect="$1" file got bad=0
  for file in "${PKG_FILES[@]}"; do
    got="$(node -p "require('$file').version" 2>/dev/null || true)"
    if [[ "$got" != "$expect" ]]; then
      echo "qialike: version mismatch in ${file#"$REPO"/}: $got (expected $expect)" >&2
      bad=1
    fi
  done
  [[ "$bad" == 0 ]] || {
    echo "qialike: the 3 package.json versions must agree (root / packages/qialike-app / apps/tui-bin)" >&2
    exit 1
  }
  echo "qialike: three package.json versions OK ($expect): root / packages/qialike-app / apps/tui-bin"
}

# 步骤 4：读取当前版本，并先做一次三处一致性互查（防止带着"改歪了"的版本号往下走）
NEW_VERSION="$(current_version)"
check_pkg_versions "$NEW_VERSION"

# 步骤 5（可选）：带版本参数时
#   校验为合法裸 semver（且无 build 元数据，如 0.1.2）；与当前版本不同则交互确认，
#   同意后同步 3 处 package.json；相同则不改动直接编译。
#   注：本脚本只改版本号、**不碰 git**——提交与打标签由 `./tag-qialike.sh` 负责。
if [[ $# -gt 0 ]]; then
  TARGET="$1"
  VALID="$(node -e "console.log(require('$REPO/node_modules/semver').valid(process.argv[1]) || '')" "$TARGET")"
  [[ -n "$VALID" && "$TARGET" != *+* ]] || {
    echo "qialike: invalid version '$TARGET' (bare semver required, e.g. 0.1.2)" >&2; exit 1
  }
  if [[ "$TARGET" != "$NEW_VERSION" ]]; then
    echo "qialike: current version is $NEW_VERSION; requested $TARGET"
    printf 'qialike: change the version in all 3 package.json files to %s? [y/N] ' "$TARGET" >&2
    read -r ANSWER || ANSWER=""
    [[ "${ANSWER,,}" == "y" || "${ANSWER,,}" == "yes" ]] || {
      echo "qialike: aborted (version unchanged)" >&2; exit 1
    }
    for file in "${PKG_FILES[@]}"; do set_version "$file" "$TARGET"; done
    NEW_VERSION="$TARGET"
    echo "qialike: bumped version to $NEW_VERSION (3 package.json files)"
    check_pkg_versions "$NEW_VERSION"   # 写完立刻复核三处确实都改了（防漏写/格式怪异的文件）
  else
    echo "qialike: version is already $TARGET (no change)"
  fi
fi

# 步骤 6：编译——按 BUILD_TARGETS 选择命令。构建内部会先清空 dist/ 并校验
#   deepseek-harness 版本门禁；日志同时输出到终端并写入 build.log。
#   ALL：`pnpm build --package` → 全平台 6 目标二进制 + dist/ 内打包 tar.gz/zip；
#       当前平台二进制位于 dist/<os>-<arch>/qialike[.exe]。
#   SINGLE：`pnpm build --single` → 仅当前系统 dist/qialike。
#   注：build.mjs 自身的 `QIALIKE_TARGETS`（跨平台目标子集选择，如 windows-x64）
#   与本脚本的 BUILD_TARGETS 互不影响；需要时可直接 `QIALIKE_TARGETS=<子集> pnpm build`。
echo "qialike: building $NEW_VERSION from $REPO (targets=$BUILD_TARGETS)"
if [[ "$BUILD_TARGETS" == "ALL" ]]; then
  (cd "$REPO" && pnpm build --package) | tee "$REPO/build.log"
  BIN="$REPO/dist/$(host_target_name)/qialike"
  [[ "$(uname -s)" == MINGW* || "$(uname -s)" == MSYS* || "$(uname -s)" == CYGWIN* ]] && BIN="$BIN.exe"
else
  (cd "$REPO" && pnpm build --single) | tee "$REPO/build.log"
  BIN="$REPO/dist/qialike"
fi

# 步骤 7：校验——先确认构建产出了二进制，再用 `--version` 确认版本号与期望一致，
#   不一致则失败退出。
[[ -x "$BIN" ]] || { echo "qialike: build did not produce $BIN" >&2; exit 1; }
ACTUAL="$( "$BIN" --version )"
echo "qialike: $ACTUAL"
[[ "$ACTUAL" == "qialike $NEW_VERSION" ]] || { echo "qialike: version mismatch (expected qialike $NEW_VERSION)" >&2; exit 1; }
echo "qialike: build + verify OK"

# 步骤 8（可选）：打标签——BUILD_TAG=1 时调用 `tag-qialike.sh`（打标签逻辑在该脚本内，
#   这里只负责编排顺序：编译校验通过 → 打标签 → 归档）。默认 0 = 纯编译，不碰 git。
#   兼容旧开关名：`BUILD_NO_GIT` 显式设为非 1 时按 BUILD_TAG=1 处理（老用法
#   `BUILD_NO_GIT=0 ./build-qialike.sh <版本>` 仍然有效）。
#   传参开关：BUILD_TAG_DRY=1 → 给 tag 脚本加 `-n`（预演，不改动）；BUILD_TAG_YES=1 → 加 `-y`（免确认）。
if [[ -n "${BUILD_NO_GIT:-}" && "${BUILD_NO_GIT}" != 1 ]]; then
  BUILD_TAG=1
  echo "qialike: BUILD_NO_GIT=${BUILD_NO_GIT} → 按 BUILD_TAG=1 处理（旧开关别名）"
fi
if [[ "${BUILD_TAG:-0}" == 1 ]]; then
  TAG_SCRIPT="$SCRIPT_DIR/tag-qialike.sh"
  [[ -x "$TAG_SCRIPT" ]] || {
    echo "qialike: tag step requested but $TAG_SCRIPT is missing or not executable" >&2; exit 1
  }
  TAG_ARGS=()
  [[ "${BUILD_TAG_DRY:-0}" == 1 ]] && TAG_ARGS+=(-n)
  [[ "${BUILD_TAG_YES:-0}" == 1 ]] && TAG_ARGS+=(-y)
  echo "qialike: tag step → $TAG_SCRIPT ${TAG_ARGS[*]:-}"
  "$TAG_SCRIPT" ${TAG_ARGS[@]+"${TAG_ARGS[@]}"}
  echo "qialike: tag step OK"
else
  echo "qialike: skipping tag step (set BUILD_TAG=1 to commit + tag, or run ./tag-qialike.sh)"
fi

# 步骤 9（可选）：归档——BUILD_ARCHIVE=1 时调用 release-archive.sh，生成
#   qialike-<版本>.tar.gz / .zip（输出目录默认仓库同级的 releases-qialike/，即仓库外，可用
#   BUILD_ARCHIVE_OUT 覆盖）；release-archive.sh 会自行校验 tag v<版本> 是否存在，
#   所以归档前必须已有标签（步骤 8 打开 BUILD_TAG=1，或先手动跑 ./tag-qialike.sh）。
if [[ "${BUILD_ARCHIVE:-0}" == 1 ]]; then
  "$SCRIPT_DIR/release-archive.sh" "$REPO" "${BUILD_ARCHIVE_OUT:-$REPO/../releases-qialike}"
fi
