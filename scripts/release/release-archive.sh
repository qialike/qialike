#!/usr/bin/env bash
# =============================================================================
# release-archive.sh — 用 git archive 打包 qialike 源码为 .tar.gz 与 .zip
#
# 功能：
#   基于仓库 package.json 自动读取版本，把 qialike 仓库在 tag `v<版本>` 下的
#   【已跟踪文件】打包成：
#   - qialike-<version>.tar.gz
#   - qialike-<version>.zip
#   仅含已提交（tracked）文件，自动遵守 .gitignore：不含 node_modules/、dist/、
#   packages/*/lib/、apps/tui-bin/generated|x|.resolve|stub-native/、*.tsbuildinfo、
#   .env、install.log/build.log、根目录模型测试产物（*.md）等构建产物/本机文件。
#   另遵守仓库 .gitattributes 的 export-ignore：入库但不出包的开发用复现脚本
#   （packages/qialike-app/repro-*.mjs、verify-fixes.mjs）不进归档。归档用
#   `--worktree-attributes`，所以旧 tag（其树内还没有 .gitattributes）同样生效。
#   打包后自动验证：列条目、抽查关键文件、确认无被禁/被 export-ignore 条目、
#   解包并核对两种格式的文件数一致且互相逐字节相同。
#
# 注意：脚本只写本版本的产物，**不会删除** $OUT_DIR 下其它版本的归档（会在
#   步骤 7 列出它们，便于人工清理）。
#
# 用法：
#   ./release-archive.sh                             # 全部默认
#   ./release-archive.sh /path/to/qialike            # 只指定仓库
#   ./release-archive.sh /path/to/qialike /tmp/out   # 指定仓库与输出目录
#   ./release-archive.sh '' /tmp/out                 # 仓库用默认，只改输出目录
#
# 参数（位置参数，均带默认值；相对路径也可，脚本会先转成绝对路径）：
#   1. REPO     qialike git 仓库路径  默认 本脚本所在目录上溯两级（即仓库根）
#   2. OUT_DIR  产物输出目录          默认 仓库同级的 releases-qialike/（仓库外，不入库）
#
# 版本与 tag：VERSION 自动读取 $REPO/package.json 的 version；TAG = v$VERSION。
#   若 tag v$VERSION 尚不存在则报错退出（请先为对应提交打 tag）。
#
# 单独归档：本脚本可独立执行（不需要 build-qialike.sh 先编译——归档内容是 tag 树的源码，
#   与是否编译无关）；`BUILD_ARCHIVE=1 ./build-qialike.sh` 只是"编译 + 调用本脚本"的合体写法。
#   同名产物已存在时会打印 `note: overwriting existing …` 后直接覆盖。
#
# 产物：
#   $OUT_DIR/qialike-$VERSION.tar.gz
#   $OUT_DIR/qialike-$VERSION.zip
#   解包后顶层目录为 qialike-$VERSION/
#
# 依赖：git（含 archive）、node、tar、unzip
# =============================================================================
set -euo pipefail

# ---- 步骤 1：解析路径——默认跟随本机（相对本脚本所在目录，非硬编码绝对路径） ----
#   本脚本位于 <repo>/scripts/release/，所以仓库根 = 上溯两级；归档默认写到仓库**外**
#   的同级目录 releases-qialike/，避免把产物提交进仓库。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${1:-$(cd "$SCRIPT_DIR/../.." && pwd)}"  # qialike git 仓库（仓库根）
OUT_DIR="${2:-$REPO/../releases-qialike}"      # 产物目录（仓库外，不会入库）

# ---- 步骤 1b：位置参数统一转成绝对路径 ----
#   下面会 `cd "$REPO"`；若入参是相对路径（如 `./scripts/release/release-archive.sh . out`），
#   之后再拿 $REPO/$OUT_DIR 去 require / 写产物就会解析错位（require('package.json')
#   从仓库内部找 → 报 "cannot determine version"）。先固化绝对路径，相对路径也能用。
REPO="$(cd "$REPO" 2>/dev/null && pwd)" || { echo "not found: $REPO" >&2; exit 1; }
mkdir -p "$OUT_DIR" || { echo "cannot create output dir: $OUT_DIR" >&2; exit 1; }
OUT_DIR="$(cd "$OUT_DIR" && pwd)"

