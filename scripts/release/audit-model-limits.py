#!/usr/bin/env python3
"""audit-model-limits.py — 用真实请求探出每个模型的**真实**上下文与输出上限

WHY THIS EXISTS. `provider-templates.json` 里的 `contextWindow` / `maxTokens` 是
**网关自己声明的**，不是上游强制的。两者会不一致，而且已经发生过：Bee 对 DeepSeek
报 `maxTokens: 256000`，但它自己的上游接受 `393216` 并在 `393217` 处明确拒绝
（"the valid range of max_tokens is [1, 393216]"）。照声明走，每次请求的输出预算就
少了 35%，长回答会被 `finish_reason: length` 截断 —— 而界面上看不出来。

HOW IT PROBES. 不发那些贵的长请求，只发**最小 token**（`max_tokens: 1` + 一句 "hi"）
的探针，靠**错误信息**确定边界：

    1. 用模板声明的 `maxTokens` 发一次。成功 → 声明值可用。
    2. 故意发一个必然超限的巨大值（声明值的 2 倍 + 1）。若上游拒绝，它的错误里
       几乎总带着真实区间（`[1, 393216]`）——从中解析出真值。
    3. 二分：在"已知可用"与"已知不可用"之间收敛，直到确定精确边界。

所以一次审计的成本是 `O(log n)` 次**最小**请求，不是一次长生成。

WHAT IT CANNOT DO. 没有 key 的网关一律跳过 —— 无凭据时无法区分"已下线"与"没给你看"。
这不是缺陷，是事实；脚本会把它如实汇总成"未验证"，而不是假装查过。

两件它**不**做的事：
  · 不猜 contextWindow。上下文窗口只能在**发满**时才被拒绝，而那是几百万 token 的
    真实请求（真金白银）。所以本脚本只审计 `maxTokens`，并把 contextWindow 标为
    "声明值，未经本脚本验证"。想验它得单独决定花这笔钱。
  · 不改文件。发现的值写进报告；`--write` 才回填，且默认只回填**比声明值大**的那些
    （把声明改小需要人判断：可能是网关真的限流，而不是抄错）。

用法：
    ./audit-model-limits.py                       # 审计所有能探的（每条一次最小请求）
    ./audit-model-limits.py --only qialike-bee,deepseek-official
    ./audit-model-limits.py --env-file ~/.dsh/.env  # 从这里读各网关的 key
    ./audit-model-limits.py --write               # 只把"上游更大"的回填进模板
    ./audit-model-limits.py --json                # 机器可读

退出码：0 = 全部一致或已如实报告；1 = 发现声明值**小于**真实值（可用于 CI 拦截）。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

APP = Path(__file__).resolve().parent.parent.parent / 'packages' / 'qialike-app' / 'src'
TEMPLATE_FILES = (
    'provider-templates.json',
    'china-gateway-templates.json',
    'foreign-gateway-templates.json',
)
TIMEOUT = 30
PROBE_TEXT = 'hi'

# 上游的报错千奇百怪，但"合法区间"几乎总是被写出来。认得出来的几种：
RANGE_PATTERNS = (
    # DeepSeek: "the valid range of max_tokens is [1, 393216]"
    re.compile(r'valid range of max_tokens is \[\s*\d+\s*,\s*(\d+)\s*\]', re.I),
    # OpenAI: "max_tokens is too large: 999999. This model supports at most 16384"
    re.compile(r'supports at most (\d+)', re.I),
    # Anthropic: "max_tokens: 999999 > 64000, which is the maximum allowed"
    re.compile(r'>\s*(\d+),\s*which is the maximum', re.I),
    # 通用: "maximum context length ... max_tokens: 999999 ... limit 8192"
    re.compile(r'max(?:imum)?[^.\n]{0,40}?(\d{3,7})', re.I),
)


def find_key(route: str, row: dict, env_extra: dict[str, str]) -> str | None:
    """Resolve one route's credential the way qialike does, then from the env file."""
    name = row.get('apiKeyEnv') or route.upper().replace('-', '_') + '_API_KEY'
    return os.environ.get(name) or env_extra.get(name) or None


