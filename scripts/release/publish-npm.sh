#!/usr/bin/env bash
# =============================================================================
# publish-npm.sh — 把 **Windows 二进制产物** 发布到 npm（`@qialike/cli` 渠道）
#
# 为什么只发 Windows：Windows Terminal 没有 bash，文档里的 `curl | bash` 装不了，用户只能
# 「下载 zip → 手动解压到 %USERPROFILE%\.dsh\bin\ → 手动改 PATH → 重开终端」四步。Linux /
# macOS 继续走 shell 安装器与发布归档，所以本渠道只发 Windows 两个目标。
#
# **架构自动适配**：两个平台包各带 `os: ["win32"]` 与 `cpu`（`x64` / `arm64`），于是
# `npm i -g @qialike/cli` 由 npm 自己挑选匹配的那一个 —— x64 机器拿 x64 产物、arm64 机器拿
# arm64 产物，不需要用户选，也不会两份都下。注意：**没有 32 位 ia32 产物**（构建矩阵只有
# x64 与 arm64 两个架构）。
#
# 为什么需要「主包 + 两个平台分包」三个包（而不是一个）：
#   · `@qialike/cli`（主包，几 KB）—— 只有它带 `bin`，指向一个 JS 包装
#     (`packages/npm/qialike-cli/bin/qialike.js`)，并由 `optionalDependencies`
#     声明两个平台包。**架构自动选择就发生在这里**：npm 只安装 `os`/`cpu`
#     匹配的那一个平台包，所以每台机器只下载自己那份。
#   · `@qialike/cli-win32-x64` / `@qialike/cli-win32-arm64`（各含一个 `qialike.exe`）
#     —— 只带 `os`/`cpu`，**故意不带 `bin`**：在售的大二进制包
#     （@esbuild/win32-x64、@biomejs/cli-win32-x64、@swc/core-win32-x64-msvc）
#     全部是这个分工；`bin` 放在主包才能给「平台包缺失」这类失败写出人话。
#
# 为什么是「暂存后发布」而不是直接在仓库里发：二进制是 129–138 MB，
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
#   ./publish-npm.sh --oidc              # CI 用 Trusted Publishing（OIDC）；CI 里自动识别
#   ./publish-npm.sh --provenance        # 一并生成 provenance 证明（OIDC 环境下才有意义）
#   ./publish-npm.sh --allow-untagged    # 允许 tag v<版本> 不存在（本地预演）
#   ./publish-npm.sh --allow-dirty       # 允许工作区不干净（本地预演）
#   ./publish-npm.sh --keep-staging      # 保留暂存目录以便人工检查
#   ./publish-npm.sh -h
#
# 凭据两条路：**首选 OIDC**（`--oidc`，或 CI 里自动识别 `ACTIONS_ID_TOKEN_REQUEST_URL`；
# 不需要任何长期令牌），其次才是长期令牌 ——
# 环境变量：NODE_AUTH_TOKEN / NPM_TOKEN —— 发布凭据（CI 用）。**npm 本身不读它们**；
#   本脚本把它们接成 `npm_config_//<registry>/:_authToken` 传给 npm 子进程（不写盘、
#   不进 argv）。手跑 npm publish 时请自行在 ~/.npmrc 写
#   `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}`。NPM_REGISTRY 可换注册表。
#   **不要**把 token 写进仓库；本脚本只读环境。
#
# 退出码：0 = 全部发布成功（或 --dry-run 通过）；1 = 任一环节失败（并指明
#   停在哪一步、哪些包已发布 —— npm 不可撤销，必须说清）。
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
NPM_DIR="$REPO/packages/npm"
# 产物目录；`QIALIKE_DIST` 仅供**测试与预演**指向别处（测试用几十 MB 的稀疏文件驱动全流程，
# 于是 CI 里没有 dist/ 也能跑这条端到端测试）。正式发布永远用默认值。
DIST="${QIALIKE_DIST:-$REPO/dist}"