# ---- 步骤 2：前置校验——必须是 git 仓库 ----
cd "$REPO" || { echo "not found: $REPO" >&2; exit 1; }
[ -d .git ] || { echo "not a git repo: $REPO" >&2; exit 1; }

# ---- 步骤 3：自动读取版本号与 tag ----
VERSION="$(node -p "require('$REPO/package.json').version" 2>/dev/null || true)"
[ -n "$VERSION" ] || { echo "cannot determine version from $REPO/package.json" >&2; exit 1; }
TAG="v$VERSION"
echo "release: repo=$REPO version=$VERSION tag=$TAG out=$OUT_DIR"

# ---- 步骤 4：tag 必须存在（保持「先打 tag 再归档」的顺序） ----
git rev-parse --verify "$TAG^{commit}" >/dev/null 2>&1 || {
  echo "tag not found: $TAG (please tag the release first)" >&2; exit 1
}

# ---- 步骤 5：准备产物目录与完整输出路径 ----
TARBALL="$OUT_DIR/qialike-$VERSION.tar.gz"
ZIPBALL="$OUT_DIR/qialike-$VERSION.zip"
# 覆盖提示：同名产物已存在时明说一句（脚本会直接覆盖），避免误以为在"追加/新增"。
for f in "$TARBALL" "$ZIPBALL"; do
  [ -e "$f" ] && echo "note: overwriting existing $f"
done

# ---- 步骤 5b：算出被 export-ignore 的 tag 树文件（.gitattributes） ----
# 这些是「入库但不出包」的开发用复现脚本（repro-*.mjs / verify-fixes.mjs）：
# 保留在仓库里以便复现真 bug，但不进发布包。--worktree-attributes 让规则对
# 尚未包含 .gitattributes 的旧 tag 也生效。
# 基线取 **tag 树**（而非 git ls-files=HEAD）：对旧 tag 补做归档时两者不同。
TAG_COUNT=$(git ls-tree -r --name-only "$TAG" | grep -c . || true)
EXPORT_IGNORED="$(git ls-tree -r --name-only "$TAG" | git check-attr --stdin export-ignore | sed -n 's/: export-ignore: set$//p')"
EXPORT_IGNORED_COUNT=$(printf '%s\n' "$EXPORT_IGNORED" | grep -c . || true)
if [ "$EXPORT_IGNORED_COUNT" -gt 0 ]; then
  echo "export-ignore ($EXPORT_IGNORED_COUNT):"
  printf '%s\n' "$EXPORT_IGNORED" | sed 's#^#  - #'
fi
git cat-file -e "$TAG:.gitattributes" 2>/dev/null || \
  echo "note: $TAG predates .gitattributes — applying today's worktree export-ignore rules"

# ---- 步骤 6：打包——git archive 仅含已跟踪文件（自动遵守 .gitignore） ----
git archive --worktree-attributes --format=tar.gz --prefix="qialike-$VERSION/" -o "$TARBALL" "$TAG"
git archive --worktree-attributes --format=zip   --prefix="qialike-$VERSION/" -o "$ZIPBALL" "$TAG"

# ---- 步骤 7：列出产物 ----
echo "== archives =="
ls -la "$TARBALL" "$ZIPBALL"
echo "== other archives in $OUT_DIR (this script never deletes them) =="
# Historical `dsh-tui-<version>` packages stay listed here too: they are the
# release records from before the rename and this script never deletes them.
ls -1 "$OUT_DIR"/qialike-*.tar.gz "$OUT_DIR"/qialike-*.zip "$OUT_DIR"/dsh-tui-*.tar.gz "$OUT_DIR"/dsh-tui-*.zip 2>/dev/null \
  | grep -v "/qialike-$VERSION\." | sed 's#^#  #' || true

# ---- 步骤 8：验证 1——基线文件数 = tag 树文件 − export-ignore ----
EXPECTED=$(( TAG_COUNT - EXPORT_IGNORED_COUNT ))
echo "expected files: $EXPECTED (tag tree $TAG_COUNT − export-ignore $EXPORT_IGNORED_COUNT)"

