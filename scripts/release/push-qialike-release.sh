#!/usr/bin/env bash
#
# push-qialike-release.sh — 把一次发布构建的产物推到 GitHub 与 gitcode
#
# 本脚本（仓库内 `scripts/release/`，与 build/tag/release-archive 同居）负责 §9.4.11
# 「第 2 步：发布」里那一步。**它自身不含任何凭据** —— 令牌只从环境变量读（见下），
# 所以进仓库是安全的，也因此可以随源码归档一起分发。
#
# 推什么：**完全由 `dist/sha256sums.txt` 决定** —— 上传的就是清单里列出的资产，外加清单
# 自身。上传前逐个复算 sha256 并与清单比对，所以"清单"与"被上传的字节"在结构上不可能
# 不一致（不一致时脚本在上传任何东西之前就退出）。
#
# 用法（脚本自行定位仓库根，与 cwd 无关，所以不必先 cd 到某处）：
#   ./scripts/release/push-qialike-release.sh              # 版本取自 package.json
#   ./scripts/release/push-qialike-release.sh 0.7.1        # 显式指定版本
#   ./scripts/release/push-qialike-release.sh --dry-run    # 只打印计划：不联网、不需要凭据
#   ./scripts/release/push-qialike-release.sh --source github   # 只推一个源（github|gitcode|both，默认 both）
#   ./scripts/release/push-qialike-release.sh --verify-only     # 不上传，只核对两个源上的清单
#
# 典型用法（发布时照抄）：
#
#   export GITHUB_TOKEN=ghp_xxx
#   export GITCODE_TOKEN=xxx
#   ./scripts/release/push-qialike-release.sh                 # 版本取自 package.json
#   ./scripts/release/push-qialike-release.sh --source github # 先只推一个源试试
#
# 标签同步（推送 release 之前自动做）：**远端 tag 必须与本地一致**。本地用
# `tag-qialike.sh --move` 挪过标签时，远端那个还指向旧提交，脚本会删掉它再推本地这个。
# 两端 SHA 相同时不做任何事（删了再推同样的 ref 没有收益，只会让标签短暂消失）。
# 之所以必须在建 release 之前做：两个源的 release API 在 tag 不存在时不会报错，它们会用
# 默认分支 HEAD 当场自建一个 tag，从而发布出指向错误提交的 release。
# `--allow-missing-tag` 跳过同步，把这件事交给源的 API。
#
# 远端前置检查（在推任何东西之前，先检查**所有**目标 remote）：用 `git ls-remote`
# 确认每个 remote 拼对了、连得上、读得到。**它不能证明你有写权限** —— 实测
# `git push --dry-run` 在一个只读远端上照样返回 0（它协商完就结束，不更新 ref），所以
# 拿它当"推送权限检查"是虚假信心，本脚本刻意不做。真正证明写权限的只有一次真实推送，
# 而标签同步就是那一次，且它排在**任何资产上传之前**：凭据或权限不对时，一个字节都还没
# 传上去。失败时脚本会把 git 的原文翻译成"该去配什么"（SSH 公钥 / HTTPS 令牌 / 写范围 /
# 库名 / DNS）。
#
# 用到的 remote（可覆盖）：GITHUB_REMOTE 默认 `origin`；GITCODE_REMOTE 默认 `gitcode`。
# 两者都接受 remote 名或 URL；缺哪个就在那一步明确报错。
#
# 凭据**分两类，别混**（这是本流程最容易踩的一步）：
#
#   1) 两个 API 令牌（环境变量）—— 用于【建 release 与上传资产】，走 HTTPS API：
#        GITHUB_TOKEN  （或 GH_TOKEN）        需 repo 权限；GitHub 用 Bearer
#        GITCODE_TOKEN （或 GITCODE_ACCESS_TOKEN）  gitcode 的「私人令牌」，作为 access_token 查询参数
#
#   2) git 推送凭据 —— 用于【同步 tag】（就是上面的 `git push`）。**API 令牌不能代替它**，
#      认证方式由 remote 地址的协议决定。**本项目两个源各用一种**：
#
#        GitHub（SSH，走 443）：
#          git remote add origin git@github.com:qialike/qialike.git
#          # 该网络下 22 端口被切断（实测 kex_exchange_identification），在 ~/.ssh/config 里：
#          #   Host github.com
#          #       HostName ssh.github.com
#          #       Port 443
#          #       User git
#
#        gitcode（HTTPS + 访问令牌）：
#          git remote set-url gitcode https://gitcode.com/qialike/qialike.git
#          git config --global credential.helper store   # 首次推送输入：用户名 + 令牌当密码
#          令牌与上面第 1) 类用的是**同一个** PAT（gitcode 已禁用账号密码认证）。
#
#      注意 gitcode 的 SSH 主机是 `gitcode.com`（官方验证命令 `ssh -T git@gitcode.com`），
#      但本项目不用它 —— HTTPS 顺带绕开了 22 端口的问题。
#
#   两类都就绪后，前置检查会分别告诉你哪一类没配好（它把 git 的原文翻译成"该去配什么"）。
#   git 一律以 GIT_TERMINAL_PROMPT=0 运行：缺凭据就快速失败并说明，绝不挂在交互提示上。
#
# 可覆盖的常量：
#   QIALIKE_REPO     仓库路径，默认本脚本同级 qialike/
#   QIALIKE_DIST     产物目录，默认 $QIALIKE_REPO/dist
#   GITHUB_REPO      owner/repo，默认 qialike/qialike
#   GITCODE_REPO     owner/repo，默认 qialike/qialike
#
# 退出码：0 全部完成；1 任何一步失败（已在失败处说明原因）。
set -euo pipefail

