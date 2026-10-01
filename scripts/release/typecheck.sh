#!/usr/bin/env bash
# =============================================================================
# typecheck.sh — qialike 的类型检查**策略**，唯一一处
#
# 为什么要有这个脚本、而不是各处直接跑 `tsc`：
#   `tsc` 对**任何**错误都退出 1，而本树有 **3 处已知的** `wrap-ansi` TS7016
#   —— 那个依赖不随包发声明文件。于是"通过"的真实定义是
#   「除已知的 wrap-ansi 之外零错误」。这条判定原先**只**写在 `test-required.sh`
#   里，而 CI 跑的是裸 `tsc` ⇒ **CI 永远红、发布门却是绿的**：同一条门两套口径。
#   现在 CI、发布门、`pnpm typecheck` 都调本脚本，口径只有这一份。
#
# 两条前置（都是**构建产物**；缺任一条都会红成"看起来像代码错"的样子）：
#   ① `<repo>/../deepseek-harness` 必须存在且已构建。
#      `tsconfig.typecheck.json` 的 22 条 `paths` 正是按这个**同级**布局写的，指向
#      harness 自己的 `lib/types/*.d.ts`。harness 放在别处 ⇒ 22 条全部悬空 ⇒ 退回
#      node_modules 解析 ⇒ 报 `Cannot find module '@deepseek-ai/cordis'`
#      （CI 曾把 harness 克隆到 `$RUNNER_TEMP`，就是这么红的 —— 而报错文本会让人
#       以为是代码或"解析农场顺序"的问题，实际与两者都无关）。
#   ② `node_modules/wrap-ansi` 必须可解析。它**不在** package.json 里，由
#      `apps/tui-bin/build.mjs` 的 `mirrorHarnessStore` 从 harness 的 hoisted store
#      链进来。不满足时那 3 条会从 TS7016 变成 TS2307（`Cannot find module 'wrap-ansi'`）。
#   两条都能被这一条命令满足（秒级、**不编译**、不碰 `dist/` 与 build-channel）：
#       node apps/tui-bin/build.mjs --generate-only
#
# 用法：
#   bash scripts/release/typecheck.sh
# 环境变量：
#   TSC_BIN   指定 tsc（默认 `<repo>/node_modules/.bin/tsc`）
# 退出码：0 = 只剩已知的 wrap-ansi；1 = 有新增错误、或前置缺失（两种都给出可执行的修法）
# =============================================================================
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# `tsconfig.typecheck.json` 的 paths 写死为 `../deepseek-harness`，所以这里只能是同级。
HARNESS_SIBLING="$(cd "$REPO/.." && pwd)/deepseek-harness"
FARM_HINT="node apps/tui-bin/build.mjs --generate-only"

ok() { printf '  [ok]   %s\n' "$*"; }
bad() { printf '  [FAIL] %s\n' "$*" >&2; }
note() { printf '    %s\n' "$*" >&2; }

TSC="${TSC_BIN:-$REPO/node_modules/.bin/tsc}"
if [[ ! -x "$TSC" ]]; then
  bad "找不到 tsc：$TSC（依赖未装？可用 TSC_BIN= 指定）"
  exit 1
fi

# 前置①先查：缺 harness 时 tsc 会吐一屏 `Cannot find module`，那是误导性的表象。
if [[ ! -d "$HARNESS_SIBLING" ]]; then
  bad "缺少同级 harness：${HARNESS_SIBLING/#$HOME/~}"
  note "tsconfig.typecheck.json 的 22 条 paths 指向它；缺了会报成一堆 Cannot find module。"
  note "修法：把 deepseek-harness 检出并构建到该路径（CI 就是克隆到这里）。"
  exit 1
fi

OUT="$("$TSC" -p "$REPO/tsconfig.typecheck.json" 2>&1 || true)"
ALL="$(printf '%s\n' "$OUT" | grep -cE 'error TS[0-9]+' || true)"
KNOWN="$(printf '%s\n' "$OUT" | grep -cE "error TS7016: Could not find a declaration file for module 'wrap-ansi'" || true)"
NEW=$((ALL - KNOWN))

# 前置②：wrap-ansi 不通时那 3 条会变形，必须说清是前置而不是代码问题。
if printf '%s\n' "$OUT" | grep -qE "Cannot find module 'wrap-ansi'"; then
  bad "wrap-ansi 解析不到 —— 这是**前置缺失**，不是代码错误"
  note "它不在 package.json 里，由 build.mjs 的 mirrorHarnessStore 从 harness store 镜像进来。"
  note "修法：$FARM_HINT"
  exit 1
fi

if [[ "$NEW" -gt 0 ]]; then
  printf '%s\n' "$OUT" | grep -E 'error TS[0-9]+' >&2
  bad "类型检查新增 $NEW 处错误（总 $ALL，既有 wrap-ansi $KNOWN）"
  # 悬空的 @deepseek-ai/* 是"harness 在、但没构建"的典型形态（lib/ 未生成）。
  if printf '%s\n' "$OUT" | grep -qE "Cannot find module '@deepseek-ai/"; then
    note "上面有 @deepseek-ai/* 解析失败 —— 确认那份同级 harness 已经构建过（pnpm install && pnpm run build）。"
  fi
  exit 1
fi

if [[ "$ALL" -eq 0 ]]; then
  ok "0 处类型错误"
else
  ok "只剩既有 $KNOWN 处 wrap-ansi TS7016（总错误 $ALL）"
fi
