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
#   ./publish-npm.sh --dispatch          # ★ 本机触发 CI 里的 OIDC 发布并跟踪它（推荐）
#   ./publish-npm.sh -h
#
# 三条发布路径（**OIDC 与长期令牌互斥，且只有前两条能真正上传**）：
#   ① `--dispatch`（推荐）：**本机只触发与跟踪**，真正 publish 的是 GitHub Actions。
#      trusted publishing 的凭据是 CI 每次运行现换的短期 OIDC 令牌，**本机签不出来** ——
#      所以 OIDC 发布只能发生在 CI 里，这条路把「在本机按一次」与「发布在 CI 里」接起来。
#      需要：gh CLI 已认证、默认分支上有 publish-npm.yml、该版本的 Release 资产齐备。
#   ② `--oidc`（**在 CI 内部**由工作流调用；本机手跑无意义）：直接走 OIDC 发布。
#      或 CI 里自动识别 `ACTIONS_ID_TOKEN_REQUEST_URL`（不需要任何长期令牌）。
#   ③ 长期令牌（回退路径）：环境变量 NODE_AUTH_TOKEN / NPM_TOKEN。**npm 本身不读它们**；
#      本脚本把它们接成 `npm_config_//<registry>/:_authToken` 传给 npm 子进程（不写盘、
#      不进 argv）。手跑 npm publish 时请自行在 ~/.npmrc 写
#      `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}`。NPM_REGISTRY 可换注册表。
#      **不要**把 token 写进仓库；本脚本只读环境。
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

# 模板里由本脚本注入真值的两处，占位符是同一个：
#   · `package.json` 的 `version` 与 `optionalDependencies`（见第 2 步与 stage()）；
#   · 主包 README 里的重装示例 —— **npm 的包页面就是这份 README**，写死一个真版本号
#     会在下一次发版时变成一条错误的命令，而没有任何东西会报错。2026-09-30 的首包
#     就是这么来的：仓库里写着 `@0.8.2`，发出去的却是 0.8.1（只因那一代的 README 恰好
#     是 0.8.1 才没错位）。占位符把「忘记改文档」从页面上的错误变成发布前的 `die`。
PLACEHOLDER='0.0.0-template'
# 「写死版本的安装示例」形状：`@qialike/<pkg>@1.2.3`（`^` / `~` 与预发布后缀也算）。
# ⚠️ 占位符**本身就是一个合法的 semver**（`0.0.0-template` = 0.0.0 的 template 预发布），
# 所以这条正则连占位符一起匹配 —— 判据因此是「凡是钉了版本的示例，都必须是占位符」，
# 而不是「没有任何钉了版本的示例」。
PINNED_EXAMPLE_RE='@qialike/[A-Za-z0-9._-]+@[\^~]?[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?'

# 包名 → 模板目录名（同时也是暂存目录名）：去掉 scope 前缀、'/' 换成 '-'。
# 目录名里不出现 '@' 或嵌套路径，cp/mktemp 与人工排查都省事。
tdir() { local n="${1#@}"; printf '%s' "${n//\//-}"; }

PLATFORM_PKGS=()
for spec in "${TARGETS[@]}"; do PLATFORM_PKGS+=("${spec%%|*}"); done

# 二进制体积下限：真实产物 x64 131.6 MB / arm64 123.5 MB。低于此值几乎一定是
# 构建被截断或拷错了文件，宁可在这里挡住，也不要把半个二进制发上注册表。
MIN_EXE_BYTES=$((40 * 1024 * 1024))

