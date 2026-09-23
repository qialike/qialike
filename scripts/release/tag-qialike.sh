#!/usr/bin/env bash
# =============================================================================
# tag-qialike.sh — 给 qialike 打标签 / 升级已有标签（仓库内 scripts/release/）
#
# 本脚本由 build-qialike.sh 的「步骤 8：tag 同步」剥离而来；build-qialike.sh
# 现在只管「版本号 + 编译 + 可选归档」，不再碰 git。
#
# 功能：
#   1) 打新标签：`v<版本>` 尚不存在时，在 HEAD（或提交改动后）打 annotated tag。
#   2) 已有标签升级：`v<版本>` 已存在但指向别处时，删旧标签、在新提交重打
#      —— §7.1.2(2)「本地修正（未推送）」的脚本化。
#
# 版本号来源：仓库根 package.json 的 version。本脚本**不改** package.json；
#   升版请先用 `./build-qialike.sh <版本>`（它同步 3 处 package.json 并编译校验）。
#
# 用法：
#   ./tag-qialike.sh              # 自动判定（见下）
#   ./tag-qialike.sh --new        # 强制「打新标签」；标签已存在 → 报错退出
#   ./tag-qialike.sh --move       # 强制「已有标签升级」；标签不存在 → 报错退出
#   ./tag-qialike.sh -n           # 预演：只打印将执行的 git 动作，不做任何改动、不提问
#   ./tag-qialike.sh -y           # 免确认（无 TTY / 自动化）
#   ./tag-qialike.sh --new -y -n  # 开关可组合
#
# 自动判定：
#   标签不存在                        → 打新标签
#   标签 == HEAD 且工作树干净          → 已一致，无需操作（退出 0）
#   其它（标签指向别处 / 工作树有改动）→ 升级已有标签
#
# 有未提交改动时的提交方式（按 HEAD 里的版本号与当前版本号比较）：
#   不同（= 本次升版）        → `git add -A` + 新增提交 `chore(release): qialike <版本>`
#   相同（= 版本未变的修正）  → `git add -A` + `git commit --amend --no-edit` 并入 HEAD
#
# 判据与提示：dirty 用 `git status --porcelain`（含**未跟踪**文件、忽略 .gitignore
#   命中的），与 `git add -A` 口径一致；交互提示 `printf ... >&2` 后 `read`，因此
#   stdin 为管道/非终端时提示也可见；无可交互输入等同于拒绝。
#
# 退出码：0 = 标签已就位且一致性检查通过（或 --dry-run 完成）；1 = 参数/状态错误、被拒绝、未达成、检查未通过。
# =============================================================================
set -euo pipefail

# 仓库根 = 本脚本所在目录（<repo>/scripts/release/）上溯两级；与调用时的 cwd 无关。
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

MODE=auto
YES=0
DRY=0
VERIFY=1

usage() {
  cat >&2 <<'USAGE'
usage: tag-qialike.sh [--new|--move] [-y|--yes] [-n|--dry-run] [--no-verify] [-h|--help]

  (无参数)      自动判定：无标签→打新；已一致→提示无需操作；否则→升级已有标签
  --new         强制打新标签（标签已存在则报错）
  --move        强制升级已有标签（标签不存在则报错）
  -y, --yes     免确认（无 TTY / 自动化）
  -n, --dry-run 预演：只打印将执行的 git 动作，不改动任何东西、不提问
  --no-verify   跳过结束前的一致性检查（只打印 git 两项，不做断言）
  -h, --help    显示本用法

版本号取自仓库根 package.json；本脚本不改 package.json（升版用 ./build-qialike.sh <版本>）。
结束时校验：① `git tag -n1 <tag>`（首列 = tag、附注含 "qialike <版本>"）；② `git describe --tags`
（应输出 <tag> 本身）；③ tag 树三处 package.json（root / packages/qialike-app / apps/tui-bin）
版本都等于 <版本>。不符则逐项 [FAIL] 并退出 1。
二进制 `--version` = qialike <版本> 由 build-qialike.sh 在编译后校验（本脚本不重复做）。
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --new) MODE=new ;;
    --move) MODE=move ;;
    -y | --yes) YES=1 ;;
    -n | --dry-run) DRY=1 ;;
    --no-verify) VERIFY=0 ;;
    -h | --help) usage; exit 0 ;;
    *) usage; echo "qialike: unknown argument '$1'" >&2; exit 1 ;;
  esac
  shift
done

say() { echo "qialike: $*"; }
die() { echo "qialike: $*" >&2; exit 1; }
g() { (cd "$REPO" && git "$@"); }

