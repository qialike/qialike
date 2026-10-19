#!/usr/bin/env python3
"""audit-gateway-endpoints.py — 无 key 前提下审计每个网关端点的可用性

WHAT IT CAN AND CANNOT ANSWER. 没有 API key 时，无法知道一个网关"线上有哪些模型"
——那需要鉴权。能确定的是**路径是否正确**，而这正是最容易写错、且一旦写错就
100% 不可用的那类问题（0.11.0 之后的实测里就抓到两处：`fireworks` 与
`vercel-ai-gateway` 各少一个 `/v1`，模型探测与对话请求全部 404）。

判据是状态码的语义差异：
    401 / 403  路由存在，缺的只是凭据        -> 路径 OK
    400        路由存在，请求体不合法        -> 路径 OK
    404        路由不存在                    -> **路径错**
    000        连不上/超时                   -> 需要人看
    200        公开可读（少数网关如此）      -> 路径 OK，且顺带能数出线上模型数

SPECIAL CASE — anthropic 协议。那几行本来就没有 `/models`（协议不提供该端点，
qialike 运行时也会跳过它们），所以对它们只查 `POST /v1/messages`。

用法：
    ./audit-gateway-endpoints.py                     # 全量审计
    ./audit-gateway-endpoints.py --only openrouter,fireworks
    ./audit-gateway-endpoints.py --timeout 6
    ./audit-gateway-endpoints.py --json              # 机器可读

退出码：0 = 没有发现路径错误；1 = 有端点返回 404（说明模板的 baseURL 写错）；
2 = 有端点不可达（网络问题，不一定是模板错）。
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

APP = Path(__file__).resolve().parent.parent.parent / 'packages' / 'qialike-app' / 'src'
TEMPLATE_FILES = (
    'provider-templates.json',
    'china-gateway-templates.json',
    'foreign-gateway-templates.json',
    'azure-templates.json',
)


def request(url: str, method: str = 'GET', body: bytes | None = None, timeout: int = 8) -> tuple[int, int]:
    """Return (status, model_count). model_count is -1 unless a 200 carried a list."""
    req = urllib.request.Request(url, method=method, data=body)
    req.add_header('accept', 'application/json')
    if body is not None:
        req.add_header('content-type', 'application/json')
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            status = response.status
            count = -1
            if status == 200 and method == 'GET':
                try:
                    payload = json.loads(response.read().decode('utf-8'))
                    rows = payload.get('data') if isinstance(payload, dict) else payload
                    if isinstance(rows, list):
                        count = len(rows)
                except (json.JSONDecodeError, UnicodeDecodeError):
                    pass
            return status, count
    except urllib.error.HTTPError as error:
        return error.code, -1
    except (urllib.error.URLError, TimeoutError, OSError):
        return 0, -1


def verdict(status: int) -> str:
    if status in (200, 401, 403, 400):
        return 'ok'
    if status == 404:
        return 'PATH'
    if status == 0:
        return 'UNREACHABLE'
    return 'check'


def main() -> int:
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument('--only', default='')
    parser.add_argument('--timeout', type=int, default=8)
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args()
    only = {s.strip() for s in args.only.split(',') if s.strip()}

    rows: list[dict] = []
    seen: set[str] = set()
    for name in TEMPLATE_FILES:
        for row in json.loads((APP / name).read_text(encoding='utf-8')):
            route = row.get('route')
            if route in seen:
                continue
            seen.add(route)
            rows.append(row)

    results = []
    path_bad = unreachable = 0
    for row in rows:
        route = row.get('route', '?')
        if only and route not in only:
            continue
        base = (row.get('baseURL') or '').strip()
        if base == '' or '${' in base:
            results.append({'route': route, 'verdict': 'skip', 'why': 'baseURL 为空或含占位符', 'status': None})
            continue
        root = base.rstrip('/')
        anthropic = row.get('api') == 'anthropic-messages'

        status, count = request(f'{root}/models', timeout=args.timeout)
        probe = 'GET /models'
        if anthropic or status == 404:
            # 协议没有 /models，或 /models 404：用一个真实 POST 判断路径对不对。
            if anthropic:
                chat_status, _ = request(f'{root}/v1/messages', 'POST',
                                         b'{"model":"x","max_tokens":1,"messages":[]}', args.timeout)
                probe = 'POST /v1/messages'
            else:
                chat_status, _ = request(f'{root}/chat/completions', 'POST',
                                         b'{"messages":[]}', args.timeout)
                probe = 'POST /chat/completions'
            # 只要 POST 不是 404，路径就是对的；/models 的 404 属协议本身。
            if chat_status != 404 and chat_status != 0:
                status = chat_status
            elif chat_status == 404 and not anthropic:
                status = 404
            else:
                status = chat_status

        v = verdict(status)
        if v == 'PATH':
            path_bad += 1
        elif v == 'UNREACHABLE':
            unreachable += 1
        results.append({'route': route, 'verdict': v, 'status': status, 'models': count, 'probe': probe})

    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
    else:
        print(f'  {"route":26} {"probe":24} {"code":>4}  {"线上模型":>8}  判定')
        print('  ' + '-' * 84)
        label = {'ok': '✅ 路径 OK', 'PATH': '❌ 404 路径错', 'UNREACHABLE': '⏱ 不可达',
                 'check': '? 需人工看', 'skip': '— 跳过'}
        for r in results:
            count = '' if r.get('models', -1) < 0 else str(r['models'])
            code = '' if r['status'] is None else str(r['status'])
            print(f'  {r["route"]:26} {r.get("probe", ""):24} {code:>4}  {count:>8}  {label[r["verdict"]]}')
        print()
        print(f'  汇总：路径错 {path_bad} / 不可达 {unreachable} / 共 {len(results)} 行')

    if path_bad:
        return 1
    if unreachable:
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