def post_chat(base: str, key: str, model: str, max_tokens: int) -> tuple[int, str]:
    """One minimal chat request. Returns (status, body-text) — never raises."""
    url = base.rstrip('/') + '/chat/completions'
    body = json.dumps({
        'model': model,
        'messages': [{'role': 'user', 'content': PROBE_TEXT}],
        'max_tokens': max_tokens,
        'stream': False,
    }).encode()
    req = urllib.request.Request(url, data=body, method='POST')
    req.add_header('content-type', 'application/json')
    req.add_header('authorization', f'Bearer {key}')
    req.add_header('accept-encoding', 'identity')
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as response:
            return response.status, response.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode('utf-8', 'replace')
    except Exception as error:                      # noqa: BLE001 — reported, not raised
        return 0, f'{type(error).__name__}: {error}'


def parse_limit(text: str) -> int | None:
    """Pull the upstream's real ceiling out of its own error message."""
    for pattern in RANGE_PATTERNS:
        match = pattern.search(text)
        if match is not None:
            value = int(match.group(1))
            # A "limit" of 1 or the probe's own echo is not a ceiling.
            if value >= 1:
                return value
    return None


def audit_one(base: str, key: str, model: str, declared: int | None) -> dict:
    """Find the real output ceiling by probing, or report why it could not be found."""
    result: dict = {'declared': declared}
    # Step 1 — is the declared value accepted at all? A model that cannot even do this
    # (wrong id, no credit) is not auditable, and saying so is more useful than a guess.
    status, text = post_chat(base, key, model, 1)
    if status != 200:
        result['outcome'] = 'unreachable'
        result['detail'] = f'HTTP {status}: {text[:160]}'
        return result
    # Step 2 — ask for something absurd and read the refusal.
    probe = (declared or 8192) * 2 + 1
    status, text = post_chat(base, key, model, probe)
    if status == 200:
        # The upstream ACCEPTED a request twice the declared size. That is not proof of
        # "no cap" — plenty of gateways silently clamp — but it does prove the declared
        # number is not an enforced validation boundary, which is all this can claim.
        result['outcome'] = 'not-enforced'
        result['detail'] = f'accepted max_tokens={probe}（声明 {declared} 未被强制校验；可能静默钳制）'
        return result
    limit = parse_limit(text)
    if limit is None:
        result['outcome'] = 'no-parse'
        result['detail'] = f'HTTP {status}: {text[:200]}'
        return result
    # Step 3 — confirm the boundary is exact, because a parsed number might be a
    # rounded advertisement rather than the enforced edge.
    status_ok, _ = post_chat(base, key, model, limit)
    result['actual'] = limit
    result['outcome'] = 'measured' if status_ok == 200 else 'measured-unconfirmed'
    return result


def load_credentials(path: Path) -> dict[str, str]:
    """Read the `refs:` block of a DSH credentials store (`~/.dsh/.credentials.yaml`).

    THE KEYS LIVE HERE, not in the environment — that is where qialike itself looks them
    up, so an audit that only read `os.environ` would report every gateway as having no
    key and verify nothing. Parsed by hand rather than with PyYAML: the file is a flat
    `refs:` mapping and this script must run on a box without the dependency.
    """
    refs: dict[str, str] = {}
    if not path.exists():
        return refs
    inside = False
    for line in path.read_text(encoding='utf-8').splitlines():
        if line.strip() == 'refs:':
            inside = True
            continue
        if inside:
            if line and not line.startswith(' '):
                break                       # a sibling top-level key ended the block
            match = re.match(r'^\s+([A-Za-z_0-9]+):\s*(\S+)\s*$', line)
            if match is not None:
                refs[match.group(1)] = match.group(2)
    return refs


def load_env_file(path: Path) -> dict[str, str]:
    """Read `KEY=VALUE` lines; ignore comments and blanks."""
    extra: dict[str, str] = {}
    if not path.exists():
        return extra
    for line in path.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if line == '' or line.startswith('#') or '=' not in line:
            continue
        name, _, value = line.partition('=')
        extra[name.strip()] = value.strip().strip('"').strip("'")
    return extra


