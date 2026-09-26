#!/usr/bin/env bash
# =============================================================================
# publish-npm.sh — 把 **Windows 二进制产物** 发布到 npm（`qialike` 渠道）
#
# 为什么只有 Windows：Windows Terminal 没有 bash，文档里的 `curl … | bash`
# 装不了，用户必须「下载 zip → 手动解压到 %USERPROFILE%\.dsh\bin\ → 手动改
# PATH → 重开终端」四步。npm 是那条路之外唯一能在 Windows 上一条命令装好的
# 渠道。Linux / macOS 继续走 `curl | bash`，所以本渠道只发 Windows 两个目标。
#
# 为什么需要「主包 + 平台分包」三个包（而不是两个，也不是一个）：
#   · `qialike`（主包，几 KB）—— 只有它带 `bin`，指向一个 JS 包装
#     (`packages/npm/qialike/bin/qialike.js`)，并由 `optionalDependencies`
#     声明两个平台包。**架构自动选择就发生在这里**：npm 只安装 `os`/`cpu`
#     匹配的那一个平台包，所以每台机器只下载自己那份 ~55 MB。
#   · `qialike-win32-x64` / `qialike-win32-arm64`（各含一个 `qialike.exe`）
#     —— 只带 `os`/`cpu`，**故意不带 `bin`**：在售的大二进制包（@esbuild/win32-x64、
#     @biomejs/cli-win32-x64、@swc/core-win32-x64-msvc、@next/swc-win32-x64-msvc）
#     全部是这个分工；`bin` 放在主包才能给「平台包缺失」这类失败写出人话。
#
# 为什么是「暂存后发布」而不是直接在仓库里发：`qialike.exe` 是 131.6 MB，
# 绝不进 git；而且版本号必须与本次发布严格一致 —— 所以本脚本把三份模板
# (`packages/npm/*/package.json`，版本占位符 `0.0.0-template`) 连同二进制
# 复制到临时目录，在那里注入真实版本再 `npm publish`。仓库里永远不出现
# 大文件，也不会出现「模板版本被误发」。
#
# 发布顺序：**先两个平台包，再主包**。反过来的话，主包的 optionalDependencies
# 会指向尚不存在的版本 —— 用户装到主包却拿不到 exe，而这正是本渠道最怕的失败。
#
# npm 的不可撤销性：版本发布 72 小时后**禁止删除**。发错了只能
# `npm deprecate` + 发新版本。所以本脚本默认严格前置（tag 必须存在、工作区
# 必须干净、二进制必须齐备），并且先跑 `--dry-run` 是最省事的做法。
#
# 用法：
#   ./publish-npm.sh                     # 真发布（严格前置 + 二次确认）
#   ./publish-npm.sh --dry-run           # 只打包并列出内容与体积，不需要凭据、不上传
#   ./publish-npm.sh --yes               # 跳过确认
#   ./publish-npm.sh --version 0.9.0     # 覆盖版本（默认读根 package.json）
#   ./publish-npm.sh --tag next          # 指定 dist-tag（默认 latest）
#   ./publish-npm.sh --otp 123456        # 一次性密码
#   ./publish-npm.sh --allow-untagged    # 允许 tag v<版本> 不存在（本地预演）
#   ./publish-npm.sh --allow-dirty       # 允许工作区不干净（本地预演）
#   ./publish-npm.sh --keep-staging      # 保留暂存目录以便人工检查
#   ./publish-npm.sh -h
#
# 环境变量：NODE_AUTH_TOKEN / NPM_TOKEN —— 传给 npm 的发布凭据（CI 用）。
#   **不要**把 token 写进仓库；本脚本只读环境。
#
# 退出码：0 = 全部发布成功（或 --dry-run 通过）；1 = 任一环节失败（并指明
#   停在哪一步、哪些包已发布 —— npm 不可撤销，必须说清）。
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
NPM_DIR="$REPO/packages/npm"
DIST="$REPO/dist"

# 平台目标 → (分包名, dist 目录, 二进制名)。只发 Windows，见文件头。
TARGETS=(
  'qialike-win32-x64|windows-x64'
  'qialike-win32-arm64|windows-arm64'
)
MAIN='qialike'

# 二进制体积下限：真实产物 x64 131.6 MB / arm64 123.5 MB。低于此值几乎一定是
# 构建被截断或拷错了文件，宁可在这里挡住，也不要把半个二进制发上注册表。
MIN_EXE_BYTES=$((40 * 1024 * 1024))

VERSION=''
DIST_TAG='latest'
OTP=''
DRY_RUN=0
ASSUME_YES=0
ALLOW_UNTAGGED=0
ALLOW_DIRTY=0
KEEP_STAGING=0
STAGING=''

say() { printf '  %s\n' "$*"; }
bold() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
ok() { printf '  [ok]   %s\n' "$*"; }
warn() { printf '  [warn] %s\n' "$*" >&2; }
bad() { printf '  [FAIL] %s\n' "$*" >&2; }
die() { printf '\n发布未完成：%s\n' "$*" >&2; exit 1; }