# 平台目标 → (分包名, dist 目录, 二进制名)。只发 Windows 两个架构，见文件头。
TARGETS=(
  '@qialike/cli-win32-x64|windows-x64|qialike.exe'
  '@qialike/cli-win32-arm64|windows-arm64|qialike.exe'
)
MAIN='@qialike/cli'

# 包名 → 模板目录名（同时也是暂存目录名）：去掉 scope 前缀、'/' 换成 '-'。
# 目录名里不出现 '@' 或嵌套路径，cp/mktemp 与人工排查都省事。
tdir() { local n="${1#@}"; printf '%s' "${n//\//-}"; }

PLATFORM_PKGS=()
for spec in "${TARGETS[@]}"; do PLATFORM_PKGS+=("${spec%%|*}"); done

# 二进制体积下限：真实产物 x64 131.6 MB / arm64 123.5 MB。低于此值几乎一定是
# 构建被截断或拷错了文件，宁可在这里挡住，也不要把半个二进制发上注册表。
MIN_EXE_BYTES=$((40 * 1024 * 1024))

VERSION=''
DIST_TAG='latest'
OTP=''
OIDC=0
PROVENANCE=0
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
    --oidc) OIDC=1 ;;
    --provenance) PROVENANCE=1 ;;
    --allow-untagged) ALLOW_UNTAGGED=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    --keep-staging) KEEP_STAGING=1 ;;
    -h | --help) usage; exit 0 ;;
    *) die "未知参数 '$1'（-h 看用法）" ;;
  esac
  shift
done

# **OIDC 自动识别**：GitHub Actions 会为声明了 `id-token: write` 的 job 注入这两个变量。
# 没有 token 可查、也不该去查 —— npm CLI（≥ 11.5.1）自己会拿它去换一次性的发布凭据。
if [[ "$OIDC" == 0 && -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" && -n "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ]]; then
  OIDC=1
fi

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
say "包        = $MAIN + ${#PLATFORM_PKGS[@]} 个平台包（${PLATFORM_PKGS[*]}）"

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
  # 本地约定带 v（`v0.8.1`），而 ⑪ 推到远端的标签是**裸版本号**（`0.8.1`，刻意的两套命名）。
  # 两种都接受：否则 CI 里 checkout 出来的裸标签会让这道检查失败，而它挡的是"发布与打版不同源"。
  tagref=''
  for cand in "v$VERSION" "$VERSION"; do
    if git -C "$REPO" rev-parse -q --verify "refs/tags/$cand" >/dev/null 2>&1; then tagref="$cand"; break; fi
  done
  [[ -n "$tagref" ]] \
    || die "tag v$VERSION（或裸版本号 $VERSION）不存在 —— npm 发布应与打版同源；预演可加 --allow-untagged"
  ok "tag $tagref 存在 → $(git -C "$REPO" rev-parse --short "$tagref^{commit}")"
else
  warn '跳过 tag 检查（--allow-untagged）'
fi

# 三份模板必须存在，且必须**同时**满足两个相反方向的约束：
#   · version 是占位符 —— 若有人手改成了真实版本，说明版本注入被绕过，拒绝；
#   · private = true  —— 这是**误发护栏**：模板目录里的 `qialike.exe` 并不存在
#     （二进制由本脚本拷进暂存副本），而且没有 `version` 真值，所以直接
#       cd packages/npm/<pkg> && npm publish
#     绝不能发出去。npm 在**上传层**（libnpmpublish）无条件抛 EPRIVATE，所以上面
#     这条命令会以明确错误结束、一个字节都不会上传；本脚本在暂存时把这个字段
#     删掉（见第 4 步）才放行。
#   注意：**不能用 `npm publish --dry-run` 验证这条护栏** —— dry-run 不调用上传层，
#   对 private 包照样返回 0。所以这里显式断言，第 4 步剥完再断言一次。
for p in "$MAIN" "${PLATFORM_PKGS[@]}"; do
  t="$NPM_DIR/$(tdir "$p")/package.json"
  [[ -f "$t" ]] || die "缺少模板 $t"
  tv="$(node -p "require('$t').version")"
  [[ "$tv" == '0.0.0-template' ]] \
    || die "$t 的版本是 $tv，不是占位符 0.0.0-template —— 模板不应带真实版本，版本由本脚本注入"
  tp="$(node -p "String(require('$t').private)")"
  [[ "$tp" == 'true' ]] \
    || die "$t 的 private 不是 true —— 误发护栏缺失：直接在该目录 npm publish 会发出 0.0.0-template 垃圾版本。请恢复 \"private\": true"
