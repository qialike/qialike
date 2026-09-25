#!/usr/bin/env bash
# =============================================================================
# test-required.sh — 发布必做的「仓库内测试」（全量真机之外的都在这）
#
# 定位（与开发文档 §8.3 的对应关系）：
#   · 本脚本 = §8.3 的**前置 + ① tsc + ② bun test + ③ 版本身份 + 附加：真机冒烟**，
#     全部围绕**仓库内**的东西（源码、`tests/`、三处 package.json、本地产物）。
#   · 「全量真机套件」（§8.3 的 ④局部场景 / ⑤全量回归 / ⑥文档审计）需要仓库**外**的
#     `~/deepseek/test/`，属**选测项** —— 用那边的脚本跑：
#         ~/deepseek/test/full-suite.sh            # ⑤ 全量（选做）
#     （或工作台根的 `~/deepseek/release-menu.sh` 菜单项 17/18）
#   · **发布必须**跑完本脚本且全绿；选测项跑不跑由发布者决定，但"跑没跑都要如实写"。
#
# 为什么 ② 用 `bun test`（不带路径）：与发布门 `test/release-check.sh` 的 ② 逐字一致
#   —— bun 的默认发现规则会扫到仓库内全部测试文件（当前 115 个 `*.test.ts` 全在 `tests/`
#   下，故 `bun test` ≡ `bun test tests/`；将来若有人在 `tests/` 之外新增测试文件，
#   本脚本与门都会扫到，不会漏）。
#
# 用法：
#   ./test-required.sh                  # 前置 + ① ② ③ + 附加冒烟（发布路径）
#   ./test-required.sh --skip-smoke     # 跳过真机冒烟（只做 ① ② ③）
#   ./test-required.sh --allow-dirty    # 允许脏工作区（仅本地预演；发版不许）
#   ./test-required.sh --allow-stale    # 允许 dist 比源码旧（仅本地预演；发版不许）
#   ./test-required.sh --bin /path/to/qialike   # 换被测二进制（默认按宿主目标自动解析）
#   ./test-required.sh -h
#
# 环境变量：
#   QIALIKE_BIN                 被测二进制（等价 --bin）
#   TSC_BIN                     指定 tsc（默认 ./node_modules/.bin/tsc；本机 pnpm 有故障，
#                               故不经 `pnpm run typecheck`）
#
# 退出码：0 = 全部通过；1 = 任一环节失败（并指明是哪一环）。
# =============================================================================
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PKG_FILES=("package.json" "packages/qialike-app/package.json" "apps/tui-bin/package.json")

ALLOW_DIRTY=0
ALLOW_STALE=0
SKIP_SMOKE=0
BIN_OVERRIDE="${QIALIKE_BIN:-}"

usage() { sed -n '2,/^set -euo pipefail$/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --allow-dirty) ALLOW_DIRTY=1 ;;
    --allow-stale) ALLOW_STALE=1 ;;
    --skip-smoke) SKIP_SMOKE=1 ;;
    --bin) BIN_OVERRIDE="${2:-}"; shift ;;
    --bin=*) BIN_OVERRIDE="${1#--bin=}" ;;
    -h | --help) usage; exit 0 ;;
    *) usage; echo "qialike: 未知参数 '$1'" >&2; exit 1 ;;
  esac
  shift
done

say() { printf '  %s\n' "$*"; }
bold() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
ok() { printf '  [ok]   %s\n' "$*"; }
bad() { printf '  [FAIL] %s\n' "$*" >&2; }
die() { printf '\n发布必做项未通过：%s\n' "$*" >&2; exit 1; }

host_target() {
  local os arch
  case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; MINGW* | MSYS* | CYGWIN*) os=windows ;; *) os=unknown ;; esac
  case "$(uname -m)" in x86_64 | amd64) arch=x64 ;; aarch64 | arm64) arch=arm64 ;; *) arch=unknown ;; esac
  printf '%s-%s' "$os" "$arch"
}