# confirm <提示>：DRY 下不问、直接放行并说明；--yes 下自动 y；否则读一行，非 y/yes 即拒绝
confirm() {
  if [[ "$DRY" == 1 ]]; then say "[dry-run] would ask: $1 [y/N]"; return 0; fi
  if [[ "$YES" == 1 ]]; then printf 'qialike: %s [y/N] y (--yes)\n' "$1" >&2; return 0; fi
  printf 'qialike: %s [y/N] ' "$1" >&2
  local answer=""
  read -r answer || answer=""
  case "${answer,,}" in y | yes) return 0 ;; *) return 1 ;; esac
}

# mutate <git 参数...>：DRY 下只打印；否则真跑（会改动仓库的动作都走这里）
mutate() {
  if [[ "$DRY" == 1 ]]; then printf '  [dry-run] git %s\n' "$*"; return 0; fi
  g "$@"
}

# verify_tag <tag>：§7.1.2 三查一致里的 **git 两项**（第三项二进制 `--version` 由
#   build-qialike.sh 在编译后校验，本脚本不重复做），外加 **tag 树三处 package.json 版本互查**。
#   ① `git tag -n1 <tag>`：首列必须是 <tag>，且附注（annotated tag）里含 "qialike <版本>"
#   ② `git describe --tags`：输出应就是 <tag> 本身（= tag 就在 HEAD 上）
#   ③ tag 树（`git show <tag>:<path>`）三处 package.json 的 version 都等于 <版本>
#   任一项不符 → 逐项 [ok]/[FAIL] 打印后返回 1。
verify_tag() {
  local tag="$1" line name annot desc sha_tag sha_head failed=0
  line="$(g tag -n1 "$tag")"
  name="$(printf '%s\n' "$line" | awk 'NR==1{print $1}')"
  annot="$(printf '%s\n' "$line" | sed -n '1s/^[^[:space:]]*[[:space:]]*//p')"
  if [[ "$name" == "$tag" ]]; then
    printf '  [ok]   git tag -n1 %s → %s\n' "$tag" "$line"
  else
    printf '  [FAIL] git tag -n1 %s → 首列 "%s"（期望 %s）\n' "$tag" "$name" "$tag"
    failed=1
  fi
  if [[ "$annot" == *"qialike $VERSION"* ]]; then
    printf '  [ok]   tag 附注含 "qialike %s"\n' "$VERSION"
  else
    printf '  [FAIL] tag 附注 "%s" 不含 "qialike %s"\n' "$annot" "$VERSION"
    failed=1
  fi
  desc="$(g describe --tags)"
  sha_tag="$(g rev-parse --short "refs/tags/$tag^{commit}")"
  sha_head="$(g rev-parse --short HEAD)"
  if [[ "$desc" == "$tag" ]]; then
    printf '  [ok]   git describe --tags → %s\n' "$desc"
  else
    printf '  [FAIL] git describe --tags → %s（期望 %s；tag=%s HEAD=%s）\n' "$desc" "$tag" "$sha_tag" "$sha_head"
    if [[ "$sha_tag" != "$sha_head" ]]; then
      printf '         原因：tag 不在 HEAD 上 —— `git rev-list --count %s..HEAD` = %s\n' \
        "$tag" "$(g rev-list --count "refs/tags/$tag..HEAD")"
    else
      printf '         原因：tag 在 HEAD 上，但同一提交上还有别的标签，git describe 选中了它（本仓库约定一提交一标签）\n'
    fi
    failed=1
  fi
  # ③ tag 树里的三处 package.json 必须都等于 $VERSION（§7.1.2 约定：tag 内提交树三处一致）。
  #    与 build-qialike.sh 的工作树三处互查互补——这里查的是**标签指向的那棵树**。
  local rel vv bad_tree=0
  for rel in package.json packages/qialike-app/package.json apps/tui-bin/package.json; do
    vv="$(g show "$tag:$rel" 2>/dev/null | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).version" 2>/dev/null || true)"
    if [[ "$vv" != "$VERSION" ]]; then
      printf '  [FAIL] tag 树 %s version = %s（期望 %s）\n' "$rel" "${vv:-<读不到>}" "$VERSION"
      bad_tree=1
    fi
  done
  if [[ "$bad_tree" == 0 ]]; then
    printf '  [ok]   tag 树三处 package.json 版本一致（%s）\n' "$VERSION"
  else
    failed=1
  fi
  return "$failed"
}

# ---- 步骤 1：前置检查与版本号 ----
[[ -d "$REPO/.git" ]] || die "not a git repo: $REPO"
command -v node >/dev/null 2>&1 || die "node not found"
VERSION="$(node -p "require('$REPO/package.json').version" 2>/dev/null || true)"
[[ -n "$VERSION" ]] || die "cannot read version from $REPO/package.json"
TAG="v$VERSION"