usage() { sed -n '2,/^set -euo pipefail$/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --yes | -y) ASSUME_YES=1 ;;
    --version) VERSION="${2:-}"; shift ;;
    --tag) DIST_TAG="${2:-}"; shift ;;
    --otp) OTP="${2:-}"; shift ;;
    --allow-untagged) ALLOW_UNTAGGED=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    --keep-staging) KEEP_STAGING=1 ;;
    -h | --help) usage; exit 0 ;;
    *) die "未知参数 '$1'（-h 看用法）" ;;
  esac
  shift
done

cleanup() {
  if [[ -n "$STAGING" && -d "$STAGING" && "$KEEP_STAGING" == 0 ]]; then rm -rf "$STAGING"; fi
  if [[ -n "$STAGING" && "$KEEP_STAGING" == 1 ]]; then say "暂存目录保留在 $STAGING"; fi
}
trap cleanup EXIT

# ---- 1. 版本：默认取根 package.json，三处 package.json 必须一致 ------------
command -v npm >/dev/null 2>&1 || die '找不到 npm'
command -v node >/dev/null 2>&1 || die '找不到 node'

if [[ -z "$VERSION" ]]; then
  VERSION="$(node -p "require('$REPO/package.json').version")" \
    || die "无法从 $REPO/package.json 读取 version"
fi
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || die "版本号 '$VERSION' 不像语义化版本"

bold '待发布'
say "版本      = $VERSION"
say "dist-tag  = $DIST_TAG"
say "模式      = $([[ $DRY_RUN == 1 ]] && echo 'dry-run（打包并列内容，不上传）' || echo '真发布')"
say "包        = $MAIN + ${TARGETS[*]%%|*}"

# ---- 2. 前置：版本一致性、工作区、tag --------------------------------------
bold '前置检查'
for f in package.json packages/qialike-app/package.json apps/tui-bin/package.json; do
  v="$(node -p "require('$REPO/$f').version")"
  [[ "$v" == "$VERSION" ]] || die "$f 的 version 是 $v，与 $VERSION 不一致（npm 渠道必须与本次发布同一版本）"
  ok "$f = $v"
done

if [[ "$ALLOW_DIRTY" == 0 ]]; then
  dirty="$(git -C "$REPO" status --porcelain | wc -l | tr -d ' ')"
  [[ "$dirty" == 0 ]] || die "工作区不干净（$dirty 项）—— npm 发布必须来自已提交的树；预演可加 --allow-dirty"
  ok "工作区 clean（HEAD=$(git -C "$REPO" rev-parse --short HEAD)）"
else
  warn '跳过工作区检查（--allow-dirty）'
fi

if [[ "$ALLOW_UNTAGGED" == 0 ]]; then
  git -C "$REPO" rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null 2>&1 \
    || die "tag v$VERSION 不存在 —— npm 发布应与打版同源；预演可加 --allow-untagged"
  ok "tag v$VERSION 存在 → $(git -C "$REPO" rev-parse --short "v$VERSION^{commit}")"
else
  warn '跳过 tag 检查（--allow-untagged）'
fi

# 三份模板必须存在且仍是占位版本 —— 若有人手改成了真实版本，说明流程被绕过。
for p in "$MAIN" 'qialike-win32-x64' 'qialike-win32-arm64'; do
  t="$NPM_DIR/$p/package.json"
  [[ -f "$t" ]] || die "缺少模板 $t"
  tv="$(node -p "require('$t').version")"
  [[ "$tv" == '0.0.0-template' ]] \
    || die "$t 的版本是 $tv，不是占位符 0.0.0-template —— 模板不应带真实版本，版本由本脚本注入"
done
ok "三份模板就位（版本占位符 0.0.0-template）"

# ---- 3. 前置：二进制齐备且看着对 --------------------------------------------
bold '二进制产物'
declare -A EXE_PATH=()
for spec in "${TARGETS[@]}"; do
  pkg="${spec%%|*}"; dir="${spec##*|}"
  exe="$DIST/$dir/qialike.exe"
  [[ -f "$exe" ]] || die "缺少 $exe —— 先跑 ⓪ 编译（release-menu.sh 第 1 项 / build-qialike.sh $VERSION）"
  bytes="$(stat -c %s "$exe" 2>/dev/null || stat -f %z "$exe")"
  [[ "$bytes" -ge "$MIN_EXE_BYTES" ]] \
    || die "$exe 只有 $bytes B（< 下限 $MIN_EXE_BYTES）—— 构建可能被截断，拒绝发布"
  # PE 头：Windows 可执行文件以 'MZ' 开头。防的是把别的平台产物拷进来。
  [[ "$(head -c 2 "$exe")" == 'MZ' ]] || die "$exe 不是 PE 可执行文件（缺 MZ 头）"
  EXE_PATH["$pkg"]="$exe"
  printf '  [ok]   %-20s %s B (%.1f MiB)\n' "$pkg" "$bytes" "$(node -p "$bytes/1048576")"
done

# ---- 4. 暂存：注入版本，把二进制拷进平台包 ----------------------------------
bold '暂存'
STAGING="$(mktemp -d)"
say "暂存目录 = $STAGING（发布后自动清理）"