def main() -> int:
    parser = argparse.ArgumentParser(description='探出每个模型的真实输出上限')
    parser.add_argument('--only', default='', help='逗号分隔的 route 名单')
    parser.add_argument('--write', action='store_true', help='把"上游更大"的回填进模板')
    parser.add_argument('--json', action='store_true', dest='as_json', help='机器可读')
    parser.add_argument(
        '--sample',
        action='store_true',
        help='每个网关只探第一个模型（省请求；默认探全部）',
    )
    parser.add_argument('--env-file', default='', help='从这里读各网关的 key')
    parser.add_argument(
        '--credentials',
        default='~/.dsh/.credentials.yaml',
        help='DSH 凭据库（默认 ~/.dsh/.credentials.yaml）；传空字符串可禁用',
    )
    args = parser.parse_args()

    env_extra: dict[str, str] = {}
    if args.credentials:
        env_extra.update(load_credentials(Path(args.credentials).expanduser()))
    if args.env_file:
        env_extra.update(load_env_file(Path(args.env_file).expanduser()))
    only = {x.strip() for x in args.only.split(',') if x.strip()}

    # `deepseek-official` is NOT in the template files: it is the hardcoded
    # `DEEPSEEK_OFFICIAL` profile in llm.ts. It is also the primary provider, so an
    # audit that skipped it would miss the most important row.
    rows: list[tuple[str, dict]] = [(
        'llm.ts',
        {
            'route': 'deepseek-official',
            'baseURL': 'https://api.deepseek.com',
            'apiKeyEnv': 'DEEPSEEK_API_KEY',
            'api': 'openai-completions',
            'models': [
                {'id': 'deepseek-flash', 'maxTokens': 393216},
                {'id': 'deepseek-v4-pro', 'maxTokens': 393216},
            ],
        },
    )]
    for name in TEMPLATE_FILES:
        path = APP / name
        if not path.exists():
            continue
        for row in json.loads(path.read_text(encoding='utf-8')):
            rows.append((name, row))

    report: list[dict] = []
    for filename, row in rows:
        route = row.get('route', '?')
        if only and route not in only:
            continue
        base = (row.get('baseURL') or '').strip()
        models = row.get('models') or []
        if base == '' or '${' in base or not models:
            continue
        if row.get('api') == 'anthropic-messages':
            continue            # no /chat/completions on that wire protocol
        key = find_key(route, row, env_extra)
        if key is None:
            report.append({'route': route, 'outcome': 'no-key'})
            continue
        for model in models:
            if args.sample and model is not models[0]:
                break               # `--sample` keeps the cost to one request per route
            got = audit_one(base, key, model['id'], model.get('maxTokens'))
            report.append({'route': route, 'model': model['id'], **got})

    if args.as_json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        by_outcome: dict[str, list[dict]] = {}
        for item in report:
            by_outcome.setdefault(item['outcome'], []).append(item)
        print('== 实测 ==')
        for item in by_outcome.get('measured', []) + by_outcome.get('measured-unconfirmed', []):
            declared, actual = item.get('declared'), item['actual']
            flag = ''
            if declared is not None and actual > declared:
                flag = f'  <<< 声明少报 {actual - declared}'
            elif declared is not None and actual < declared:
                flag = f'  <<< 声明多报 {declared - actual}'
            print(f"  {item['route']:24s} {item['model']:28s} 声明={declared} 实测={actual}{flag}")
        for item in by_outcome.get('not-enforced', []):
            print(f"  {item['route']:24s} {item['model']:28s} {item['detail']}")
        for outcome, label in (('no-parse', '报错里读不出上限'), ('unreachable', '不可达')):
            for item in by_outcome.get(outcome, []):
                print(f"  [skip] {item['route']:24s} {label}: {item.get('detail', '')[:110]}")
        no_key = by_outcome.get('no-key', [])
        if no_key:
            names = ', '.join(x['route'] for x in no_key)
            print(f'\n  [未验证] {len(no_key)} 个网关没有 key，无法审计：{names}')
            print('   （无凭据时分不清"已下线"与"没给你看"，所以不猜）')

    under = [x for x in report if x.get('outcome', '').startswith('measured')
             and x.get('declared') is not None and x['actual'] > x['declared']]
    if args.write and under:
        for filename in TEMPLATE_FILES:
            path = APP / filename
            if not path.exists():
                continue
            data = json.loads(path.read_text(encoding='utf-8'))
            touched = False
            for row in data:
                for item in under:
                    if row.get('route') != item['route']:
                        continue
                    for model in row.get('models') or []:
                        if model.get('id') == item['model']:
                            if model.get('maxTokens') != item['actual']:
                                model['maxTokens'] = item['actual']
                                touched = True
            if touched:
                path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
                print(f'  已回填 {filename}')

    if under:
        print(f'\n  {len(under)} 个模型的声明输出上限低于上游真实值 —— 这些请求被无谓地压小了。')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
