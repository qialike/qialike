/**
 * CPR glyph-width calibration.
 *
 * A glyph's rendered width depends on the terminal's text font AND its
 * color-emoji fallback — per font, not per any Unicode table. ⚠ (EAW=N) can be
 * drawn two columns wide by one terminal while ✓ ✗ ☑ ⚙ right next to it stay
 * narrow. No static guess list is ever correct everywhere, so this module
 * MEASURES each ambiguous glyph on the real terminal via Cursor Position Report
 * (`ESC[6n` → `ESC[<row>;<col>R`) and publishes the results in
 * `globalThis.__dshCharWidths`. The patched string-width module (see
 * apps/tui-bin/build.mjs `patchStringWidthEmojiBlocks`) reads that map, so Ink's
 * layout measure, its grid placement, clip logic and the app's own row-height
 * estimates all agree with the actual rendering — the sidebar divider cannot
 * drift on any terminal.
 *
 * Pipeline:
 *  - The patched frame writer calls `globalThis.__dshCharScan(changedLines)`
 *    after every flush; this module collects the "ambiguous" code points the
 *    user can actually see.
 *  - While idle (agent paused, no frame churn), batches of probes run: frames
 *    are frozen via `__dshCalibrationLock`/`__dshCalibrationFlush` while the
 *    bottom row is used for one `ESC[6n` round trip per glyph.
 *  - Measured widths are persisted (fingerprinted by a few sentinel glyphs) so
 *    later runs reuse them when the terminal/font has not changed.
 *
 * @module @yourname/qialike-app/charwidth
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { logErrorFileOnly } from './log.ts'
import { legacyAwarePath } from './legacy-names.ts'

/** Code-point ranges worth measuring: everything the font may render either
 *  narrow or wide depending on coverage/emoji fallback. EAW-W/F glyphs and
 *  astral emoji (always two columns in practice — except the EAW-N members of
 *  PAINT_WIDE_ASTRAL below, which VTE advances only one column) are
 *  intentionally excluded. */
const PROBE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x2000, 0x20cf], // general punctuation/currency zone (‼ ⁉ …)
  [0x2100, 0x2bff], // letterlike → arrows → math → shapes → misc symbols/dingbats → supplemental arrows
]

/** Astral members of the build-time PAINT_WIDE set (apps/tui-bin/build.mjs):
 *  color-emoji glyphs whose CURSOR advance on VTE is only ONE column although
 *  the terminal PAINTS them two cells wide (🏷 U+1F3F7 and 🛠 U+1F6E0 are both
 *  EAW=N). Astral emoji are normally skipped from probing ("always two
 *  columns"), but these MUST be measured: the Ink pad decision keys off the
 *  measured advance (1 → reserve a real-space second cell; 2 → leave
 *  untouched), so the divider stays aligned even on terminals that advance
 *  them the full two columns. Keep in sync with build.mjs `PAINT_WIDE`. */
const PAINT_WIDE_ASTRAL = new Set<number>([0x1f3f7, 0x1f6e0])

export function isProbeCandidate(cp: number): boolean {
  if (cp < 0x2000 || cp > 0x2bff) return false
  for (const [lo, hi] of PROBE_RANGES) {
    if (cp >= lo && cp <= hi) return true
  }
  return false
}

const SENTINELS = [0x26a0, 0x2713, 0x2660] // ⚠ ✓ ♠ — font coverage changes these

interface CharWidthHooks {
  /** True while the agent is running / paused / a question is pending — probing
   *  is deferred to idle windows. */
  isBusy(): boolean
  /** Called once measured widths changed: bump the layout so rows re-render
   *  with the calibrated columns. */
  onWidthsChanged(): void
}

interface CharWidthGlobals {
  __dshCharWidths?: Map<number, number>
  __dshCalibrationLock?: boolean
  __dshCalibrationFlush?: () => void
  __dshCharScan?: (lines: string[]) => void
}