done
ok "三份模板就位（版本占位符 0.0.0-template；private=true 误发护栏在位）"

# ---- 3. 前置：二进制齐备且看着对 --------------------------------------------
bold '二进制产物'
declare -A EXE_PATH=() EXE_NAME=()
for spec in "${TARGETS[@]}"; do
  pkg="${spec%%|*}"; rest="${spec#*|}"; dir="${rest%%|*}"; bin="${rest##*|}"
  exe="$DIST/$dir/$bin"
  [[ -f "$exe" ]] || die "缺少 $exe —— 先跑 ⓪ 编译（release-menu.sh 第 1 项 / build-qialike.sh $VERSION）"
  bytes="$(stat -c %s "$exe" 2>/dev/null || stat -f %z "$exe")"
  [[ "$bytes" -ge "$MIN_EXE_BYTES" ]] \
    || die "$exe 只有 $bytes B（< 下限 $MIN_EXE_BYTES）—— 构建可能被截断，拒绝发布"
  # 魔数校验（实测值）：防的是把别的平台产物拷进来。目前只发 windows-*，
  # 另两族保留 —— 将来加回非 Windows 目标时不会静默失去校验。
  magic="$(node -e 'const b=require("fs").readFileSync(process.argv[1]).subarray(0,4);process.stdout.write(b.toString("hex"))' "$exe")"
  case "$dir" in
    linux-*)   [[ "$magic" == '7f454c46' ]] || die "$exe 不是 ELF 可执行文件（实际 $magic）" ;;
    darwin-*)  [[ "$magic" == 'cffaedfe' ]] || die "$exe 不是 Mach-O 可执行文件（实际 $magic）" ;;
    windows-*) [[ "$magic" == 4d5a* ]] || die "$exe 不是 PE 可执行文件（缺 MZ 头，实际 $magic）" ;;
  esac
  EXE_PATH["$pkg"]="$exe"; EXE_NAME["$pkg"]="$bin"
  printf '  [ok]   %-24s %s B (%.1f MiB)\n' "$pkg" "$bytes" "$(node -p "$bytes/1048576")"
done

# ---- 4. 暂存：注入版本，把二进制拷进平台包 ----------------------------------
bold '暂存'
STAGING="$(mktemp -d)"
say "暂存目录 = $STAGING（发布后自动清理）"

stage() { # $1 = 包名
  local pkg="$1" src="$NPM_DIR/$(tdir "$1")" dst="$STAGING/$(tdir "$1")"
  mkdir -p "$dst"
  cp -R "$src/." "$dst/"
  node - "$dst/package.json" "$VERSION" <<'NODE'
const fs = require('node:fs')
const [file, version] = process.argv.slice(2)
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
manifest.version = version
// 剥掉模板的误发护栏。模板带 `private: true` 是为了让「在模板目录里直接
// npm publish」以 EPRIVATE 失败；这份暂存副本正是**要**发布的东西，必须去掉，
// 否则 npm 连它一起拒（第 6 步会断言这一行确实生效）。
delete manifest.private
// 主包的 optionalDependencies 必须**精确**指向本次要发的平台版本：范围
// （^ / ~）会让 npm 去解析「最接近的已发布版本」，可能拿到上一次的包。
if (manifest.optionalDependencies) {
  for (const name of Object.keys(manifest.optionalDependencies)) {
    manifest.optionalDependencies[name] = version
  }
}
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
NODE
}
for spec in "${TARGETS[@]}"; do
  pkg="${spec%%|*}"
  stage "$pkg"
  cp "${EXE_PATH[$pkg]}" "$STAGING/$(tdir "$pkg")/${EXE_NAME[$pkg]}"
  ok "暂存 $pkg（+ ${EXE_NAME[$pkg]}）"