# 发布后确认（post-publish verification）的探测参数：`npm publish` 返回之后，注册表
# **提交**该版本还要一段时间，所以「npm 说成功」不代表立刻能被解析 —— 必须轮询到真的
# 能解析为止。**这段延迟实测 100–130 s，且与 provenance 强相关**：
#
#   发布形态                  attestations   当时的窗口   结果
#   0.9.0（手动令牌）          无             30 s        三包全成 ⇒ 延迟 < 30 s
#   #5 x64（OIDC）            有             30 s        超时（延迟 ≈ 98 s）
#   #7 arm64（OIDC）          有             120 s       超时（延迟 ≈ 127 s）
#   #8 主包（OIDC）           有             300 s       超时（延迟 ≈ 630 s）
#
# 延迟的算法：#N 的第 10 步「结束时刻 − 窗口」≈ `npm publish` 返回时刻，注册表记录的
# `time` 减去它就是延迟（如 #8：19:16:06 − 300 s = 19:11:06，而记录是 19:21:36.771）。
# 没有 provenance 时几乎瞬时（0.9.0 在 30 s 窗口里连发三包）⇒ 慢的是**带 attestation
# 的这次写入**，不是网络抖动；而且延迟**方差极大**（98 s → 127 s → 630 s，同一个
# registry、同一个包类型），所以窗口必须按最大值而不是中位数定。
#
# ★ 注意 #8 揭示的一个**危险形态**：那一轮的包**其实发布成功了**，只是注册表在脚本
#   放弃之后才提交（19:21:36 才可见）⇒ 工作流报 failure，而 npm 上货真价实。也就是说
#   这个确认门在延迟超过窗口时会**产生假失败**，而脚本会因此**停住、不发后面的包**
#   （#8 里主包是最后一个，所以没造成后果）。
#
# ⇒ 默认 **60 × 15 s = 900 s**（2026-10-02 由 10×3 → 20×6 → 20×15 → 这里）：观测最大
# 630 s 的 1.4 倍。四次放宽都**只动等待时长**，「先确认再发下一个包」这道顺序保证
# **从不削弱** —— 它正是防止主包先于平台包上线的东西（主包的 optionalDependencies
# 指向平台包，先发主包会让用户在窗口期内解析到不存在的载荷）。
#
# 注意：`npm publish` 若**非零退出**，脚本立即中止、**不会**在这里等 —— 所以 300 s 的
# 等待只可能发生在「上传成功但还没可见」这一种情形。
# 测试用这两个变量把等待压到接近零（与 QIALIKE_DIST 同类：只影响预演/测试）。
CONFIRM_ATTEMPTS="${QIALIKE_PUBLISH_CONFIRM_ATTEMPTS:-60}"
CONFIRM_INTERVAL="${QIALIKE_PUBLISH_CONFIRM_INTERVAL:-15}"

VERSION=''
DIST_TAG='latest'
OTP=''
OIDC=0
DISPATCH=0
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

# ★ 发布确认：**上一个包真的落地了，才允许推下一个。**
#
# 为什么不能只信 `npm publish` 的退出码：退出码只说明「这次上传动作没报错」，它不证明
# 注册表已经能解析该版本 —— 写入与读路径的可见性之间有传播延迟（秒级）。而本渠道的语义
# 恰恰要求「平台包先真的可解析，主包才能发」：主包的 optionalDependencies **精确**指向
# 两个平台包，若平台包只是"npm 说成功了"却没落地，用户 `npm i -g @qialike/cli` 会解析到
# 一个不存在的载荷（npm 对解析不到的 optional 依赖**静默跳过**），安装"成功"但跑不起来。
#
# 所以每个包发布后都轮询注册表，直到 `npm view <pkg>@<version> version` 回出本次版本；
# 拿到之后再记录注册表自己的指纹（dist.shasum / dist.integrity）—— 那是「发上去的就是
# 我们打的那个包」事后唯一可核对的证据。确认不了就**停在原地**（die），绝不推进到下一个。
#
# 定义位置在**所有调用点之前**：dispatch 路径（第 2b 步）与本地发布路径（第 7 步）都用它，
# 而 bash 的函数是在脚本自上而下执行到定义处才存在的 —— 放在第 7 步旁边会让 dispatch 那侧
# 拿到 `command not found`。
confirm_published() { # $1 = 包名；0 = 已在注册表确认可见
  local pkg="$1" got meta attempt
  for ((attempt = 1; attempt <= CONFIRM_ATTEMPTS; attempt++)); do
    if got="$(npm view "$pkg@$VERSION" version 2>/dev/null)" && [[ "$got" == "$VERSION" ]]; then
      meta="$(npm view "$pkg@$VERSION" dist.shasum dist.integrity 2>/dev/null | tr '\n' ' ' | sed 's/ *$//')"
      ok "  ↳ 注册表已确认 $pkg@$VERSION（第 $attempt 次探测）"
      [[ -n "$meta" ]] && say "    注册表指纹：$meta"
      return 0
    fi
    sleep "$CONFIRM_INTERVAL"
  done
  return 1
}