const GLOBAL = globalThis as typeof globalThis & CharWidthGlobals

let hooks: CharWidthHooks | null = null
let supported = false
let probing = false
const pending = new Set<number>()
const failed = new Set<number>() // measured once and timed out — do not retry this run
let scanRegistered = false
let scheduleTimer: ReturnType<typeof setTimeout> | undefined
let pollTimer: ReturnType<typeof setInterval> | undefined

function cacheFile(): string {
  const dir = process.env.DSH_HOME || join(homedir(), '.dsh')
  return legacyAwarePath(dir, 'qialike-charwidth.json')
}

function ensureMap(): Map<number, number> {
  if (!GLOBAL.__dshCharWidths) GLOBAL.__dshCharWidths = new Map<number, number>()
  return GLOBAL.__dshCharWidths
}

/** Keep the frame writer buffered (and flush once done) around probe batches so
 *  a mid-measurement repaint can never overwrite the probe row. */
async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  if (typeof GLOBAL.__dshCalibrationFlush !== 'function') return fn()
  GLOBAL.__dshCalibrationLock = true
  try {
    return await fn()
  } finally {
    GLOBAL.__dshCalibrationLock = false
    try { GLOBAL.__dshCalibrationFlush() } catch { /* ignore */ }
  }
}

/** The app's own cursor state — park + show/hide — when the TUI installed its
 *  frame suffix (the conversation panel does). Falls back to "show". */
function appCursorState(): string {
  try {
    const hook = (globalThis as { __dshTuiFrameSuffix?: () => string }).__dshTuiFrameSuffix
    return typeof hook === 'function' ? hook() : '\x1b[?25h'
  } catch {
    return '\x1b[?25h'
  }
}

/** Measure one code point: print it on the bottom row and ask where the cursor
 *  landed. Returns the width in cells, or null on timeout (terminal without
 *  CPR support). Caller keeps frames frozen while a batch runs. Exported for
 *  the CPR responder test.
 *
 *  The HARDWARE CURSOR is hidden for the round trip and the app's own state is
 *  restored right after it. Moving a VISIBLE cursor to the last row left it
 *  blinking on the status bar while a batch ran — reported on WSL and Ubuntu
 *  24.04 when typing `/`, because the command palette introduces eight new
 *  ambiguous glyphs (`╭ ─ ╮ │ — … ╰ ╯`, the box and the hints' em dash/ellipsis)
 *  and that batch ran while the composer caret was shown. Restoring through the
 *  frame suffix also puts the caret back at the composer immediately instead of
 *  waiting for the next repaint. */
export function measureOne(cp: number, timeoutMs = 300): Promise<number | null> {
  return new Promise((resolve) => {
    const glyph = String.fromCodePoint(cp)
    const rows = process.stdout.rows ?? 24
    let buf = ''
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      process.stdin.off('data', onData)
      // Restore the cursor only: the probe glyph is concealed (SGR 8) and this
      // cell is about to be repainted by the first frame, so there is nothing to
      // erase. The old `2K` here wiped a whole line — on the normal screen (when
      // the alternate one has not been entered yet) that ate a row of the user's
      // shell output.
      try { process.stdout.write(`\x1b8${appCursorState()}`) } catch { /* ignore */ }
    }
    const onData = (chunk: Buffer | string): void => {
      buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      const m = /\x1b\[([0-9]+);([0-9]+)R/.exec(buf)
      if (m) {
        finish()
        resolve(Math.max(0, Number(m[2]) - 1))
      }
    }
    const timer = setTimeout(() => { finish(); resolve(null) }, timeoutMs)
    process.stdin.on('data', onData)
    try {
      // Save cursor → bottom row col 1 → print the glyph CONCEALED (SGR 8 hides
      // it while the cursor still advances, which is all the round trip needs) →
      // query position. Without the concealment a `⚠` sat on screen for the whole
      // timeout (~200 ms on a terminal that does not answer CPR) and read as a
      // flash before the hero.
      // …and blank the probe cell IMMEDIATELY after the query: the CPR reply is
      // queued when the terminal parses `6n` (before it sees these bytes), so the
      // measurement is unaffected while nothing is left on screen — no reliance on
      // the terminal honouring SGR 8 concealment, and no glyph anywhere. Two
      // spaces cover a 1- or 2-cell advance; the saved cursor is restored in
      // `finish()`.
      process.stdout.write(`\x1b[?25l\x1b7\x1b[${rows};1H\x1b[8m${glyph}\x1b[28m\x1b[6n\x1b[${rows};1H  `)
    } catch {
      finish()
      resolve(null)
    }
  })
}