stage() { # $1 = 包名
  local pkg="$1" src="$NPM_DIR/$1" dst="$STAGING/$1"
  mkdir -p "$dst"
  cp -R "$src/." "$dst/"
  node - "$dst/package.json" "$VERSION" <<'NODE'
const fs = require('node:fs')
const [file, version] = process.argv.slice(2)
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
manifest.version = version
// 主包的 optionalDependencies 必须**精确**指向本次要发的平台版本：范围
// （^ / ~）会让 npm 去解析「最接近的已发布版本」，可能拿到上一次的包。
if (manifest.optionalDependencies) {
  for (const name of Object.keys(manifest.optionalDependencies)) {
    manifest.optionalDependencies[name] = version
  }
}
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
NODE
  rm -f "$dst/.gitignore"
}
for spec in "${TARGETS[@]}"; do
  pkg="${spec%%|*}"
  stage "$pkg"
  cp "${EXE_PATH[$pkg]}" "$STAGING/$pkg/qialike.exe"
  ok "暂存 $pkg（+ qialike.exe）"
done
stage "$MAIN"
ok "暂存 $MAIN"
say "校验注入结果：$(node -p "require('$STAGING/$MAIN/package.json').version") / optional=$(node -p "JSON.stringify(require('$STAGING/$MAIN/package.json').optionalDependencies)")"

# ---- 5. 打包预检：内容与体积 -------------------------------------------------
bold '打包预检（npm pack --dry-run）'
for pkg in 'qialike-win32-x64' 'qialike-win32-arm64' "$MAIN"; do
  say "── $pkg"
  ( cd "$STAGING/$pkg" && npm pack --dry-run 2>&1 | sed 's/^/    /' )
done

if [[ "$DRY_RUN" == 1 ]]; then
  bold 'dry-run 结束'
  say '没有上传任何东西，也没有读取凭据。'
  say "去掉 --dry-run 即真发布；发布顺序为：两个平台包 → 主包 $MAIN。"
  exit 0
fi

# ---- 6. 凭据与确认 -----------------------------------------------------------
bold '凭据'
if [[ -n "${NODE_AUTH_TOKEN:-}" || -n "${NPM_TOKEN:-}" ]]; then
  ok '检出 NODE_AUTH_TOKEN / NPM_TOKEN（值不回显）'
else
  if whoami_out="$(npm whoami 2>&1)"; then
    ok "npm 已登录：$whoami_out"
  else
    die "npm 未登录且环境里没有 token —— 先 npm login，或导出 NODE_AUTH_TOKEN（CI）。
   ($whoami_out)"
  fi
fi

if [[ "$ASSUME_YES" == 0 ]]; then
  printf '\n  将**不可撤销地**发布 %s 的三个包到 npm（72 小时后禁止删除）：\n' "$VERSION"
  printf '      qialike-win32-x64@%s\n      qialike-win32-arm64@%s\n      %s@%s\n' \
    "$VERSION" "$VERSION" "$MAIN" "$VERSION"
  printf '  继续？[y/N] '
  read -r reply || reply=''
  case "$reply" in
    y | Y | yes | YES) ;;
    *) die '已取消（没有发布任何东西）' ;;
  esac
fi

# ---- 7. 发布：先平台包，再主包 ----------------------------------------------
PUBLISH_ARGS=(--access public --tag "$DIST_TAG")
[[ -n "$OTP" ]] && PUBLISH_ARGS+=(--otp "$OTP")

DONE=()
publish_one() { # $1 = 包名
  local pkg="$1"
  say "发布 $pkg@$VERSION …"
  if ( cd "$STAGING/$pkg" && npm publish "${PUBLISH_ARGS[@]}" ); then
    DONE+=("$pkg")
    ok "$pkg 已发布"
  else
    printf '\n' >&2
    bad "$pkg 发布失败"
    if [[ ${#DONE[@]} -gt 0 ]]; then
      warn "**已发布**（不可撤销）：${DONE[*]}"
      warn "修好原因后重跑本脚本即可 —— 已发布的版本 npm 会拒绝重复，脚本会在该包报错；"
      warn "此时只需继续发剩下的包，或对已发包执行 npm deprecate 后抬版本重发。"
    else
      warn '尚未发布任何包。'
    fi
    die "停在 $pkg"
  fi
}

bold '发布'
# 平台包在前：主包的 optionalDependencies 指向它们，顺序反了会让刚才安装的
# 用户解析到不存在的版本。
publish_one 'qialike-win32-x64'
publish_one 'qialike-win32-arm64'
publish_one "$MAIN"

bold '完成'
ok "已发布：${DONE[*]}"
cat <<EOF

  验证（无需 Windows 机器）：
      npm view $MAIN version dist-tags
      npm view qialike-win32-x64 version os cpu dist.unpackedSize
      npm view qialike-win32-arm64 version os cpu dist.unpackedSize

  Windows 上的真实安装（需在 Windows 终端执行）：
      npm i -g $MAIN
      qialike --version

  回滚：npm 在 72 小时后禁止删除版本 —— 发错了用
      npm deprecate <pkg>@$VERSION "<原因>"
  然后抬版本重发。
EOF