# git 只能**非交互**地跑。走 HTTPS 而凭据缺失时，git 默认会去 /dev/tty 提示用户名/密码：
# 在终端里它**停下来等你输入**，在无 tty 的场景则报一句难懂的
# `could not read Username … No such device or address`。两种都不是本脚本要的 —— 它可能
# 在 CI 或管道里跑，且它的失败路径本来就会把原因翻译出来。设成 0 后是确定的快速失败：
# `… terminal prompts disabled`，正好落在 `explain_push_failure` 的第一类里。
# 注意这是给**子进程**继承用的，所以必须 export；SSH 那侧无需这个（它要么用 agent，要么
# 失败，不会提示密码）。
export GIT_TERMINAL_PROMPT=0

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 仓库根 = 本脚本所在目录（<repo>/scripts/release/）上溯两级；与调用时的 cwd 无关。
REPO="${QIALIKE_REPO:-$(cd "$HERE/../.." && pwd)}"
DIST="${QIALIKE_DIST:-$REPO/dist}"
GITHUB_REPO="${GITHUB_REPO:-qialike/qialike}"
GITCODE_REPO="${GITCODE_REPO:-qialike/qialike}"
# 标签同步要推到哪。两者都接受 remote 名或直接给 URL（`git push` 两种都认）。
# 仓库当前可能只有其中一个 remote，甚至一个都没有 —— 缺哪个就会在同步那一步
# 以明确的报错停下，不会静默跳过（静默跳过等于发布一个 tag 不存在或指向错提交的 release）。
GITHUB_REMOTE="${GITHUB_REMOTE:-origin}"
GITCODE_REMOTE="${GITCODE_REMOTE:-gitcode}"
GITHUB_API="https://api.github.com"
GITHUB_UPLOADS="https://uploads.github.com"
GITCODE_API="https://gitcode.com/api/v5"

# 这两个源的 release 资产下载根（与安装器的 `$base/download/$tag/$asset` 同构）。
GITHUB_DL="https://github.com/$GITHUB_REPO/releases/download"
GITCODE_DL="https://gitcode.com/$GITCODE_REPO/releases/download"

bold() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
ok()   { printf '  [ok]   %s\n' "$*"; }
warn() { printf '  [warn] %s\n' "$*" >&2; }
die()  { printf '  [FAIL] %s\n' "$*" >&2; printf '\n推送未完成：%s\n' "$*" >&2; exit 1; }

# ── 参数 ────────────────────────────────────────────────────────────────────
VERSION=''
SOURCE='both'
DRY=0
VERIFY_ONLY=0
ALLOW_MISSING_TAG=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)           DRY=1 ;;
    --verify-only)       VERIFY_ONLY=1 ;;
    --allow-missing-tag) ALLOW_MISSING_TAG=1 ;;
    --source)            SOURCE="${2:-}"; shift ;;
    --source=*)          SOURCE="${1#--source=}" ;;
    # 打印从第 2 行起的**全部**连续注释行，到第一个非注释行为止。写死行号范围
    # （原来的 `sed -n '2,40p'`）会在文档长过那个上限时静默截断帮助。
    -h | --help)         awk 'NR > 1 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"; exit 0 ;;
    -*)                  die "unknown option: $1" ;;
    *)                   VERSION="$1" ;;
  esac
  shift
done
case "$SOURCE" in
  github | gitcode | both) ;;
  *) die "--source 只接受 github | gitcode | both（收到 '$SOURCE'）" ;;
esac