# ---- 步骤 9：验证 2——列出两种包的内容（前 35 条） ----
# 用 sed -n '1,35p' 而不是 head -35：pipefail 下 head 提前关管道会让上游拿到
# SIGPIPE 而整脚本以 141 退出（验证步骤全被跳过）。sed 会读到流末尾。
echo "== tar.gz entries =="; tar -tzf "$TARBALL" | sed 's#^#  #' | sed -n '1,35p'
echo "== zip entries ==";     unzip -l "$ZIPBALL" | sed 's#^#  #' | sed -n '1,35p'

# ---- 步骤 10：验证 3——抽查关键文件（bin.ts / index.tsx） ----
# 用 grep -c（读完整个流）而非 grep -q：pipefail 下 grep -q 命中即关管道，
# 触发 SIGPIPE 使管道返回非零，`&& echo` 会被跳过（假阴性）。
for f in apps/tui-bin/src/bin.ts packages/qialike-app/src/index.tsx; do
  [ "$(tar -tzf "$TARBALL" | grep -c "qialike-$VERSION/$f")" -gt 0 ] && echo "  [ok] $f (tar)"
  [ "$(unzip -l "$ZIPBALL" | grep -c "qialike-$VERSION/$f")" -gt 0 ] && echo "  [ok] $f (zip)"
done

# ---- 步骤 11：验证 4——确认无被禁条目（构建产物 / 本机文件 / export-ignore） ----
echo "== forbidden entries (expect none) =="
for pat in node_modules/ dist/ .env .resolve/ generated/ apps/tui-bin/x/ stub-native/ \
           '/lib/' .tsbuildinfo install.log build.log \
           /medium-doc.md /report.md /REPORT.md \
           /formatting-demo.md /software-testing-guide.md /testing-frameworks.md \
           /letter.md /maintainable-software-report.md; do
  if [ "$(tar -tzf "$TARBALL" | grep -c "qialike-$VERSION/$pat")" -gt 0 ] || \
     [ "$(unzip -l "$ZIPBALL" | grep -c "qialike-$VERSION/$pat")" -gt 0 ]; then
    echo "  [FAIL] forbidden present: $pat"; exit 1
  fi
done
while IFS= read -r f; do
  [ -n "$f" ] || continue
  if [ "$(tar -tzf "$TARBALL" | grep -c "qialike-$VERSION/$f\$")" -gt 0 ] || \
     [ "$(unzip -l "$ZIPBALL" | grep -c "qialike-$VERSION/$f\$")" -gt 0 ]; then
    echo "  [FAIL] export-ignored file present: $f"; exit 1
  fi
done <<< "$EXPORT_IGNORED"
echo "  none present"

# ---- 步骤 12：验证 5——解包并核对文件数（不一致即失败） ----
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
tar -xzf "$TARBALL" -C "$TMP"
unzip -q "$ZIPBALL" -d "$TMP/zip"
# 计数用「归档里的非目录条目」而不是 `find -type f`：已跟踪的符号链接在归档里是条目、
# 解包后却过不了 -type f，会让文件数核对误报失败。
COUNT=$(tar -tzf "$TARBALL" | grep -vc '/$')
COUNT_ZIP=$(unzip -Z1 "$ZIPBALL" | grep -vc '/$')
echo "files in archives: tar.gz=$COUNT zip=$COUNT_ZIP (expect $EXPECTED)"
[ "$COUNT" = "$EXPECTED" ] || { echo "  [FAIL] tar.gz file count mismatch"; exit 1; }
[ "$COUNT_ZIP" = "$EXPECTED" ] || { echo "  [FAIL] zip file count mismatch"; exit 1; }
diff -r "$TMP/qialike-$VERSION" "$TMP/zip/qialike-$VERSION" >/dev/null \
  && echo "  [ok] tar.gz and zip contents are identical" \
  || { echo "  [FAIL] tar.gz and zip differ"; exit 1; }

# ---- 步骤 13：完成 ----
echo "DONE"