# ---- 步骤 2：读取仓库与标签状态 ----
head_commit="$(g rev-parse HEAD)"
tag_commit="$(g rev-parse -q --verify "refs/tags/$TAG^{commit}" || true)"
if [[ -z "$(g status --porcelain)" ]]; then dirty=0; else dirty=1; fi
head_version="$(g show HEAD:package.json 2>/dev/null | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).version" 2>/dev/null || true)"

say "repo=$REPO version=$VERSION tag=$TAG"
say "HEAD=$(g rev-parse --short HEAD) tag=$( [[ -n "$tag_commit" ]] && g rev-parse --short "$tag_commit" || echo '(none)' ) dirty=$dirty"

# ---- 步骤 3：模式判定 ----
if [[ "$MODE" == auto ]]; then
  if [[ -z "$tag_commit" ]]; then
    MODE=new
  elif [[ "$tag_commit" == "$head_commit" && "$dirty" == 0 ]]; then
    say "tag $TAG already matches the repo (no action needed)"
    if [[ "$VERIFY" == 1 ]]; then
      verify_tag "$TAG" || { say "verification FAILED（标签已就位，但 git 两项一致性检查未通过）"; exit 1; }
      say "verification OK (git 两项；二进制 --version 由 build-qialike.sh 校验)"
    else
      say "verification skipped (--no-verify)"
      g tag -n1 "$TAG"
      g describe --tags
    fi
    exit 0
  else
    MODE=move
  fi
fi
case "$MODE" in
  new)
    [[ -z "$tag_commit" ]] || die "tag $TAG already exists (use --move to upgrade it)"
    say "mode: create new tag $TAG"
    ;;
  move)
    [[ -n "$tag_commit" ]] || die "tag $TAG does not exist (use --new to create it)"
    say "mode: upgrade existing tag $TAG"
    ;;
esac

# ---- 步骤 4：有未提交改动时提交（新增提交 or amend） ----
will_commit=0
if [[ "$dirty" == 0 ]]; then
  say "working tree is clean (no commit needed)"
else
  say "uncommitted changes vs HEAD:"
  g status --short | sed 's/^/  /'
  if [[ "$head_version" == "$VERSION" ]]; then
    commit_kind=amend
    say "HEAD 里的版本号也是 $VERSION → 并入 HEAD：git add -A && git commit --amend --no-edit"
  else
    commit_kind=new
    say "HEAD 里的版本号是 ${head_version:-?} → 新增提交：chore(release): qialike $VERSION"
  fi
  confirm "commit these changes ($commit_kind)?" || die "aborted (no changes made)"
  will_commit=1
  mutate add -A
  if [[ "$commit_kind" == new ]]; then
    if [[ "$DRY" == 1 ]]; then
      printf '  [dry-run] git commit -m "chore(release): qialike %s"\n' "$VERSION"
    else
      g commit -m "chore(release): qialike $VERSION"
    fi
  else
    mutate commit --amend --no-edit
  fi
fi

# ---- 步骤 5：创建/重建标签 ----
#   DRY 下 HEAD 不会真变，但"将要有提交"同样意味着标签要挪，所以用 will_commit 参与判断。
new_head="$(g rev-parse HEAD)"
if [[ -n "$tag_commit" && "$tag_commit" == "$new_head" && "$will_commit" == 0 ]]; then
  say "tag $TAG already points at HEAD (nothing to upgrade)"
else
  if [[ -n "$tag_commit" ]]; then
    confirm "delete tag $TAG (currently $(g rev-parse --short "$tag_commit")) and re-create at $(g rev-parse --short "$new_head")?" \
      || die "aborted (tag $TAG unchanged)"
    mutate tag -d "$TAG"
  fi
  mutate tag -a "$TAG" -m "qialike $VERSION"
fi

if [[ "$DRY" == 1 ]]; then
  say "dry-run: nothing was changed (would verify: git tag -n1 $TAG / git describe --tags)"
  exit 0
fi

# ---- 步骤 6：验证——§7.1.2 三查一致里的 git 两项（见 verify_tag；第三项二进制
#   `--version` 由 build-qialike.sh 在编译后校验）。不符即退出 1（标签已就位，需人工处理）。
say "tag $TAG -> $(g rev-parse --short "refs/tags/$TAG^{commit}")"
if [[ "$VERIFY" == 1 ]]; then
  verify_tag "$TAG" || {
    say "verification FAILED（标签已就位，但 git 两项一致性检查未通过）"
    exit 1
  }
  say "verification OK (git 两项；二进制 --version 由 build-qialike.sh 校验)"
else
  say "verification skipped (--no-verify)"
  g tag -n1 "$TAG"
  g describe --tags
fi
