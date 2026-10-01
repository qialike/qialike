#!/usr/bin/env bash
# =============================================================================
# changelog-section.sh — 抽出版本在 CHANGELOG 里的那一节，供发布正文与标签附注使用
#
# 为什么需要它：GitHub / GitCode 上「点标签看到的东西」是 Release 的 `body`，而标签
# 自身的附注（annotated tag 的 message）是 `git show <tag>` 看到的东西。这两处过去都被
# 写死成一行 `qialike <版本>`，所以远端**从来没有任何修改点**（实测：0.9.0 的 body 是
# 13 个字符）。本脚本把 `CHANGELOG.md` / `CHANGELOG.zh.md` 里该版本的那一节抽出来，
# 让「发布时写进去的东西」与「仓库里的更新日志」同源 —— 不手抄，也就不会漂。
#
# 输出格式（两个文件都命中时，英文在上、中文在下，中间一条分隔线）：
#
#     ### Changed
#
#     - **…**
#
#     ---
#
#     ### 变更
#
#     - **…**
#
# 为什么这么拼：两节的 `###` 标题自带语言标签（`### Changed` / `### 变更`），所以读者
# 一眼能分辨，不需要额外加「English」/「中文」小标题。只用其中一个文件时没有分隔线。
#
# 用法：
#   ./changelog-section.sh 0.9.0                  # 默认：CHANGELOG.md 在上、zh 在下
#   ./changelog-section.sh 0.9.0 --lang en        # 只要英文
#   ./changelog-section.sh 0.9.0 --lang zh        # 只要中文
#   ./changelog-section.sh 0.9.0 --repo /path     # 指定仓库根（默认从本脚本位置上溯两级）
#
# 退出码：0 = 至少抽到一节（stdout 是内容）；1 = 该版本在两个文件里都没有（stdout 空）。
#   调用方应当把 1 当作「退回旧的一行式文案」，**不要**因此中断打标签/发布。
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

VERSION=''
LANG_SEL='both'
while [[ $# -gt 0 ]]; do
  case "$1" in
    --lang) LANG_SEL="${2:-both}"; shift ;;
    --repo) REPO="${2:-}"; shift ;;
    -h | --help) sed -n '2,/^set -euo pipefail$/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) printf 'changelog-section: 未知参数 %s\n' "$1" >&2; exit 2 ;;
    *) VERSION="$1" ;;
  esac
  shift
done
[[ -n "$VERSION" ]] || { printf '用法：changelog-section.sh <版本> [--lang en|zh|both] [--repo <仓库根>]\n' >&2; exit 2; }
case "$LANG_SEL" in en | zh | both) ;; *) printf 'changelog-section: --lang 只能是 en|zh|both\n' >&2; exit 2 ;; esac

# 抽一节：从 `## [<版本>]` 的**下一行**起，到下一个 `## [` 之前。
# 匹配用带方括号的完整形式，所以 `## [0.9.0]` 不会误命中 `## [0.9.0-beta]`。
# 先剥前导空行、再剥尾部空行（尾部用一次遍历记住最后一行非空的位置 —— `tac` 在 macOS 上
# 不可移植，而发布脚本要在三个平台上跑）。
section_of() { # $1 = 文件
  local file="$1" raw
  [[ -f "$file" ]] || return 0
  raw="$(awk -v want="## [$VERSION]" '
    index($0, want) == 1 && length($0) > length(want) && substr($0, length(want) + 1, 1) ~ /[^0-9A-Za-z.-]/ { inside = 1; next }
    inside && /^## \[/ { exit }
    inside { print }
  ' "$file")"
  [[ -n "$raw" ]] || return 0
  printf '%s\n' "$raw" \
    | awk 'NF { seen = 1 } seen' \
    | awk '{ l[NR] = $0 } END { last = 0; for (i = 1; i <= NR; i++) if (l[i] ~ /[^ \t]/) last = i; for (i = 1; i <= last; i++) print l[i] }'
}

en='' zh=''
case "$LANG_SEL" in
  en | both) en="$(section_of "$REPO/CHANGELOG.md")" ;;
esac
case "$LANG_SEL" in
  zh | both) zh="$(section_of "$REPO/CHANGELOG.zh.md")" ;;
esac

# 拼装：只要其中一个时原样输出；两个都有时中间加分隔线。
if [[ -n "$en" && -n "$zh" ]]; then
  printf '%s\n\n---\n\n%s\n' "$en" "$zh"
elif [[ -n "$en" ]]; then
  printf '%s\n' "$en"
elif [[ -n "$zh" ]]; then
  printf '%s\n' "$zh"
else
  printf 'changelog-section: CHANGELOG 里没有 %s 这一节\n' "$VERSION" >&2
  exit 1
fi