usage() { sed -n '2,/^set -euo pipefail$/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --yes | -y) ASSUME_YES=1 ;;
    --version) VERSION="${2:-}"; shift ;;
    --tag) DIST_TAG="${2:-}"; shift ;;
    --otp) OTP="${2:-}"; shift ;;
    --oidc) OIDC=1 ;;
    --dispatch) DISPATCH=1 ;;
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
  [[ "$tv" == "$PLACEHOLDER" ]] \
    || die "$t 的版本是 $tv，不是占位符 $PLACEHOLDER —— 模板不应带真实版本，版本由本脚本注入"
  tp="$(node -p "String(require('$t').private)")"
  [[ "$tp" == 'true' ]] \
    || die "$t 的 private 不是 true —— 误发护栏缺失：直接在该目录 npm publish 会发出 $PLACEHOLDER 垃圾版本。请恢复 \"private\": true"
  # README 同样只允许占位符。这份文件会**原样成为 npm 包页面**，写死的版本号在下次
  # 发版时就是一条会误导用户的命令，而且发布流程本身不会察觉 —— 所以在这里挡。
  # 判据：凡是钉了版本的示例，都必须是占位符（占位符本身也是 semver，见上面的常量注释）。
  r="$NPM_DIR/$(tdir "$p")/README.md"
  if [[ -f "$r" ]]; then
    pinned="$(grep -oE "$PINNED_EXAMPLE_RE" "$r" 2>/dev/null || true)"
    hardcoded="$(printf '%s\n' "$pinned" | grep -vF "@$PLACEHOLDER" | grep -v '^$' | head -1 || true)"
    [[ -z "$hardcoded" ]] \
      || die "$r 里有一处写死版本的安装示例（$hardcoded）—— 它会被发布到 npm 页面并在下次发版时过期。改成 @$PLACEHOLDER，版本由本脚本注入"
  fi
done
# …而且主包的 README 必须**仍然带**占位符。少了这条，"把示例整段删掉 / 换个写法"
# 就会悄悄绕过上面那道检查（少写一个事实，就少一道检查）。
MAIN_README="$NPM_DIR/$(tdir "$MAIN")/README.md"
[[ -f "$MAIN_README" ]] || die "缺少主包 README $MAIN_README（npm 包页面就是它）"
grep -qF "@$PLACEHOLDER" "$MAIN_README" \
  || die "$MAIN_README 里没有 @$PLACEHOLDER 占位符 —— 重装示例必须以占位符形式存在，版本由本脚本注入"
ok "三份模板就位（版本占位符 $PLACEHOLDER；private=true 误发护栏在位；README 无写死版本）"