resolve_bin() {
  if [[ -n "$BIN_OVERRIDE" ]]; then printf '%s' "$BIN_OVERRIDE"; return 0; fi
  if [[ -f "$REPO/dist/qialike" ]]; then printf '%s' "$REPO/dist/qialike"; return 0; fi
  local p="$REPO/dist/$(host_target)/qialike"
  if [[ -f "$p.exe" ]]; then printf '%s' "$p.exe"; return 0; fi
  printf '%s' "$p"
}

FAILED=()
step() { # step <名字> <命令…>
  local label="$1"; shift
  if "$@"; then ok "$label"; else bad "$label"; FAILED+=("$label"); fi
}

echo
bold "发布必做 · 仓库内测试（全量真机之外的都在这）"
say "repo = $REPO"

# ── 前置 1：工作区必须 clean（发布必须来自已提交的树） ──────────────────────
bold "前置：工作区"
DIRTY="$(git -C "$REPO" status --porcelain | wc -l | tr -d ' ')"
if [[ "$DIRTY" == 0 ]]; then
  ok "工作区 clean（HEAD=$(git -C "$REPO" rev-parse --short HEAD) describe=$(git -C "$REPO" describe --tags 2>/dev/null || echo '?'))"
elif [[ "$ALLOW_DIRTY" == 1 ]]; then
  say "[warn] 工作区有 $DIRTY 项未提交改动（--allow-dirty，仅限本地预演）"
else
  git -C "$REPO" status --porcelain | sed 's/^/    /'
  die "工作区不干净（$DIRTY 项）—— 先提交，或用 --allow-dirty 预演"
fi

# ── 前置 2：被测二进制存在，且 dist 比源码新（二进制是唯一被测对象） ──────────
bold "前置：被测二进制"
BIN="$(resolve_bin)"
[[ -f "$BIN" ]] || die "找不到被测二进制：$BIN（先做 scripts/release/build-qialike.sh <版本>）"
say "被测二进制：${BIN/#$REPO\//}（$(date -r "$BIN" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo '?')）"
NEWER="$(find "$REPO/packages" "$REPO/apps" \
  -path '*/node_modules' -prune -o -path "$REPO/apps/tui-bin/x" -prune -o -path "$REPO/apps/tui-bin/stub-native" -prune -o \
  -type f \( -name '*.ts' -o -name '*.tsx' \) -newer "$BIN" -print -quit 2>/dev/null)"
if [[ -z "$NEWER" ]]; then
  ok "dist 比源码新"
elif [[ "$ALLOW_STALE" == 1 ]]; then
  say "[warn] dist 比源码旧（例如 ${NEWER/#$REPO\//}）—— --allow-stale，仅限本地预演"
else
  bad "被测二进制比源码旧（例如 ${NEWER/#$REPO\//}）"
  say "注意不要随手改跑 --single：它会清空 dist/，把已产出的 6 个资产与 sha256sums.txt 一起删掉。"
  die "dist 比源码旧 —— 先重建：./scripts/release/build-qialike.sh"
fi

# ── ① tsc（只允许既存的 3 处 wrap-ansi TS7016） ──────────────────────────────
bold "① tsc（类型检查）"
TSC="${TSC_BIN:-$REPO/node_modules/.bin/tsc}"
[[ -x "$TSC" ]] || die "找不到 tsc：$TSC（依赖未装？可用 TSC_BIN= 指定）"
TSC_OUT="$(cd "$REPO" && "$TSC" -p tsconfig.typecheck.json 2>&1 || true)"
TSC_ALL="$(printf '%s\n' "$TSC_OUT" | grep -cE 'error TS[0-9]+' || true)"
TSC_KNOWN="$(printf '%s\n' "$TSC_OUT" | grep -cE "error TS7016: Could not find a declaration file for module 'wrap-ansi'" || true)"
TSC_NEW=$((TSC_ALL - TSC_KNOWN))
if [[ "$TSC_NEW" -gt 0 ]]; then
  printf '%s\n' "$TSC_OUT" | grep -E 'error TS[0-9]+' | sed 's/^/    /'
  bad "类型检查新增 $TSC_NEW 处错误（总 $TSC_ALL，既有 wrap-ansi $TSC_KNOWN）"
  FAILED+=("① tsc")
else
  ok "只剩既有 $TSC_KNOWN 处 wrap-ansi TS7016（总错误 $TSC_ALL）"