done
stage "$MAIN"
ok "暂存 $MAIN"

# 剥护栏这一步必须**显式验证**：`npm publish --dry-run` 对 private 包返回 0
# （它不调用上传层），所以预检抓不到"忘了删 private"。这里直接读暂存副本断言，
# 一个字段都不许残留。
for p in "${PLATFORM_PKGS[@]}" "$MAIN"; do
  sv="$(node -p "require('$STAGING/$(tdir "$p")/package.json').version")"
  sp="$(node -p "String(require('$STAGING/$(tdir "$p")/package.json').private)")"
  [[ "$sv" == "$VERSION" ]] || die "暂存副本 $p 的版本是 $sv，应为 $VERSION"
  [[ "$sp" == 'undefined' ]] || die "暂存副本 $p 仍带 private=$sp —— 护栏没剥掉，npm 会以 EPRIVATE 拒绝发布"
done
ok "暂存副本已剥掉 private、版本已注入 $VERSION"
say "主包 optionalDependencies = $(node -p "JSON.stringify(require('$STAGING/$(tdir "$MAIN")/package.json').optionalDependencies)")"

# ---- 5. 打包预检：内容与体积 -------------------------------------------------
bold '打包预检（npm pack --dry-run）'
for pkg in "${PLATFORM_PKGS[@]}" "$MAIN"; do
  say "── $pkg"
  ( cd "$STAGING/$(tdir "$pkg")" && npm pack --dry-run 2>&1 | sed 's/^/    /' )
done

if [[ "$DRY_RUN" == 1 ]]; then
  bold 'dry-run 结束'
  say '没有上传任何东西，也没有读取凭据。'
  say "去掉 --dry-run 即真发布；发布顺序为：${#PLATFORM_PKGS[@]} 个平台包 → 主包 $MAIN。"
  exit 0
fi

# ---- 6. 凭据与确认 -----------------------------------------------------------
bold '凭据'
# npm **不读** NODE_AUTH_TOKEN / NPM_TOKEN（实测：npm 10.9.8 的源码、docs、man 里都没有
# 这个名字；只设该环境变量时 `npm whoami` 报 ENEEDAUTH）。npm 的凭据只来自配置里的
# **nerf-dart 键** —— `//<registry>/:_authToken` —— 而该键可以来自 .npmrc（支持 ${ENV}
# 展开）、CLI 参数，或 `npm_config_<键>` 环境变量。
#
# 所以「环境里有 token」远不等于「能发布」，唯一可信的判据是 `npm whoami` 真的成功。
# 本脚本把 token 接成 `npm_config_<nerf-dart 键>` 只传给 npm **子进程的环境**（不写盘、
# 不进 argv，所以不出现在 `ps` 的 command line 里），这样文档里的 CI 用法才真的成立。
REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org/}"
NERF="//${REGISTRY#*://}"
TOKEN="${NODE_AUTH_TOKEN:-${NPM_TOKEN:-}}"

# 所有 npm 调用都走它：有 token 就注入子进程环境，没有就直连（靠 ~/.npmrc 里的登录态）。
npm_auth() {
  if [[ -n "$TOKEN" ]]; then
    env "npm_config_${NERF}:_authToken=$TOKEN" npm "$@"
  else
    npm "$@"
  fi
}