# ---- 2b. --dispatch：本机触发 CI 里的 OIDC 发布 ------------------------------
# 为什么需要它：trusted publishing 的凭据是 GitHub Actions 每次运行**现换的短期 OIDC
# 令牌**，本机签不出来 —— 所以 OIDC 发布只能发生在 CI 里。这条路把「在本机按一次」与
# 「发布发生在 CI 里」接起来：本机只负责触发与跟踪，真正 publish 的是工作流。
# 它照样复用上面第 2 步的版本一致性 / 工作区 / 标签校验，但**不需要本机 dist**：
# 工作流下载的是已归档的 Release 资产（§8.3「发布必须来自已归档产物」）。
if [[ "$DISPATCH" == 1 ]]; then
  bold '本机触发 CI（OIDC 发布）'
  [[ "$OIDC" == 0 ]] || die "--dispatch 与 --oidc 互斥：--oidc 是「在 CI 内部」用的，--dispatch 是「从本机触发 CI」"
  [[ -z "$OTP" ]] || die "--dispatch 与 --otp 互斥：OIDC 发布不需要一次性码 —— 那正是它要取代的东西"
  command -v gh >/dev/null 2>&1 \
    || die "找不到 gh CLI —— 本机触发 CI 需要它（https://cli.github.com）；或改走长期令牌路径"

  SLUG="${GITHUB_REPO:-}"
  if [[ -z "$SLUG" ]]; then
    # 先剥 `.git` 再取 owner/repo：**POSIX ERE 没有惰性量词**（`+?` 不是"尽量少匹配"），
    # 把 `(\.git)?` 写进同一条正则会让 `[^/]+` 贪婪吃掉 `.git`，于是 slug 变成
    # `qialike/qialike.git` —— 实测踩到过，gh api 会回 404 并伪装成"工作流不存在"。
    SLUG="$(git -C "$REPO" remote get-url origin 2>/dev/null \
      | sed -E 's#\.git$##; s#^.*[:/]([^/]+/[^/]+)$#\1#')" || SLUG=''
  fi
  [[ -n "$SLUG" ]] || die "无法确定 GitHub 仓库 —— 请 export GITHUB_REPO=owner/repo"
  WF='publish-npm.yml'

  # gh 的凭据：它自己认 GH_TOKEN / GITHUB_TOKEN；两者都没有时才看它的登录态。
  if [[ -z "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ]] && ! gh auth status >/dev/null 2>&1; then
    die "gh 未认证 —— export GH_TOKEN=<带 workflow 权限的令牌>，或先跑 gh auth login"
  fi
  ok "gh 可用，仓库 $SLUG，工作流 $WF"

  # ① 工作流必须在**默认分支**上：workflow_dispatch 只认默认分支里的工作流文件。
  #    这里按状态码分类，而不是把任何失败都归成"工作流不存在" —— 实测一枚无效令牌会让
  #    gh api 回 401，而笼统报"默认分支上没有该工作流"会把人送去推 main（白费一趟）。
  wf_err="$(gh api "repos/$SLUG/contents/.github/workflows/$WF" 2>&1 >/dev/null)" || {
    # 先**去掉全部空白**再匹配：gh 的报错体是美化过的 JSON（`"status": "401"`），
    # 但那是它的展示选择、不是契约 —— 紧凑形式（`"status":"401"`）同样合法，而
    # `case` 只能做通配匹配。归一化之后两种形态命中同一条分支（这条被
    # tests/publish-npm-dispatch.test.ts 抓到过：只写带空格的模式时 404 会掉进兜底分支）。
    flat="${wf_err//[[:space:]]/}"
    case "$flat" in
      *'"status":"401"'* | *Badcredentials*)
        die "GitHub 令牌无效（401）—— 换一个令牌后重跑" ;;
      *'"status":"403"'*)
        die "令牌无权读 $SLUG（403）—— 需要该仓库的读权限（classic 令牌的 repo scope）" ;;
      *'"status":"404"'*)
        die "默认分支上没有 .github/workflows/$WF —— workflow_dispatch 只认默认分支上的工作流（需要先推 main）" ;;
      *)
        die "查询工作流失败：$(printf '%s' "$wf_err" | head -1)" ;;
    esac
  }
  ok "工作流在默认分支上（workflow_dispatch 可达）"

  # ② Release 与资产：工作流下载它们发布，不在 CI 里重新编译。
  assets="$(gh release view "$VERSION" --repo "$SLUG" --json assets --jq '.assets[].name' 2>/dev/null || true)"
  [[ -n "$assets" ]] || die "GitHub Release $VERSION 不存在或取不到 —— 先做 ⑪ 推送（release-menu.sh 11）"
  for a in qialike-windows-x64.zip qialike-windows-arm64.zip sha256sums.txt; do
    grep -qx "$a" <<<"$assets" || die "Release $VERSION 缺少资产 $a —— 工作流靠它发布，先补 ⑪"
  done
  ok "Release $VERSION 的 Windows 两个 zip 与 sha256sums.txt 齐备"

  DRY_INPUT='false'
  [[ "$DRY_RUN" == 1 ]] && DRY_INPUT='true'
  if [[ "$ASSUME_YES" == 0 ]]; then
    printf '\n  将通过 GitHub Actions 触发 %s 的 npm 发布（dry_run=%s）：\n' "$VERSION" "$DRY_INPUT"
    printf '      三个包（两个平台包 → 主包）会**不可撤销地**发布（72 小时后禁止删除）。\n'
    printf '  继续？[y/N] '
    read -r reply || reply=''
    case "$reply" in
      y | Y | yes | YES) ;;
      *) die '已取消（没有触发任何东西）' ;;
    esac
  fi

  # 记下触发前已有的运行 id：GitHub 接受 dispatch 后**不返回 run id**，而列表有注册延迟，
  # 所以「最新一次」可能仍是上一次的。用差集挑出本次那次，比赌"最新"稳。
  before="$(gh run list --repo "$SLUG" --workflow "$WF" --event workflow_dispatch --limit 30 \
              --json databaseId --jq '.[].databaseId' 2>/dev/null || true)"
  gh workflow run "$WF" --repo "$SLUG" -f "version=$VERSION" -f "dry_run=$DRY_INPUT" \
    || die "gh workflow run 失败 —— 令牌是否带 workflow 权限？"
  ok "已触发 workflow_dispatch（version=$VERSION, dry_run=$DRY_INPUT）"

  run_id=''
  for _ in $(seq 1 30); do
    now="$(gh run list --repo "$SLUG" --workflow "$WF" --event workflow_dispatch --limit 30 \
             --json databaseId --jq '.[].databaseId' 2>/dev/null || true)"
    run_id="$(comm -13 <(printf '%s\n' "$before" | sort -u) <(printf '%s\n' "$now" | sort -u) | head -1)"
    [[ -n "$run_id" ]] && break
    sleep 2
  done
  [[ -n "$run_id" ]] || die "触发了，但没认出本次运行 —— 打开 https://github.com/$SLUG/actions/workflows/$WF 查看"
  say "本次运行 = https://github.com/$SLUG/actions/runs/$run_id"

  # `environment: npm-publish` 若配了 required reviewers，运行会停在 waiting 等人工批准，
  # 而 `gh run watch` 会一直等 —— 所以先说清楚再等，别让人以为卡死了。
  warn "若该 run 停在 waiting：那是 npm-publish 环境配了 required reviewers，去上面的链接批准即可"
  gh run watch "$run_id" --repo "$SLUG" --exit-status \
    || die "CI 运行失败 —— 见 https://github.com/$SLUG/actions/runs/$run_id"
  ok "CI 运行成功"

  # ★ 逐包确认落地。CI 里是工作流在逐包发布（它自己也在发布后确认），而本机这一侧能做的
  #   是把**最终三包是否真的可解析**再核一遍 —— 「CI 绿了」与「注册表能看到」不是同一件事，
  #   而后者才是用户 `npm i -g` 时真正依赖的。任何一个没落地就报失败，别让它看起来像成功。
  bold '确认发布落地（三个包逐一核对注册表）'
  CONFIRM_FAILED=()
  for pkg in "${PLATFORM_PKGS[@]}" "$MAIN"; do
    if confirm_published "$pkg"; then :; else
      bad "$pkg@$VERSION 在注册表看不到"
      CONFIRM_FAILED+=("$pkg")
    fi
  done
  if [[ ${#CONFIRM_FAILED[@]} -gt 0 ]]; then
    die "CI 报告成功，但注册表看不到：${CONFIRM_FAILED[*]} —— 见 https://github.com/$SLUG/actions/runs/$run_id"
  fi
  ok "三个包均已在注册表确认"

  bold '完成（发布已在 CI 里发生）'
  cat <<EOF

  核验（注册表元数据，不需要目标机器）：
      npm view $MAIN version dist-tags optionalDependencies
      npm view ${PLATFORM_PKGS[0]} version os cpu
      npm view ${PLATFORM_PKGS[1]} version os cpu
EOF
  exit 0
fi

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
  # README 里的占位符注入真版本（npm 包页面就是这份 README）。第 2 步已经断言
  # 模板里既没有写死的版本、又**带**着占位符，所以这里只需替换 + 复核。
  if [[ -f "$dst/README.md" ]]; then
    node - "$dst/README.md" "$PLACEHOLDER" "$VERSION" <<'NODE'
const fs = require('node:fs')
const [file, placeholder, version] = process.argv.slice(2)
const text = fs.readFileSync(file, 'utf8')
// 字面量全局替换（split/join）：占位符与版本号都进不了正则，`&`、`/`、`.` 都不是元字符。
fs.writeFileSync(file, text.split(placeholder).join(version))
NODE
  fi
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
  # README 的注入同样要**在暂存副本上**复核：占位符一个都不许残留（它会上 npm 页面），
  # 主包还必须真的带上本次版本 —— 否则就是把一条 `@0.0.0-template` 的命令公之于众。
  r="$STAGING/$(tdir "$p")/README.md"
  if [[ -f "$r" ]]; then
    if grep -qF "$PLACEHOLDER" "$r"; then
      die "暂存副本 $p 的 README 里仍残留 $PLACEHOLDER —— 版本注入没生效，绝不能发布"
    fi
    if [[ "$p" == "$MAIN" ]] && ! grep -qF "@$VERSION" "$r"; then
      die "暂存副本 $MAIN 的 README 里没有 @$VERSION —— 重装示例没拿到本次版本"
    fi
  fi
done
ok "暂存副本已剥掉 private、版本已注入 $VERSION（含 README 的重装示例）"
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
  [[ -n "$TOKEN" ]] && {
    warn "同时检出 token 环境变量（值不回显）—— 存在它就无法从**外部**断定本次用的是哪条凭据："
    warn "  OIDC 仍会被用来签 provenance，而真正那次 PUT 可能走令牌。"
    warn "  失败时看日志里有没有 'Signed provenance statement' 来分辨（有 ⇒ OIDC 路已生效，问题在注册表的授权）。"
  }
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
    ok "$pkg 已上传"
    # ★ 确认落地 —— 这一步失败就**不发下一个包**（见 confirm_published 的注释）。
    confirm_published "$pkg" || {
      bad "$pkg 上传未报错，但注册表在 ${CONFIRM_ATTEMPTS} 次探测（约 $((CONFIRM_ATTEMPTS * CONFIRM_INTERVAL)) s）内仍看不到 $VERSION"
      warn "  可能原因：注册表传播比窗口慢，或这次上传实际没有生效。"
      warn "  处置：**先别继续**，用 npm view $pkg@$VERSION version 手工确认；"
      warn "        若已可见，重跑本脚本会自动跳过它（幂等）并继续下一个包。"
      [[ ${#DONE[@]} -gt 0 ]] && warn "  已确认发布的包：${DONE[*]}"
      die "停在 $pkg（发布确认未通过，未推送后续包）"
    }
    DONE+=("$pkg")
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
      warn "      ./release-menu.sh 13 --allow-dirty --otp <6 位码>"
      warn "  码的有效期很短（约 30 秒），三个包可能要**各用一次**；"
      warn "  已发布的包会被自动跳过，所以「一包一码、失败就重跑」是可行节奏。"
      warn "  另一条路：用 Classic token 里的 **Automation** 类型（既能创建包、又能绕 2FA）。"
    fi
    # ★ 这段诊断在 2026-10-01 出过一次错，教训写在这里：**别看 provenance 签名去推断
    #   npm 的 OIDC 认证是否成功。** npm 源码（`lib/utils/oidc.js` / `commands/publish.js`
    #   与 `@sigstore/sign` 的 ci.js）显示这是两条**独立**路径：
    #     · provenance 由 sigstore **自己**向 GitHub 取 id token 来签（它直接打
    #       `ACTIONS_ID_TOKEN_REQUEST_URL`）⇒ 签名成功只证明 `id-token: write` 好用；
    #     · npm 另发一次 `POST /-/npm/v1/oidc/token/exchange/package/<pkg>` 去换发布令牌，
    #       而它**任何失败都静默返回**（只在 verbose 级别记一行）。
    #   所以一条 404 有两种成因，日志本身分不出来；而 CI 里若另有一个 token，它会**掩盖**
    #   本该响亮的 ENEEDAUTH，把「OIDC 没换成令牌」变成这条静默 404。
    if grep -qE 'ENEEDAUTH|requires you to be logged in' "$log"; then
      warn "**OIDC 换令牌失败，且没有回退凭据** —— 这是最干净的信号：npm 没能把 GitHub 的 id token"
      warn "  换成发布令牌，于是连一次 PUT 都没发出去。绝大多数情况是**该包的 trusted publisher"
      warn "  没登记或字段不匹配**（注册表只在 verbose 日志里说明原因）。"
      warn "  逐项核对（npm 网页 → 该包 → Settings → Trusted Publisher）："
      warn "    ① 仓库       = qialike/qialike"
      warn "    ② 工作流文件 = publish-npm.yml（**只写文件名**，不带 .github/workflows/ 前缀）"
      warn "    ③ environment = npm-publish（工作流声明了它；登记时**留空即不匹配**）"
      warn "  正查：npm trust list <包名>（需一枚能读该包的令牌）"
    elif grep -qE 'E404' "$log" && grep -qE 'PUT https://[^ ]+/' "$log"; then
      warn "注册表对 **PUT** 回了 404 —— npm 把授权失败**伪装成 404**（所以看不到 403）。"
      warn "  两种成因，日志分不出来："
      warn "    (a) OIDC 换令牌**成功**，但注册表按 trusted publisher 规则拒绝了这次 PUT；"
      warn "    (b) OIDC 换令牌**失败**（静默），回退到环境或 .npmrc 里的另一个凭据，而它不能发布。"
      warn "  分辨办法（唯一可靠）：把 npm 的 verbose 日志打出来 —— 在失败那一步加"
      warn "      env: { NPM_CONFIG_LOGLEVEL: verbose }"
      warn "    然后找 'oidc Failed token exchange request with body message: …'：有 ⇒ 是 (b)。"
      warn "  ⚠️ CI 环境里若存在 NODE_AUTH_TOKEN，它会把本该响亮的 ENEEDAUTH 变成这条静默 404"
      warn "     —— 排查期间建议先移除它，让失败自己说话。"
      warn "  trusted publisher 逐项核对（npm 网页 → 该包 → Settings → Trusted Publisher）："
      warn "    ① 仓库 = qialike/qialike  ② 工作流文件 = publish-npm.yml（只写文件名）  ③ environment = npm-publish"
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
