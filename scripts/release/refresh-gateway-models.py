#!/usr/bin/env python3
"""refresh-gateway-models.py — 用网关自己的 /models 刷新本地静态快照

WHY THIS EXISTS. 静态快照（`*gateway-templates.json` 里每行的 `models`）有两个用途：
① 探测失败时的兜底列表；② 端点不报某个字段时该字段的来源。所以它必须**定期刷新**
——实测（2026-10-19）本地快照与线上偏差很大：OpenRouter 357 vs 471、HuggingFace
72 vs 132、nvidia 103 vs 81。手工维护 40+ 张表既不现实也必然过时。

WHAT IT DOES. 对每个可公开读取 `/models` 的网关，取回线上列表，按 qialike 自己的
提取规则（`context_length` / `context_window`、`top_provider.max_completion_tokens`、
`architecture.input_modalities`|`modalities`）生成 `models` 数组，写回对应 JSON。

它**只改 `models` 字段**，`route` / `name` / `baseURL` / `apiKeyEnv` / `api` /
`includeModelPrefixes` 一概不动 —— 那些是人工校订的语义，脚本无权猜。

需要鉴权的网关（401）会被**跳过并报告**，不写空列表：把一张表刷成空是比不刷更坏的
结果。要刷新它们，请先导出该网关的 key 到对应 `apiKeyEnv`，脚本会自动带上。

两条刻意的保守规则，都是"刷新不该让数据变差"的直接推论：
  · **逐字段合并**，不整体替换 —— 有的端点只回 `id`（alibaba-coding-plan），整体替换
    会抹掉人工校订的 `name` 与限额；
  · **默认不删**线上已不列出的条目 —— `/models` 不是"其它都下线"的声明，而匿名探测
    分不清"已下线"与"没给你看"（两者都只是 401）。确要按线上为准加 `--prune`。

用法：
    ./refresh-gateway-models.py                  # 预演：只报告差异，不写文件
    ./refresh-gateway-models.py --write          # 真的写回 JSON
    ./refresh-gateway-models.py --only openrouter,huggingface
    ./refresh-gateway-models.py --env-file ~/.dsh/.env   # 从这里读各网关的 key

退出码：0 = 正常（含"无需改动"）；1 = 参数错误或网络全失败。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

# 本脚本在 <repo>/scripts/release/，模板在 <repo>/packages/qialike-app/src/。
APP = Path(__file__).resolve().parent.parent.parent / 'packages' / 'qialike-app' / 'src'
TEMPLATE_FILES = (
    'provider-templates.json',
    'china-gateway-templates.json',
    'foreign-gateway-templates.json',
    'azure-templates.json',
)
TIMEOUT = 12


def positive(value) -> int | None:
    """qialike 的 `positiveNumber`：有限正数才要，向下取整。"""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if value != value or value in (float('inf'), float('-inf')) or value <= 0:  # NaN/inf
        return None
    return int(value)


def entry_to_model(entry: dict) -> dict | None:
    """把线上一条记录转成 qialike 模板里 `models` 的元素。

    字段名按 qialike 的 `dynamicModelInfo` 来 —— 与运行时看的是同一套拼写，
    否则快照与探测会各说各话。
    """
    mid = entry.get('id')
    if not isinstance(mid, str) or mid == '':
        return None
    out: dict = {'id': mid}
    # `name` is always present: the template schema and the TUI both require it, and a
    # model the user picks by bare id reads worse than one showing its id as its name.
    name = entry.get('name')
    out['name'] = name if isinstance(name, str) and name != '' else mid
    ctx = positive(entry.get('context_length')) or positive(entry.get('context_window'))
    if ctx is not None:
        out['contextWindow'] = ctx
    top = entry.get('top_provider')
    max_out = positive(top.get('max_completion_tokens')) if isinstance(top, dict) else None
    if max_out is None:
        max_out = positive(entry.get('max_tokens'))
    if max_out is not None:
        out['maxTokens'] = max_out
    mods = None
    arch = entry.get('architecture')
    if isinstance(arch, dict):
        mods = arch.get('input_modalities')
    if mods is None:
        mods = entry.get('modalities')
    if isinstance(mods, list):
        tagged = [m for m in mods if m in ('text', 'image')]
        if tagged:
            out['inputModalities'] = sorted(set(tagged))
    return out


def probe(base_url: str, api_key: str | None) -> list[dict] | None:
    url = base_url.rstrip('/') + '/models'
    req = urllib.request.Request(url, headers={'accept': 'application/json'})
    if api_key:
        req.add_header('authorization', f'Bearer {api_key}')
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as response:
            body = json.loads(response.read().decode('utf-8'))
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError):
        return None
    rows = body.get('data') if isinstance(body, dict) else body
    if not isinstance(rows, list):
        return None
    models, seen = [], set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        model = entry_to_model(row)
        if model is None or model['id'] in seen:
            continue
        seen.add(model['id'])
        models.append(model)
    return models or None


def load_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for line in path.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if line == '' or line.startswith('#') or '=' not in line:
            continue
        key, _, value = line.partition('=')
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def main() -> int:
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument('--write', action='store_true', help='写回 JSON（默认只预演）')
    parser.add_argument('--only', default='', help='只刷这些 route（逗号分隔）')
    parser.add_argument('--env-file', default='', help='从这里读各网关的 key')
    parser.add_argument('--prune', action='store_true',
                        help='删掉线上已不列出的条目（默认保留：无法区分“已下线”与“未列出”）')
    args = parser.parse_args()

    env_extra = load_env_file(Path(args.env_file).expanduser()) if args.env_file else {}
    only = {s.strip() for s in args.only.split(',') if s.strip()}

    rows: list[tuple[str, dict]] = []          # (文件名, 行)
    for name in TEMPLATE_FILES:
        path = APP / name
        for row in json.loads(path.read_text(encoding='utf-8')):
            rows.append((name, row))

    changed = skipped = unchanged = failed = 0
    for filename, row in rows:
        route = row.get('route', '?')
        if only and route not in only:
            continue
        base = (row.get('baseURL') or '').strip()
        if base == '' or '${' in base:
            print(f'  [skip] {route:24} baseURL 为空或含占位符，无法探测')
            skipped += 1
            continue
        # Anthropic 协议没有 /models；qialike 运行时也会跳过它们。
        if row.get('api') == 'anthropic-messages':
            print(f'  [skip] {route:24} anthropic-messages 无 /models 端点')
            skipped += 1
            continue

        env_name = row.get('apiKeyEnv') or route.upper().replace('-', '_') + '_API_KEY'
        key = os.environ.get(env_name, '') or env_extra.get(env_name, '')
        live = probe(base, key or None)
        if live is None:
            print(f'  [skip] {route:24} 探测失败（需鉴权或不可达；{"已带 key" if key else "无 key"}）')
            skipped += 1
            continue

        # MERGE, do not replace. Some endpoints answer with ids alone (measured:
        # alibaba-coding-plan returns only `{id, object, created, ownedBy}`), and a
        # blind replace would drop the hand-curated `name` and the limits those rows
        # already carry — strictly worse than not refreshing. So the live entry wins
        # per FIELD, and the existing row keeps whatever the endpoint is silent about.
        old_by_id = {m.get('id'): m for m in row.get('models') or []}
        merged: list[dict] = []
        for entry in live:
            prior = old_by_id.get(entry['id']) or {}
            combined = dict(prior)
            combined.update(entry)          # live wins for the fields it reports
            merged.append(combined)
        # KEEP what the endpoint no longer lists. A gateway's `/models` is not a
        # statement that everything else is gone: some报告 subsets (alibaba-coding-plan
        # lists 6 while its own templates name 12), and an anonymous probe cannot tell
        # "retired" from "not shown to you" — every request for a possibly-retired model
        # answers 401, so there is nothing to distinguish them. Dropping an entry that
        # still works costs the user a provider; keeping one that is retired costs a
        # failed request they can see. `--prune` opts into the aggressive reading.
        if not args.prune:
            live_ids = {entry['id'] for entry in live}
            for prior in row.get('models') or []:
                if prior.get('id') not in live_ids:
                    merged.append(prior)
        old_ids = [m.get('id') for m in row.get('models') or []]
        new_ids = [m['id'] for m in merged]
        added = len(set(new_ids) - set(old_ids))
        removed = len(set(old_ids) - set(new_ids))
        if (row.get('models') or []) == merged:
            print(f'  [same] {route:24} 线上 {len(new_ids)} 个，与本地一致')
            unchanged += 1
            continue
        print(f'  [diff] {route:24} 线上 {len(new_ids):>4} / 本地 {len(old_ids):>4}  新增 {added:>3}  下线 {removed:>3}')
        changed += 1
        if args.write:
            row['models'] = merged

    if args.write and changed > 0:
        for name in TEMPLATE_FILES:
            path = APP / name
            data = json.loads(path.read_text(encoding='utf-8'))
            by_route = {r.get('route'): r for r in data}
            for filename, row in rows:
                if filename == name and row.get('route') in by_route:
                    by_route[row['route']]['models'] = row.get('models')
            path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print(f'\n  已写回 {changed} 张表')
    elif changed > 0:
        print(f'\n  预演：{changed} 张表需要更新（加 --write 才会写回）')

    print(f'\n  汇总：变更 {changed} / 一致 {unchanged} / 跳过 {skipped} / 失败 {failed}')
    return 0 if (changed or unchanged or skipped) else 1


if __name__ == '__main__':
    sys.exit(main())