fi

# ── ② bun test（仓库内全量单测；与门同一条命令，必须 0 fail） ─────────────────
bold "② bun test（仓库内全量单测）"
TEST_OUT="$(cd "$REPO" && bun test 2>&1)" && TEST_RC=0 || TEST_RC=$?
printf '%s\n' "$TEST_OUT" | grep -E '^ *[0-9]+ (pass|fail|skip)|^Ran ' | sed 's/^/  /'
if [[ "$TEST_RC" != 0 ]]; then
  bad "bun test 退出码 $TEST_RC"
  FAILED+=("② bun test")
else
  ok "$(printf '%s\n' "$TEST_OUT" | grep -E '^ *[0-9]+ pass' | tail -1 | tr -s ' ')"
fi

# ── ③ 版本身份（三处 package.json + tag 树 + 二进制自报） ─────────────────────
bold "③ 版本身份"
V_ROOT="$(node -p "require('$REPO/package.json').version")"
BAD_V=0
for f in "${PKG_FILES[@]}"; do
  v="$(node -p "require('$REPO/$f').version" 2>/dev/null || echo '?')"
  if [[ "$v" == "$V_ROOT" ]]; then ok "package.json  $f = $v"; else bad "package.json  $f = $v（应为 $V_ROOT）"; BAD_V=1; fi
done
if git -C "$REPO" rev-parse -q --verify "refs/tags/v$V_ROOT" >/dev/null 2>&1; then
  for f in "${PKG_FILES[@]}"; do
    v="$(git -C "$REPO" show "v$V_ROOT:$f" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))' 2>/dev/null || echo '?')"
    if [[ "$v" == "$V_ROOT" ]]; then ok "tag v$V_ROOT  $f = $v"; else bad "tag v$V_ROOT  $f = $v"; BAD_V=1; fi
  done
else
  say "[warn] tag v$V_ROOT 尚不存在（打标签前正常；归档/推送前必须有）"
fi
V_SELF="$("$BIN" --version 2>/dev/null | awk '{print $2}' || echo '?')"
if [[ "$V_SELF" == "$V_ROOT" ]]; then ok "二进制自报 = qialike $V_SELF"; else bad "二进制自报 = ${V_SELF:-?}（应为 $V_ROOT）"; BAD_V=1; fi
say "回填用：HEAD=$(git -C "$REPO" rev-parse --short HEAD)  describe=$(git -C "$REPO" describe --tags 2>/dev/null || echo '?')  dist md5=$(md5sum "$BIN" | awk '{print $1}')"
[[ "$BAD_V" == 0 ]] || FAILED+=("③ 版本身份")

# ── 附加：真机冒烟（打包二进制真的能启动：dsh-base + qialike-app 组合 + TUI 命令解析）──
#    注意：它**不是** §8.3 的 ④（那是「本版改动的局部场景」，在仓库外跑）；
#    本脚本只做 §8.3 的前置 + ①–③，冒烟是仓内能做的最后一道组合启动检查。
bold "附加：真机冒烟（tests/smoke.mjs）"
if [[ "$SKIP_SMOKE" == 1 ]]; then
  say "跳过（--skip-smoke）"
else
  if (cd "$REPO" && QIALIKE_BIN="$BIN" node tests/smoke.mjs); then ok "smoke：真实组合启动 + --help 解析"; else bad "smoke 失败"; FAILED+=("附加：真机冒烟"); fi
fi

# ── 汇总 ────────────────────────────────────────────────────────────────────
echo
if [[ ${#FAILED[@]} -eq 0 ]]; then
  printf '\033[1m发布必做项全部通过\033[0m（① 类型 + ② 全量单测 + ③ 身份 + 附加冒烟）\n'
  say "选测项（不在本脚本内，跑没跑都要如实写）："
  say "  ~/deepseek/test/full-suite.sh            # ⑤ 全量真机套件（约 11 分钟、零 token）"
  say "  ~/deepseek/test/full-suite.sh <场景子串>  # ④ 局部场景"
  say "  python3 -u ~/deepseek/test/doc-audit.py  # ⑥ 文档与状态对账"
  exit 0
fi
die "失败环节：${FAILED[*]}"