# ── 版本与 tag ──────────────────────────────────────────────────────────────
# **两套命名空间，这是刻意的**（§9.4.10 决策 5 / §9.4.6 发布断言，实测
# `…/download/v0.5.4/…` = 404）：
#   本地 annotated tag 带 `v`（`v0.7.1`）—— `tag-qialike.sh` 造的就是它，`git describe` 也认它；
#   远端 release tag 是**裸版本号**（`0.7.1`）—— 资产 URL 和安装器的 `$base/download/<tag>/` 都拼它。
# 脚本因此必须**做映射**：找本地 `v<版本>`，推到远端 `<版本>`。曾有一版直接拿 `$VERSION` 找本地
# tag，于是永远报"本地没有 tag 0.7.1，先跑 tag-qialike.sh"——而照做只会造出 `v0.7.1`，是个
# 自己喂自己的死循环。
[[ -d "$REPO" ]] || die "找不到仓库：$REPO（用 QIALIKE_REPO 指定）"
if [[ -z "$VERSION" ]]; then
  VERSION="$(node -p "require('$REPO/package.json').version" 2>/dev/null)" \
    || die "读不到 $REPO/package.json 的 version"
fi
VERSION="${VERSION#v}"   # 容错：传 0.7.1 或 v0.7.1 都接受
LOCAL_TAG="v$VERSION"    # 本地：带 v（annotated）
TAG="$VERSION"           # 远端：裸版本号
bold "qialike 发布推送"
echo "  repo     = $REPO"
echo "  dist     = $DIST"
echo "  version  = $VERSION"
echo "  本地 tag = $LOCAL_TAG（带 v，annotated）  →  远端 tag = $TAG（裸版本号）"
echo "  source   = $SOURCE"
[[ "$DRY" == 1 ]] && echo "  模式     = dry-run（不联网、不写入）"
[[ "$VERIFY_ONLY" == 1 ]] && echo "  模式     = verify-only（不上传）"

# ── 1. 清单自校验：上传什么，由清单决定 ──────────────────────────────────────
bold "清单自校验"
MANIFEST="$DIST/sha256sums.txt"
[[ -f "$MANIFEST" ]] || die "没有 $MANIFEST —— 先跑 scripts/release/build-qialike.sh（步骤 7.1 生成它）"
[[ -s "$MANIFEST" ]] || die "$MANIFEST 是空的"

ASSETS=()
while read -r hash name; do
  [[ -z "${hash:-}" || -z "${name:-}" ]] && continue
  [[ "$hash" =~ ^[0-9a-f]{64}$ ]] || die "清单里这行不像 sha256sum 输出：'$hash $name'"
  file="$DIST/$name"
  [[ -f "$file" ]] || die "清单列出的资产不存在：$file"
  actual="$(sha256sum "$file" | cut -d' ' -f1)"
  [[ "$actual" == "$hash" ]] || die "$name 的摘要与清单不符（清单 $hash，实际 $actual）—— 清单与产物不是同一次构建"
  ASSETS+=("$name")
  ok "$name  $(stat -c%s "$file") B"
done < "$MANIFEST"