if [[ "$OIDC" == 1 ]]; then
  # OIDC 路径：**没有 token 可查，也不该去查**。授权由注册表按该包预登记的 trusted
  # publisher 规则判定 —— 仓库 + workflow 文件名 + environment 必须与 OIDC 令牌的
  # claim 匹配；匹配则放行，不匹配则拒绝，与 2FA 挑战/长期令牌都无关。
  npmver="$(npm --version 2>/dev/null || echo 0.0.0)"
  if ! node -e '
    const [have, want] = process.argv.slice(1)
    const num = (s) => {
      const p = s.split("-")[0].split(".").map((n) => Number.parseInt(n, 10) || 0)
      return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0]
    }
    const [a, b] = [num(have), num(want)]
    // 括号是关键：`a || b || c >= 0` 会把 `>= 0` 只作用在 c 上，
    // 于是 10.9.8 会被当成"满足 ≥ 11.5.1"（这条被 tests/publish-npm-oidc.test.ts 抓到过）。
    process.exit(((a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2])) >= 0 ? 0 : 1)
  ' "$npmver" 11.5.1; then
    die "OIDC 需要 npm CLI ≥ 11.5.1（当前 $npmver）—— npm 从该版本起才识别 OIDC 环境。
   CI 里先 \`npm i -g npm@^11\`；本机 npm 太旧请先升级，或改走令牌路径。"
  fi
  if [[ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ]]; then
    ok "使用 OIDC（npm $npmver）—— 跳过凭据预检；授权由注册表按 trusted publisher 规则判定"
  else
    warn "指定了 --oidc，但环境里没有 ACTIONS_ID_TOKEN_REQUEST_URL —— 本机通常不该走这条路；"
    warn "  npm 会在 publish 时以 ENEEDAUTH 失败。"
  fi
  [[ -n "$TOKEN" ]] && warn "同时检出 token 环境变量：npm CLI 会**优先**用 OIDC，令牌只作回退"
else
# ---- 令牌路径的预检（OIDC 下整段跳过） ----
if [[ -n "$TOKEN" ]]; then
  say "检出 token 环境变量（值不回显）；以 npm_config_${NERF}:_authToken 注入本次调用的子进程环境"
fi
if whoami_out="$(npm_auth whoami 2>&1)"; then
  ok "npm 凭据可用：$whoami_out"
elif printf '%s' "$whoami_out" | grep -qE 'E403|403|Forbidden'; then
  # **403 不是「令牌坏」，而是「读不到账号信息」** —— 这对 Granular Access Token 是正常表现：
  # `npm whoami` 打的是**账号级**接口 `/-/whoami`，而 GAT 的授权是围绕**包**的。
  # 2026-09-27 实测：一枚「全部包 read/write + bypass 2FA」的 GAT 依然在此得到 403，
  # 若据此否决就会把一次完全可行的发布挡死（当时就是这样挡住了）。
  # 因此**不据此否决**，交给注册表在真正 publish 时判定：若它连"创建包"也不行，
  # 第一次 publish 就会失败，而那时**一个包都还没发出去**，不会留下半截状态。
  warn "npm whoami 返回 403 —— **不据此否决**（Granular token 读不了账号级接口属正常）"
  warn "  交给注册表在 publish 时判定；失败时本脚本会说明已发/未发了哪些包"
elif [[ -n "$TOKEN" ]]; then
  die "token 被注册表拒绝（$(printf '%s' "$whoami_out" | head -1)）
   —— 检查它是否已过期、是否有 **Read and write** 权限、以及**是否允许绕过 2FA**
      （Granular Access Token 勾了 \"bypass 2FA\" 才能在无人值守时发布；否则要加 --otp）"
else
  die "npm 未登录，且环境里没有 token。
   · 交互：npm login（写入 ~/.npmrc）
   · CI：export NODE_AUTH_TOKEN=<Granular Access Token>，然后重跑本脚本
     （注意：npm 自身不读这个环境变量 —— 是本脚本把它接成 npm_config_ 键。
       若你要**手跑** npm publish，得自己在 ~/.npmrc 写一行：
         ${NERF}:_authToken=\${NODE_AUTH_TOKEN}）
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
[[ "$PROVENANCE" == 1 ]] && PUBLISH_ARGS+=(--provenance)

DONE=()
publish_one() { # $1 = 包名
  local pkg="$1" log existing
  # **幂等续跑**（2026-09-27 加）：首次发布常需「会话令牌 + 每包一个 OTP」，而 OTP 寿命约 30 秒，
  # 三个包几乎必然中途过期。若不做幂等，失败一次之后重跑会卡在**已发布的那个包**上
  # （npm 拒绝重复发布），后面的包就永远发不出去。查的是公开的 registry，不需要凭据。
  if existing="$(npm view "$pkg@$VERSION" version 2>/dev/null)" && [[ "$existing" == "$VERSION" ]]; then
    say "$pkg@$VERSION 已存在 —— 跳过（幂等续跑）"
    DONE+=("$pkg")
    return 0
  fi
  # 用 tee 既保留 npm 的实时输出，又把这段留下来做失败归类（管道 + pipefail ⇒ if 看的是 npm 的退出码）
  log="$(mktemp)"
  say "发布 $pkg@$VERSION …"
  if ( cd "$STAGING/$(tdir "$pkg")" && npm_auth publish "${PUBLISH_ARGS[@]}" ) 2>&1 | tee "$log"; then
    rm -f "$log"
    DONE+=("$pkg")
    ok "$pkg 已发布"
  else
    printf '\n' >&2
    bad "$pkg 发布失败"
    # **首次发布最常见的失败：令牌没有"创建包"的权限，而注册表把它伪装成 404（不是 403）。**
    # 实测（2026-09-27）：一枚「all packages read/write + bypass 2FA」的 Granular Access Token
    # 依然会在 PUT 新包时得到 `E404 … Not found` —— 因为 "all packages" 指的是**所有已存在的包**。
    # 修法：用能创建包的凭据做**一次 bootstrap**（`npm login` 的会话令牌，或 Classic 的
    # Automation 令牌）；三个包一旦存在，GAT 即可发布后续版本。
    if grep -qE 'Two-factor authentication or granular access token' "$log"; then
      warn "注册表要求 **2FA 挑战**：当前凭据不能绕 2FA，必须显式给一次性码"
      warn "  npm **不会**为这类 403 自动提示 OTP（它只在 EOTP 上提示），所以请重跑并加 --otp："
      warn "      ./release-menu.sh 12 --allow-dirty --otp <6 位码>"
      warn "  码的有效期很短（约 30 秒），三个包可能要**各用一次**；"
      warn "  已发布的包会被自动跳过，所以「一包一码、失败就重跑」是可行节奏。"
      warn "  另一条路：用 Classic token 里的 **Automation** 类型（既能创建包、又能绕 2FA）。"
    fi
    if grep -qE 'E404' "$log" && grep -qE 'PUT https://[^ ]+/' "$log"; then
      warn "注册表对 **PUT 一个新包** 回了 404 —— 这通常不是"包名有问题"，而是"这个令牌不能创建包""
      warn "  （npm 把这类授权失败**伪装成 404**，所以看不到 403）。"
      warn "  Granular Access Token 的 \"all packages\"＝**所有已存在的包**；三个包都还不存在时它一个都不覆盖。"
      warn "  修法：先用能创建包的凭据做**一次 bootstrap**（\`npm login\` 的会话令牌最省事；"
      warn "        或 npm 网页上 Classic token 里的 Automation 类型），三个包存在后 GAT 即可发后续版本。"
    fi
    rm -f "$log"
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
for pkg in "${PLATFORM_PKGS[@]}"; do publish_one "$pkg"; done
publish_one "$MAIN"

bold '完成'
ok "已发布：${DONE[*]}"
printf -v VERIFY_LINES '      npm view %s version os cpu dist.unpackedSize\n' "${PLATFORM_PKGS[@]}"
cat <<EOF

  验证（无需目标机器 —— 注册表元数据就能看全）：
      npm view $MAIN version dist-tags optionalDependencies
$VERIFY_LINES
  真实安装（各自平台上一条命令）：
      npm i -g $MAIN
      qialike --version

  回滚：npm 在 72 小时后禁止删除版本 —— 发错了用
      npm deprecate <pkg>@$VERSION "<原因>"
  然后抬版本重发。
EOF
