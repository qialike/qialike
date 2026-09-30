/**
 * Unit tests for `update-hint.ts` — the launcher's report, and the two lines the TUI
 * shows for it.
 *
 * Two contracts are pinned here, neither of which needs a terminal:
 *
 *  - the JSON line `qialike upgrade --check --json` / `--auto --json` prints. The
 *    kernel's `/upgrade` path and the launcher's startup relay both branch on it, so a
 *    malformed answer must read as "no answer" rather than as a half-filled hint;
 *  - the hint text itself, which is painted in the hero's row under the card AND in
 *    the docked status bar. Both truncate, so the LEADING part has to be the fact and
 *    the URLs must NOT be in it (they go to the transcript, one per line, where a
 *    mouse selection can copy them whole).
 *
 * Run with `bun test tests/update-hint.test.ts`.
 *
 * @module qialike/update-hint-test
 */

import { describe, expect, test } from 'bun:test'
import {
  isNewerAvailable,
  parseUpdateReport,
  updateHintText,
  updateNoticeLines,
  type UpdateReport,
} from '../packages/qialike-app/src/update-hint.ts'

const GITHUB = 'https://github.com/qialike/qialike/releases/download/0.6.3/qialike-windows-x64.zip'
const GITCODE = 'https://gitcode.com/qialike/qialike/releases/download/0.6.3/qialike-windows-x64.zip'

/** What the launcher prints for a Windows copy with a newer release out. */
const REPORT: UpdateReport = {
  decision: 'check',
  installed: '0.6.2',
  newest: '0.6.3',
  relation: 'patch',
  canSelfInstall: false,
  downloads: [GITHUB, GITCODE],
}

function line(report: UpdateReport): string {
  return JSON.stringify(report)
}

describe('reading the launcher report', () => {
  test('the documented line round-trips', () => {
    expect(parseUpdateReport(line(REPORT))).toEqual(REPORT)
  })

  test('the LAST line wins, so the human notice ahead of it does not break it', () => {
    // `--auto --json` prints the notice for a person FIRST and the report last, and
    // callers merge the child's stdout and stderr into one buffer.
    const notice = `qialike 0.6.3 is available (you have 0.6.2) — download it and replace the file by hand:\n${GITHUB}`
    expect(parseUpdateReport(`${notice}\n${line({ ...REPORT, decision: 'notify' })}\n`))
      .toEqual({ ...REPORT, decision: 'notify' })
  })

  test('the policy decisions travel as decisions, not as prose', () => {
    // The startup relay branches on these: on Windows only `notify` becomes the hint;
    // everything else keeps the child's own notice (or says nothing at all).
    for (const decision of ['skip', 'up-to-date', 'unknown', 'notify', 'install', 'check'] as const) {
      expect(parseUpdateReport(line({ ...REPORT, decision }))?.decision).toBe(decision)
    }
    // `skip` carries why, and `install` carries whether it landed.
    expect(parseUpdateReport('{"decision":"skip","installed":"a","newest":null,"relation":null,"canSelfInstall":false,"downloads":[],"reason":"dev-build"}')?.reason)
      .toBe('dev-build')
    expect(parseUpdateReport('{"decision":"install","installed":"a","newest":"b","relation":"patch","canSelfInstall":true,"downloads":[],"ok":true}')?.ok)
      .toBe(true)
  })

  test('a failed check is an answer, not a parse failure', () => {
    // "I could not check" and "you are up to date" are different things to show a
    // user, so the launcher reports the failure with nulls rather than staying silent
    // and leaving the caller to guess from the exit code.
    const failed = parseUpdateReport(line({
      decision: 'unknown',
      installed: '0.6.2',
      newest: null,
      relation: null,
      canSelfInstall: false,
      downloads: ['https://github.com/qialike/qialike/releases', 'https://gitcode.com/qialike/qialike/releases'],
    }))
    expect(failed?.newest).toBeNull()
    expect(isNewerAvailable(failed as UpdateReport)).toBe(false)
  })

  test('anything malformed reads as undefined rather than a half-filled answer', () => {
    expect(parseUpdateReport('')).toBeUndefined()
    expect(parseUpdateReport('qialike: could not determine the newest version')).toBeUndefined()
    expect(parseUpdateReport('{')).toBeUndefined()
    expect(parseUpdateReport('null')).toBeUndefined()
    expect(parseUpdateReport('{"installed":"0.6.2"}')).toBeUndefined()
    // A decision or relation outside the vocabulary is a contract break, not a guess.
    expect(parseUpdateReport('{"decision":"maybe","installed":"a","newest":"b","relation":"patch","canSelfInstall":false,"downloads":[]}')).toBeUndefined()
    expect(parseUpdateReport('{"decision":"check","installed":"a","newest":"b","relation":"newer","canSelfInstall":false,"downloads":[]}')).toBeUndefined()
    // `downloads` must be all strings.
    expect(parseUpdateReport('{"decision":"check","installed":"a","newest":"b","relation":"patch","canSelfInstall":false,"downloads":[1]}')).toBeUndefined()
  })

  test('only a newer release counts as news', () => {
    expect(isNewerAvailable({ ...REPORT, relation: 'patch' })).toBe(true)
    expect(isNewerAvailable({ ...REPORT, relation: 'minor' })).toBe(true)
    expect(isNewerAvailable({ ...REPORT, relation: 'major' })).toBe(true)
    // `older` is the lagging-mirror case the launcher refuses to call an update.
    expect(isNewerAvailable({ ...REPORT, relation: 'older' })).toBe(false)
    expect(isNewerAvailable({ ...REPORT, relation: 'up-to-date' })).toBe(false)
    expect(isNewerAvailable({ ...REPORT, newest: null, relation: null })).toBe(false)
  })
})

describe('what the user is shown', () => {
  test('the hint leads with the fact and names the way to get the links', () => {
    const hint = updateHintText({ installed: '0.6.2', version: '0.6.3', urls: [GITHUB, GITCODE] })
    expect(hint).toBe('Update available: 0.6.3 - /upgrade for links')
    // A status line is one row in a bordered bar: the two 85-character URLs cannot be
    // in it, or the fact itself would be the part that gets truncated away.
    expect(hint.length).toBeLessThan(90)
    expect(hint).not.toContain('http')
  })

  test('the transcript lines carry ONE url per line, after the sentence', () => {
    const lines = updateNoticeLines({ installed: '0.6.2', version: '0.6.3', urls: [GITHUB, GITCODE] })
    expect(lines).toEqual([
      'qialike 0.6.3 is available (you have 0.6.2) — download it and replace the file by hand:',
      GITHUB,
      GITCODE,
    ])
    // Whole lines, so selecting or copying one never drags a neighbour in.
    for (const url of lines.slice(1)) expect(url).toMatch(/^https:\/\//)
  })

  test('a single configured source yields one line, and no source yields none', () => {
    expect(updateNoticeLines({ installed: '0.6.2', version: '0.6.3', urls: [GITHUB] }).slice(1)).toEqual([GITHUB])
    expect(updateNoticeLines({ installed: '0.6.2', version: '0.6.3', urls: [] })).toHaveLength(1)
  })
})
