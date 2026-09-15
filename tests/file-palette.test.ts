/**
 * Unit tests for the `@file` palette's pure half (`packages/dsh-tui-app/src/
 * file-palette.ts`): the token grammar around the caret, the mention text, the
 * token-replacement edit and the fetch-generation guard.
 *
 * The grammar itself is the harness's `@deepseek-ai/dsh-file-reference/grammar`
 * (the module the web composer shares), so these tests pin the TUI's USE of it:
 * absolute draft offsets, the caret's logical line, and the exact insert text —
 * the three things a terminal client has to get right on its own.
 *
 * Run with `bun test tests/file-palette.test.ts`.
 *
 * @module dsh-tui/file-palette-test
 */

import { describe, expect, test } from 'bun:test'
import {
  activeFileToken, applyFileMention, FileQuery, fileMentionText, fileRowLabel,
} from '../packages/dsh-tui-app/src/file-palette.ts'

describe('activeFileToken: where the @ token is, in draft coordinates', () => {
  test('a plain token at the caret', () => {
    expect(activeFileToken('read @sr', 8)).toEqual({ prefix: '@sr', query: 'sr', quoted: false, start: 5 })
    // …and one that starts the draft.
    expect(activeFileToken('@packages/dsh', 13)).toEqual({ prefix: '@packages/dsh', query: 'packages/dsh', quoted: false, start: 0 })
  })

  test('a bare `@` opens the palette with an empty query', () => {
    expect(activeFileToken('look at @', 9)).toEqual({ prefix: '@', query: '', quoted: false, start: 8 })
  })

  test('a quoted token keeps the open quote and allows spaces', () => {
    expect(activeFileToken('see @"my dir/a', 14)).toEqual({ prefix: '@"my dir/a', query: 'my dir/a', quoted: true, start: 4 })
  })

  test('an @ inside a word (an email) never triggers', () => {
    expect(activeFileToken('mail me at a@b', 14)).toBeUndefined()
    expect(activeFileToken('user@host', 9)).toBeUndefined()
  })

  test('the token is bounded by whitespace, and undefined when the caret left it', () => {
    // Caret BEFORE the @: not inside the token.
    expect(activeFileToken('read @sr', 4)).toBeUndefined()
    // Caret after a space that closed the token.
    expect(activeFileToken('read @sr and more', 17)).toBeUndefined()
  })

  test('only the CARET\'s logical line counts in a multi-line draft', () => {
    const draft = 'first line\n@src/a\nthird'
    // Caret at the end of the @ line.
    expect(activeFileToken(draft, draft.indexOf('\n@src/a') + 7)).toEqual({ prefix: '@src/a', query: 'src/a', quoted: false, start: 11 })
    // A caret on the NEXT line is not in the token, even though the text is above it.
    expect(activeFileToken(draft, draft.length)).toBeUndefined()
    // An `@` on the first line while the caret is there.
    expect(activeFileToken('@a\nb', 2)).toEqual({ prefix: '@a', query: 'a', quoted: false, start: 0 })
  })
})

describe('mention text and row labels', () => {
  test('plain paths, directories, and paths with spaces', () => {
    expect(fileMentionText({ path: 'src/a.ts', kind: 'file' }, false)).toBe('@src/a.ts')
    expect(fileMentionText({ path: 'src', kind: 'directory' }, false)).toBe('@src/')
    expect(fileMentionText({ path: 'my dir/a.ts', kind: 'file' }, false)).toBe('@"my dir/a.ts"')
    // A quoted DIRECTORY keeps the quote open so a drill can descend.
    expect(fileMentionText({ path: 'my dir', kind: 'directory' }, true)).toBe('@"my dir/')
    expect(fileRowLabel({ path: 'src', kind: 'directory' })).toBe('src/')
    expect(fileRowLabel({ path: 'src/a.ts', kind: 'file' })).toBe('src/a.ts')
  })
})

describe('applyFileMention: replace exactly the token', () => {
  test('settling a file inserts the mention plus one space, caret after it', () => {
    const token = activeFileToken('read @sr and', 8)!
    // The separator already there is KEPT (no double space): `@sr` in
    // `read @sr and` becomes `read @src/a.ts and`.
    expect(applyFileMention('read @sr and', token, '@src/a.ts', true))
      .toEqual({ input: 'read @src/a.ts and', cursor: 14 })
    // At the end of the draft the mention brings its own separator.
    const tail = activeFileToken('read @sr', 8)!
    expect(applyFileMention('read @sr', tail, '@src/a.ts', true))
      .toEqual({ input: 'read @src/a.ts ', cursor: 15 })
  })

  test('the tail after the token is preserved (caret parked mid-draft)', () => {
    const input = 'x @s y z'
    const token = activeFileToken(input, 4)!
    expect(applyFileMention(input, token, '@src/a.ts', true))
      .toEqual({ input: 'x @src/a.ts y z', cursor: 11 })
  })

  test('drilling a directory inserts no space (the next query continues from it)', () => {
    const token = activeFileToken('@my', 3)!
    expect(applyFileMention('@my', token, '@"my dir/', false))
      .toEqual({ input: '@"my dir/', cursor: 9 })
  })

  test('a quoted token is replaced whole, quote included', () => {
    const input = 'see @"my d tail'
    const token = activeFileToken(input, 10)!
    expect(token.prefix).toBe('@"my d')
    expect(token.query).toBe('my d')
    expect(applyFileMention(input, token, '@"my dir/a.ts"', true))
      .toEqual({ input: 'see @"my dir/a.ts" tail', cursor: 18 })
  })
})

describe('FileQuery: only the newest query may publish', () => {
  test('a stale generation is rejected', () => {
    const q = new FileQuery()
    const first = q.begin()
    expect(q.isCurrent(first)).toBe(true)
    const second = q.begin()
    expect(q.isCurrent(first)).toBe(false)
    expect(q.isCurrent(second)).toBe(true)
  })

  test('cancel (palette closed) invalidates whatever is in flight', () => {
    const q = new FileQuery()
    const gen = q.begin()
    q.cancel()
    expect(q.isCurrent(gen)).toBe(false)
  })
})