function persist(): void {
  if (!supported) return
  const map = GLOBAL.__dshCharWidths
  if (!map) return
  const widths: Record<string, number> = {}
  for (const [cp, w] of map) widths[cp.toString(16)] = w
  const payload = { version: 1, sentinels: SENTINELS.map((cp) => map.get(cp)), widths }
  try {
    const file = cacheFile()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(payload))
  } catch { /* cache is best-effort */ }
}

async function runBatch(): Promise<void> {
  if (probing) return
  if (!supported) return
  const h = hooks
  if (!h || h.isBusy()) return
  const todo = [...pending].filter((cp) => !failed.has(cp) && !ensureMap().has(cp))
  if (todo.length === 0) { pending.clear(); return }
  probing = true
  const map = ensureMap()
  let changed = false
  try {
    await withLock(async () => {
      const batch = todo.slice(0, 24)
      for (const cp of batch) {
        // Bail out if the user starts a run mid-batch; the rest stays pending.
        if (h.isBusy()) break
        const w = await measureOne(cp)
        if (w === null) { failed.add(cp); continue }
        if (map.get(cp) !== w) { map.set(cp, w); changed = true }
      }
    })
    if (changed) persist()
    if (changed) {
      try { h.onWidthsChanged() } catch { /* never take the app down */ }
    }
    for (const cp of todo) pending.delete(cp)
  } finally {
    probing = false
  }
}

function kick(): void {
  if (!supported || probing) return
  if (scheduleTimer !== undefined) clearTimeout(scheduleTimer)
  scheduleTimer = setTimeout(() => { void runBatch() }, 60)
}

function scan(lines: readonly string[]): void {
  if (!supported) return
  const map = ensureMap()
  for (const line of lines) {
    for (const ch of line) {
      const cp = ch.codePointAt(0)
      if (cp === undefined) continue
      if (failed.has(cp) || map.has(cp)) continue
      if (cp > 0xffff) {
        // Astral emoji normally render two columns, but the EAW-N members of
        // PAINT_WIDE_ASTRAL advance only ONE column on color-emoji terminals
        // while painting two — measure them so the pad decision stays exact.
        if (PAINT_WIDE_ASTRAL.has(cp)) pending.add(cp)
        continue
      }
      if (!isProbeCandidate(cp)) continue
      pending.add(cp)
    }
  }
  if (pending.size > 0) kick()
}

/** Probe sentinels once; equal widths mean the terminal/font did not change, so
 *  the persisted cache can be trusted. Also seeds the sentinel widths. Returns
 *  false when the terminal does not answer CPR — calibration is disabled and
 *  pure EAW semantics stay in effect (no repeated 300 ms timeouts). */