[[ ${#ASSETS[@]} -gt 0 ]] || die "清单里一行资产都没有"
# 6 是一份完整发布的目标数（build.mjs 的 ALL_TARGETS）。少一个就说明这次构建不完整，
# 上传出去会让那个平台的安装因缺摘要而被拒 —— 在上传之前拦下。
[[ ${#ASSETS[@]} == 6 ]] || die "清单里有 ${#ASSETS[@]} 个资产，期望 6 个 —— 构建不完整"
ok "清单与 6 个产物的摘要逐一相符"

UPLOAD_LIST=("${ASSETS[@]}" sha256sums.txt)
echo "  将上传 $(( ${#ASSETS[@]} + 1 )) 个文件（6 资产 + sha256sums.txt）"

# ── 标签同步：远端 tag 必须与本地一致 ────────────────────────────────────────
# 为什么必须做在"创建 release"之前：两个源的 release API 在 tag 不存在时**不会报错** ——
# 它们会用 target_commitish（默认分支 HEAD）**当场新建一个 tag**，于是发布出一个指向
# 错误提交、却看起来完全正常的 release。
#
# 为什么不无条件删了重推：标签可能被本地移动过（`tag-qialike.sh --move`），这时远端那个
# 指向旧提交、**必须**替换；但两端 SHA 相同时删了再推同样的 ref 毫无收益，只会让标签在
# 一个窗口内不存在 —— 若那一刻有人拉取或有人打开 release 页，就是白担的风险。所以比对
# SHA，只在**不一致**时替换。

# 远端 tag 的 SHA。annotated tag 下 `ls-remote` 首行是 tag 对象的 SHA，与
# `rev-parse refs/tags/X` 同口径（末行 `^{}` 是被指向的提交，不取）。
# `|| true` 是必要的：`set -e` 下命令替换失败会让整脚本在此**无提示退出**，而这里的
# 失败（remote 不存在、网络不通）应当在下面被翻译成人能读懂的报错。
remote_tag_sha() {  # $1 = remote 名或 URL
  git -C "$REPO" ls-remote --tags "$1" "refs/tags/$TAG" 2>/dev/null | awk 'NR==1{print $1}' || true
}

# remote 名要真的存在才往下走；URL 或路径直接用（`git push` 两种都认）。没有这一层，
# 一个拼错的 remote 名会被当成"远端没有这个 tag"，然后 push 时才炸出一句 git 原文。
require_remote() {  # $1 = remote 名、URL 或本地路径，$2 = label
  # 含有 `/`、`:` 或 `@` 的值是"位置"（https://…、git@…、/path/to/repo.git）；
  # remote 名不会含这些字符，所以这个判据把两类分干净。
  case "$1" in
    */* | *:* | *@*) return 0 ;;
  esac
  git -C "$REPO" remote get-url "$1" >/dev/null 2>&1 && return 0
  die "$2 的 remote '$1' 不存在。现有 remote：$(git -C "$REPO" remote | tr '\n' ' ')
     用 GITHUB_REMOTE / GITCODE_REMOTE 指定名字，或直接给 URL/路径。"
}

# 把 git 的原文翻译成"该去配什么"。git 的报错是准确的，但不说下一步做什么，
# 而在发布这一刻最常见的三种原因各有各的修法，猜错方向会浪费很久。
explain_push_failure() {  # $1 = label，$2 = git 的 stderr
  local label=$1 err=$2 hint=''
  case "$err" in
    *'Permission denied (publickey)'* | *'publickey'*)
      hint="SSH 公钥没被该主机接受 —— 确认 ssh-add 里有对应私钥，且公钥已加到 $label 账号。" ;;
    *'could not read Username'* | *'Authentication failed'* | *'terminal prompts disabled'*)
      hint="HTTPS 没有可用凭据 —— 配置 credential helper，或在 remote URL 里带用户名与令牌
     （$label 用访问令牌当密码；该平台已禁用账号密码）。" ;;
    # "库不存在"要排在 403 之前判：gitcode 对**不存在的库**返回的就是 403，原文里同时含
    # "could not be found" 与 "error: 403"（实测）。先匹配 403 会把它说成"没有写权限"，
    # 把人指向完全错误的方向 —— 权限没问题，是地址错了。
    *'not found'* | *'could not be found'* | *'does not appear to be a git repository'*)
      hint="远端地址或库名不对，或当前账号无权访问它 —— 核对 $label 的 owner/repo。" ;;
    *'403'* | *'Permission to'* | *'denied to'* | *'not authorized'*)
      hint="认证过了但**没有写权限** —— 令牌缺写范围（GitHub 需 Contents: write；gitcode 需项目范围），
     或当前账号不是该仓库的协作者。" ;;
    *'Could not resolve host'* | *'Connection timed out'* | *'Connection refused'*)
      hint="网络/DNS 不通 —— 这条与凭据无关。" ;;
    # 22 端口被中间网络切断时的典型形态：TCP 连上了，但对端在密钥交换前就关掉。
    # SSH 侧与凭据无关（换密钥不会好），要么换网络，要么让 github.com 走 443。
    *'kex_exchange_identification'*)
      hint="22 端口被中间网络切断（TCP 通、但密钥交换前就被关）—— 与密钥无关。
     让 GitHub 走 443：在 ~/.ssh/config 里加
         Host github.com
             HostName ssh.github.com
             Port 443
             User git" ;;
    *) hint="（git 原文见上；未能自动归类，请按它自己的提示处理。）" ;;
  esac
  printf '     %s\n' "$hint" >&2
}

# 前置检查：远端可达性与认证。
#
# **能证明什么、不能证明什么（实测结论，别指望更多）**：
#   - 能：remote 拼对了、主机通、仓库存在（私有库还会验证认证）。
#   - **不能**：证明你有写权限。实测 `git push --dry-run` 在一个**只读**远端上照样
#     返回 0 并打印 `[new tag]` —— 它协商完就结束，不真的更新 ref。所以用它当
#     "推送权限检查"是**虚假信心**，本脚本刻意不做这件事。
# 真正证明写权限的只有一次真实推送，而标签同步就是这么一次 —— 且它排在**任何资产上传
# 之前**，所以凭据或权限不对时，一个字节都还没上传。这里只把"压根连不上"提前。
verify_remote_reachable() {  # $1 = remote 名/URL，$2 = label
  local remote=$1 label=$2 err
  # 刻意**不带** `--exit-code`：加了它，一个**空仓库**（尚无任何 ref —— 也就是一个刚建好、
  # 还没推过东西的 GitHub/gitcode 仓库）会因为没有匹配的 ref 而退出 2，被这里误判成
  # "远端不可达"。实测：同一台空仓库，`ls-remote --exit-code HEAD` = 2，`ls-remote` = 0。
  # 这里要问的是"连得上、读得到吗"，所以只看退出码即可（连不上/认证失败都是非零）。
  if ! err="$(git -C "$REPO" ls-remote "$remote" 2>&1)"; then
    printf '  [FAIL] %s 的远端不可达或不可读：%s\n' "$label" "$remote" >&2
    printf '%s\n' "$err" | sed 's/^/     /' >&2
    explain_push_failure "$label" "$err"
    printf '\n推送未完成：%s 的远端前置检查未通过\n' "$label" >&2
    exit 1
  fi
  ok "$label 远端可达（$remote）"
}

sync_tag() {  # $1 = remote 名或 URL，$2 = 标签
  local remote=$1 label=$2 want have err
  require_remote "$remote" "$label"
  # 本地找的是**带 v** 的那个；`want` 是 tag 对象的 SHA，而远端 ref 也是 tag 对象，
  # 所以两者同口径可比（annotated tag 的 `ls-remote` 首行即 tag 对象）。
  want="$(git -C "$REPO" rev-parse "refs/tags/$LOCAL_TAG" 2>/dev/null)" \
    || die "本地没有 tag $LOCAL_TAG —— 先跑 scripts/release/tag-qialike.sh（它造的就是带 v 的本地 tag）"
  have="$(remote_tag_sha "$remote")"

  if [[ -z "$have" ]]; then
    echo "  $label：远端没有 $TAG —— 推送本地 $LOCAL_TAG"
    if ! err="$(git -C "$REPO" push "$remote" "refs/tags/$LOCAL_TAG:refs/tags/$TAG" 2>&1)"; then
      printf '%s\n' "$err" | sed 's/^/     /' >&2
      explain_push_failure "$label" "$err"
      die "$label 推送 tag $TAG 失败"
    fi
    ok "$label：tag $TAG 已推送（$want）"
    return 0
  fi

  if [[ "$have" == "$want" ]]; then
    ok "$label：tag $TAG 已一致（$want）—— 无需改动"
    return 0
  fi

  # 走到这里说明远端指向另一个提交，最常见的原因是本地用 `--move` 挪过标签。
  warn "$label：tag $TAG 在远端指向 $have，本地 $LOCAL_TAG 是 $want —— 删远端后重推"
  if ! err="$(git -C "$REPO" push "$remote" ":refs/tags/$TAG" 2>&1)"; then
    printf '%s\n' "$err" | sed 's/^/     /' >&2
    explain_push_failure "$label" "$err"
    die "$label 删除远端 tag $TAG 失败"
  fi
  if ! err="$(git -C "$REPO" push "$remote" "refs/tags/$LOCAL_TAG:refs/tags/$TAG" 2>&1)"; then
    printf '%s\n' "$err" | sed 's/^/     /' >&2
    explain_push_failure "$label" "$err"
    die "$label 重推 tag $TAG 失败 —— 远端现在没有这个 tag 了，请修好后重跑本脚本"
  fi
  ok "$label：tag $TAG 已重推到 $want"
}

# 取 GitHub API 的 **HTTP 状态码**（`GET` 专用，body 丢弃）—— "这次请求成功了吗"的唯一判据。
#
# 为什么不沿用 gh_api + "body 非空"：gh_api 刻意用 `--fail-with-body` 把 4xx 的响应体也留在
# stdout（好让调用方打印服务端到底说了什么）。于是"body 非空"**不是**成功判据 —— 404 的
# `{"message":"Not Found"}` 与 401 的 `{"message":"Bad credentials"}` 都非空。GitHub 分支曾
# 据此判"release 已存在"：首次发布时 release 还不存在、GET 必然 404，却被读成"已存在"，于是
# 永远不进创建分支、永远拿不到 release id —— 每次重跑都停在同一处（0.7.1 首次发布就撞在这
# 里，见 qialike-development.md §9.4.16）。判据必须是状态码。
#
# `-o /dev/null` 丢掉 body，`-w` 给状态码；连不上时 curl 给 `000`，同样能用 case 归类。
# 位置：必须定义在**下面那道凭据前置检查之前**（bash 按执行顺序解析函数，放到后面的
# "通用小工具"里就会出现 command not found）。`$GH_TOKEN` 由紧随其后的凭据块赋值。
gh_api_status() {  # $1=path → stdout 三位状态码（GET）
  curl -sS -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $GH_TOKEN" \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' \
    "$GITHUB_API$1" || true
}

# ── 凭据（先取值，检查放在下面的标签同步【之前】）────────────────────────────
GH_TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
GC_TOKEN="${GITCODE_TOKEN:-${GITCODE_ACCESS_TOKEN:-}}"

if [[ "$ALLOW_MISSING_TAG" == 1 ]]; then
  warn "--allow-missing-tag：跳过标签同步，交给源的 release API 自建 tag（可能指向错误的提交）"
elif [[ "$DRY" == 0 && "$VERIFY_ONLY" == 0 ]]; then
  # 凭据先查，**在碰任何远端之前**。token 只用于后面的 API 上传，标签同步（git 推送）不需要
  # 它 —— 但如果把它放到标签同步之后，缺令牌的一次运行会**先把标签推到远端**、再在"该上传了"
  # 处停下，留下"tag 已推、release 没建"的半截状态。这跟下面那条"先检查全部 remote 再动手"
  # 是同一个原则：任何远端写入之前，先把所有能提前发现的问题发现完。
  [[ "$SOURCE" == gitcode || -n "$GH_TOKEN" ]] || die "缺少 GITHUB_TOKEN（或 GH_TOKEN）"
  [[ "$SOURCE" == github || -n "$GC_TOKEN" ]] || die "缺少 GITCODE_TOKEN（或 GITCODE_ACCESS_TOKEN）"
  ok "两个 API 令牌已就位"

  # 令牌"存在"不等于令牌"有效"，而这里正是上面那条原则的落点：任何远端写入之前，先把能提前
  # 发现的问题发现完。少这一步的代价在 0.7.1 上已经付过：一个非 GitHub 格式的令牌通过了上面
  # 那条非空检查，于是**标签先被推上远端**，随后才在"该上传了"处 401 停下 —— 留下"tag 已推、
  # release 没建"的半截状态，而修复它还得再跑一次。
  if [[ "$SOURCE" == github || "$SOURCE" == both ]]; then
    gh_self_status="$(gh_api_status /user)"
    case "$gh_self_status" in
      200) ok "GitHub 令牌有效（GET /user）" ;;
      401) die "GitHub 令牌无效（401 Bad credentials）—— 换一个 GITHUB_TOKEN 后重跑" ;;
      000) die "GitHub API 不可达（GET /user）—— 检查网络后重跑" ;;
      *)   die "GitHub 令牌自检失败（HTTP $gh_self_status）—— 检查令牌后重跑" ;;
    esac
    # 令牌有效也可能看不到这个库：**私有库对"无权访问"的令牌返回 404 而不是 403**（避免泄露
    # 仓库是否存在）。现在就问清楚，好过把 404 当成"release 还不存在"再去创建。
    gh_repo_status="$(gh_api_status "/repos/$GITHUB_REPO")"
    case "$gh_repo_status" in
      200) ok "GitHub 令牌可访问 $GITHUB_REPO" ;;
      404) die "GitHub 令牌看不到 $GITHUB_REPO（私有库对无权令牌返回 404）—— 确认令牌已授权到该仓库" ;;
      403) die "GitHub 令牌被拒绝访问 $GITHUB_REPO（403）" ;;
      *)   die "查询 $GITHUB_REPO 失败（HTTP $gh_repo_status）" ;;
    esac
  fi

  # 再把**所有**目标 remote 检查一遍，最后才动手推。反过来做（查到哪个推哪个）会在第二个
  # remote 连不上时留下半截状态：一边的 tag 已更新、另一边没有，而 release 还没建。
  SYNC_LABELS=(); SYNC_REMOTES=()
  if [[ "$SOURCE" == github || "$SOURCE" == both ]]; then
    SYNC_LABELS+=("GitHub"); SYNC_REMOTES+=("$GITHUB_REMOTE")
  fi
  if [[ "$SOURCE" == gitcode || "$SOURCE" == both ]]; then
    SYNC_LABELS+=("gitcode"); SYNC_REMOTES+=("$GITCODE_REMOTE")
  fi
  for i in "${!SYNC_REMOTES[@]}"; do
    require_remote "${SYNC_REMOTES[$i]}" "${SYNC_LABELS[$i]}"
    verify_remote_reachable "${SYNC_REMOTES[$i]}" "${SYNC_LABELS[$i]}"
  done
  for i in "${!SYNC_REMOTES[@]}"; do
    sync_tag "${SYNC_REMOTES[$i]}" "${SYNC_LABELS[$i]}"
  done
  echo "  提示：标签若被替换过，远端 release 上旧的资产仍对应旧提交 —— 下面的上传会覆盖同名资产。"
fi

if [[ "$DRY" == 1 ]]; then
  bold "dry-run 结束（没有联网、没有写入）"
  printf '  上传清单：\n'
  for f in "${UPLOAD_LIST[@]}"; do printf '    %s\n' "$f"; done
  exit 0
fi

# ── 通用小工具 ──────────────────────────────────────────────────────────────
# 需要网络。`curl --fail-with-body` 让 4xx/5xx 既非零退出、又把响应体留在 stdout，
# 于是调用方能打印服务端到底说了什么，而不是只看到 exit 22。
gh_api() {  # $1=method $2=path [curl args...]
  local method=$1 path=$2; shift 2
  curl -sS --fail-with-body -X "$method" \
    -H "Authorization: Bearer $GH_TOKEN" \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' "$@" "$GITHUB_API$path"
}

# 上传一个文件到 GitHub release；已存在同名资产则先删掉（让脚本可重复执行）。
gh_upload() {  # $1=release_id $2=file $3=name
  local id=$1 file=$2 name=$3 existing
  existing="$(gh_api GET "/repos/$GITHUB_REPO/releases/$id/assets?per_page=100" \
    | jq -r --arg n "$name" '.[] | select(.name == $n) | .id' | head -1)"
  if [[ -n "$existing" ]]; then
    gh_api DELETE "/repos/$GITHUB_REPO/releases/assets/$existing" >/dev/null
    warn "GitHub 上已存在 $name —— 已删除旧资产，重传"
  fi
  curl -sS --fail-with-body -X POST \
    -H "Authorization: Bearer $GH_TOKEN" \
    -H 'Accept: application/vnd.github+json' \
    -H 'Content-Type: application/octet-stream' \
    --data-binary "@$file" \
    "$GITHUB_UPLOADS/repos/$GITHUB_REPO/releases/$id/assets?name=$name" >/dev/null
}

# gitcode 的上传是三步：创建 release → 取 OBS 预签名地址 → PUT 到该地址。
gc_api() {  # $1=method $2=path [curl args...]
  local method=$1 path=$2; shift 2
  local sep='?'
  [[ "$path" == *\?* ]] && sep='&'
  curl -sS --fail-with-body -X "$method" \
    -H 'Accept: application/json' \
    "$@" "$GITCODE_API$path${sep}access_token=$GC_TOKEN"
}

gc_ensure_release() {
  local body
  if gc_api GET "/repos/$GITCODE_REPO/releases/tags/$TAG" >/dev/null 2>&1; then
    ok "gitcode release $TAG 已存在"
    return 0
  fi
  # release_status: pre = 预发布。带 `-` 的版本号（0.7.1-beta）按预发布，否则 latest。
  local status='latest'
  [[ "$TAG" == *-* ]] && status='pre'
  body="$(jq -nc --arg t "$TAG" --arg n "$TAG" --arg b "qialike $TAG" --arg s "$status" \
    '{tag_name:$t, name:$n, body:$b, release_status:$s}')"
  gc_api POST "/repos/$GITCODE_REPO/releases" -H 'Content-Type: application/json' -d "$body" >/dev/null \
    || die "gitcode 创建 release $TAG 失败（tag 是否已推送？release 需要 tag 存在）"
  ok "gitcode release $TAG 已创建（release_status=$status）"
}

gc_upload() {  # $1=file $2=name
  local file=$1 name=$2 info url
  info="$(gc_api GET "/repos/$GITCODE_REPO/releases/$TAG/upload_url?file_name=$name")" \
    || die "取 gitcode 上传地址失败：$name"
  url="$(jq -r '.url // empty' <<<"$info")"
  [[ -n "$url" ]] || die "gitcode 没给 $name 的上传地址：$info"
  # 服务端给的 headers 必须原样带上（OBS 预签名的 meta/acl/callback 都在里面）。
  local -a hdrs=()
  while IFS=$'\t' read -r k v; do
    [[ -n "$k" ]] && hdrs+=(-H "$k: $v")
  done < <(jq -r '.headers | to_entries[] | [.key, .value] | @tsv' <<<"$info")
  curl -sS --fail-with-body -X PUT "${hdrs[@]}" --data-binary "@$file" "$url" >/dev/null \
    || die "上传到 gitcode 失败：$name"
}

# 读回清单并与本地逐字节比对 —— 这是"真的传上去了"唯一的硬证据。
verify_manifest() {  # $1=下载根 $2=源名
  local base=$1 label=$2 got attempt
  for attempt in 1 2 3 4 5; do
    if got="$(curl -fsSL "$base/$TAG/sha256sums.txt" 2>/dev/null)"; then
      if [[ "$got" == "$(cat "$MANIFEST")" ]]; then
        ok "$label 的 sha256sums.txt 与本地逐字节一致"
        return 0
      fi
      die "$label 上的 sha256sums.txt 与本地不一致（上传的是别的构建？）"
    fi
    # 刚发布的 release 在 CDN 上可能要几秒才可见。
    sleep 3
  done
  die "$label 上取不到 $TAG/sha256sums.txt（试了 5 次）—— 清单没传上去，安装器会拒绝安装"
}

# ── 2. GitHub ───────────────────────────────────────────────────────────────
if [[ "$SOURCE" == github || "$SOURCE" == both ]]; then
  bold "GitHub（$GITHUB_REPO）"
  if [[ "$VERIFY_ONLY" == 1 ]]; then
    verify_manifest "$GITHUB_DL" "GitHub"
  else
    # 判据是**状态码**（见 gh_api_status）：200 = 已有，取 id 继续；**404 = 还没有，这才是
    # 创建路径**（上面的前置检查已证明令牌能看到这个库，所以这里的 404 只能是"没有这个
    # release"）；401/403 = 令牌问题；其余原样报出。
    gh_release_status="$(gh_api_status "/repos/$GITHUB_REPO/releases/tags/$TAG")"
    case "$gh_release_status" in
      200)
        # 状态码只回答"有没有"。既然有，就再取一次正文拿 release id —— `gh_api` 会把服务端
        # 的解释原样打印，所以这里非零即真失败。
        REL="$(gh_api GET "/repos/$GITHUB_REPO/releases/tags/$TAG")" \
          || die "取 GitHub release $TAG 详情失败（状态码 200，但正文取不到）"
        ok "release $TAG 已存在"
        ;;
      404)
        PRE='false'
        [[ "$TAG" == *-* ]] && PRE='true'
        REL="$(gh_api POST "/repos/$GITHUB_REPO/releases" \
          -H 'Content-Type: application/json' \
          -d "$(jq -nc --arg t "$TAG" --arg n "$TAG" --arg b "qialike $TAG" --argjson pre "$PRE" \
                '{tag_name:$t, name:$n, body:$b, draft:false, prerelease:$pre}')")" \
          || die "GitHub 创建 release $TAG 失败（tag 是否已推送？）"
        ok "release $TAG 已创建"
        ;;
      401) die "GitHub 令牌无效（401 Bad credentials）—— 换一个 GITHUB_TOKEN 后重跑" ;;
      403) die "GitHub 令牌无权写 $GITHUB_REPO（403）—— 需要 Contents: Read and write" ;;
      *)   die "查询 GitHub release $TAG 失败（HTTP $gh_release_status）" ;;
    esac
    ID="$(jq -r '.id // empty' <<<"$REL")"
    [[ -n "$ID" ]] || die "拿不到 release id：$REL"
    for f in "${UPLOAD_LIST[@]}"; do
      gh_upload "$ID" "$DIST/$f" "$f"
      ok "上传 $f"
    done
    verify_manifest "$GITHUB_DL" "GitHub"
  fi
fi

# ── 3. gitcode ──────────────────────────────────────────────────────────────
if [[ "$SOURCE" == gitcode || "$SOURCE" == both ]]; then
  bold "gitcode（$GITCODE_REPO）"
  if [[ "$VERIFY_ONLY" == 1 ]]; then
    verify_manifest "$GITCODE_DL" "gitcode"
  else
    gc_ensure_release
    for f in "${UPLOAD_LIST[@]}"; do
      gc_upload "$DIST/$f" "$f"
      ok "上传 $f"
    done
    verify_manifest "$GITCODE_DL" "gitcode"
  fi
fi

bold "推送完成"
cat <<EOF
  版本 $TAG 的 ${#UPLOAD_LIST[@]} 个文件已推到：$SOURCE
  两个源的 sha256sums.txt 都已与本地逐字节核对。

  下一步（人工，脚本盖不到的）：
    1. 用真实 one-liner 装一次并确认走的是本次发布：
         curl -fsSL https://qialike.com/install | bash
    2. 若本次改了 scripts/install，把它同步到站点（§9.4.11 第 3 步）：
         cp $REPO/scripts/install <site-code>/qialike-site/deploy/install
       否则线上仍是旧脚本。
EOF
