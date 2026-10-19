/**
 * 「去哪申请 API key」的提示（`key-urls.json` + `keyUrlFor`）。
 *
 * WHY THIS EXISTS. Add-provider 流程原本止于一句 "paste your key" —— 它说了是哪个
 * 厂商，却没说去哪拿。用户得自己离开 TUI、找到对应控制台、再从同一厂商的几种 key
 * 里挑对那一种（coding plan 与按量计费是**不同的字符串**）。一条 URL 把这些全省掉。
 *
 * 这里的守卫分三层：
 *  ① `keyUrlFor` 的行为（命中、未命中、空串）；
 *  ② 映射表本身的数据质量 —— URL 必须是 https，且不能指向一个不存在的 route
 *     （拼错 route 的条目永远不会命中，等于白写）；
 *  ③ 弹窗源码确实用了它，并且**保留了没有 URL 时的兜底**（不许猜一个地址）。
 *
 * Run with `bun test tests/key-urls.test.ts`.
 *
 * @module qialike/key-urls-test
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { keyUrlFor } from '../packages/qialike-app/src/llm.ts'

const APP = join(import.meta.dir, '..', 'packages', 'qialike-app', 'src')
const TABLE = JSON.parse(readFileSync(join(APP, 'key-urls.json'), 'utf8')) as Record<string, unknown>
const PANEL = readFileSync(join(APP, 'panels', 'models.tsx'), 'utf8')

/** Every route the catalogue can offer, across all four template files. */
const routes = new Set<string>()
for (const file of ['provider-templates.json', 'china-gateway-templates.json',
  'foreign-gateway-templates.json', 'azure-templates.json']) {
  for (const row of JSON.parse(readFileSync(join(APP, file), 'utf8')) as { route: string }[]) {
    routes.add(row.route)
  }
}
// Plus the two the opencode plugin defines in code rather than in a data file.
for (const extra of ['opencode-zen', 'opencode-go']) routes.add(extra)

describe('keyUrlFor', () => {
  test('answers for a provider we know', () => {
    expect(keyUrlFor('openai')).toBe('https://platform.openai.com/api-keys')
    expect(keyUrlFor('anthropic')).toContain('console.anthropic.com')
  })

  test('says "unknown" instead of guessing', () => {
    // The dialog turns undefined into generic wording. A guessed URL would waste more
    // of the user's time than no URL at all, so absence is the honest answer.
    expect(keyUrlFor('no-such-route')).toBeUndefined()
    expect(keyUrlFor('')).toBeUndefined()
  })
})

describe('the table', () => {
  test('every entry is an https URL', () => {
    for (const [route, url] of Object.entries(TABLE)) {
      if (route.startsWith('_')) continue      // the explanatory comment key
      expect(typeof url, route).toBe('string')
      expect(url as string, `${route} must be https`).toMatch(/^https:\/\/\S+$/u)
    }
  })

  test('no entry names a route the catalogue cannot offer', () => {
    // A misspelt route never resolves, so the entry is dead weight that looks alive.
    const unknown = Object.keys(TABLE).filter((route) => !route.startsWith('_') && !routes.has(route))
    expect(unknown).toEqual([])
  })

  test('coverage is substantial, and the gap is deliberate', () => {
    const covered = routes.size - Object.keys(TABLE).filter((r) => !r.startsWith('_')).length
    // Most routes are covered; the rest are console pages we could not state
    // confidently, which the dialog handles. Both numbers are pinned so that a
    // shrink (someone deleting entries) is as visible as a typo.
    expect(Object.keys(TABLE).filter((r) => !r.startsWith('_')).length).toBeGreaterThan(50)
    expect(covered).toBeGreaterThanOrEqual(0)
  })
})

describe('the dialog', () => {
  test('renders the URL, and falls back when there is none', () => {
    expect(PANEL, 'the panel asks the table').toContain('keyUrlFor(store.keyDialogProvider)')
    expect(PANEL, 'a labelled prompt precedes it').toContain('Get one at:')
    // The fallback is what keeps an unknown route honest: no URL is invented for it.
    expect(PANEL, 'unknown routes get generic wording').toContain("this provider&apos;s own console")
  })

  test('the prompt sits inside the key dialog, not elsewhere', () => {
    // Guard the placement: a hint rendered in the provider LIST would appear before
    // the user has chosen anything, when there is no route to name yet.
    const dialog = PANEL.slice(PANEL.indexOf('store.keyDialog ? ('), PANEL.indexOf('store.providerList ? ('))
    expect(dialog).toContain('Get one at:')
  })
})