async function fingerprint(): Promise<boolean> {
  // Measure into a LOCAL map and publish it only once the sentinels are in.
  // `ensureMap()` used to publish an EMPTY `__dshCharWidths` before the first
  // probe returned, and the Ink placement patch reads that map directly: with a
  // present-but-empty map an absent code point looked like "the terminal already
  // advances two columns", so every paint-wide glyph lost its reserved second
  // cell — and the first screen is painted inside that window (see
  // `patchInkWideChar` in apps/tui-bin/build.mjs).
  const measured = new Map<number, number>()
  const current: Array<number | null> = []
  const ok = await withLock(async () => {
    for (const cp of SENTINELS) {
      const w = await measureOne(cp, 200)
      if (w === null && current.length === 0) return false // no CPR support: stop probing
      current.push(w)
      if (w !== null) measured.set(cp, w)
    }
    return true
  })
  if (!ok) return false
  // The terminal answers CPR: calibration is live from here on. `persist()`
  // and `scan()` are both gated on `supported`, so this has to happen before
  // them (the flag stays false while the probe runs — see
  // `initCharWidthCalibration`).
  supported = true
  const map = ensureMap()
  for (const [cp, w] of measured) map.set(cp, w)
  const file = cacheFile()
  if (existsSync(file)) {
    try {
      const cached = JSON.parse(readFileSync(file, 'utf8')) as { sentinels?: Array<number | null>; widths?: Record<string, number> }
      const same = Array.isArray(cached.sentinels)
        && cached.sentinels.length === current.length
        && cached.sentinels.every((w, i) => w === current[i])
      if (same && cached.widths) {
        for (const [hex, w] of Object.entries(cached.widths)) map.set(Number.parseInt(hex, 16), w)
      }
    } catch { /* corrupted cache: ignore, recalibrate lazily */ }
  }
  persist()
  return true
}

/** Register the writer hook and start the poller. Called once from the TUI boot
 *  path after raw mode is enabled. */
export function initCharWidthCalibration(opts: CharWidthHooks): void {
  if (!process.stdout.isTTY || !process.stdin.isTTY || process.env.QIALIKE_NO_CALIBRATION === '1') {
    // Headless / piped runs keep pure EAW semantics (nothing to measure).
    return
  }
  // Require a real terminal profile: a bare pty (captures, pipes) has no
  // emulator to answer ESC[6n, so calibration there would only burn timeouts.
  const term = process.env.TERM ?? ''
  if (term === '' || term === 'dumb') return
  hooks = opts
  // NOTHING is enabled before the terminal proves it answers CPR.
  //
  // The frame writer calls `__dshCharScan` for a frame the moment the hook
  // exists, and `scan()` walks EVERY CHARACTER of EVERY line of that frame
  // (`codePointAt` + three Set/Map lookups per code point — the giant session's
  // first frame is 5103 rows × 133 cols ≈ 680k of them). On a terminal that
  // never answers `ESC[6n` that work provably cannot pay off, and it used to run
  // BEFORE the probe could disable it: measured in GNOME Terminal/VTE, the main
  // loop was blocked for 1470 ms right after the first frame appeared
  // (`[frame] slow gap=1470ms … activity=idle`, session/optimization-plan.md §8.7).
  // Registering the hook only after a successful fingerprint makes an
  // unsupported terminal skip the scan entirely; a supported one loses at most
  // the frames that were written during the probe (all of them get rescanned on
  // the next write, and every later frame is measured as before).
  void (async () => {
    let ok = false
    try { ok = await fingerprint() } catch { /* keep pure EAW on any probe failure */ }
    if (!ok) {
      // `supported` was never raised, so no scan ran and `persist()` never wrote
      // a half-measured cache. FILE ONLY: stderr is the tty the alternate screen
      // lives on, so this diagnostic used to be printed over the first frame and
      // then wiped by it — a flash of raw text on every start of a terminal that
      // does not answer CPR. It is a diagnostic for the log, not a message for
      // the user.
      logErrorFileOnly('charwidth', 'terminal does not answer CPR — keeping East-Asian-width semantics')
      return
    }
    if (!scanRegistered) {
      scanRegistered = true
      GLOBAL.__dshCharScan = (lines) => { scan(lines) }
    }
    kick()
    pollTimer = setInterval(() => { if (pending.size > 0) kick() }, 1500)
    pollTimer.unref?.()
  })()
}
