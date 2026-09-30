/**
 * What the launcher reports about releases, and the hints the TUI shows for it.
 *
 * Three jobs, all pure so they are testable without a terminal:
 *
 *  1. read the ONE JSON line `qialike upgrade --check --json` / `--auto --json`
 *     prints (`apps/tui-bin/src/upgrade-command.ts`). The kernel and the launcher's
 *     startup relay both branch on it, and parsing the human text instead would be a
 *     contract nobody wrote down.
 *  2. compose the STATUS-LINE hint a Windows copy gets: this platform cannot install
 *     a release by itself, so the user has to fetch it, and the place they will
 *     actually look is the line already on screen — the hero's row under the card,
 *     or the docked status bar. No dialog: a takeover would interrupt whatever they
 *     were typing, and this is news, not a question.
 *  3. compose the transcript lines that carry the two download URLs, so the hint can
 *     stay short and the links are still there to copy.
 *
 * Windows-only by construction: every caller gates on `process.platform`, so
 * Linux/macOS keep the update flow they already had (silent patch installs, and the
 * `run 'qialike upgrade'` notice for the rest).
 *
 * @module @qialike/qialike-app/update-hint
 */

/**
 * What the launcher decided, and what a caller may do about it.
 *
 * One shape for both entry points: `--check --json` reports what the newest release
 * is (`decision: 'check'`), and `--auto --json` reports what the update POLICY
 * decided — including the outcomes that are not about a newer release at all
 * (`skip`, `unknown`).
 */
export interface UpdateReport {
  decision: 'check' | 'skip' | 'up-to-date' | 'unknown' | 'notify' | 'install'
  /** The version this binary reports. */
  installed: string
  /** The newest published release, or null when no source could be reached. */
  newest: string | null
  /** How `newest` relates to `installed`; null when there is nothing to compare. */
  relation: 'up-to-date' | 'older' | 'patch' | 'minor' | 'major' | null
  /** Whether `qialike upgrade` may replace this copy itself. */
  canSelfInstall: boolean
  /** One download URL per release source — primary first, mirror second. */
  downloads: readonly string[]
  /** Why a `skip` happened (`disabled` / `dev-build` / `unmanaged-install`). */
  reason?: string
  /** Whether an `install` landed (the launcher already did it). */
  ok?: boolean
}

/** A release a person has to fetch by hand. */
export interface UpdateOffer {
  installed: string
  version: string
  urls: readonly string[]
}

const RELATIONS = ['up-to-date', 'older', 'patch', 'minor', 'major'] as const
const DECISIONS = ['check', 'skip', 'up-to-date', 'unknown', 'notify', 'install'] as const

/**
 * Read the launcher's JSON report out of a captured stdout.
 *
 * The LAST non-empty line is taken, not the first: `--auto --json` prints the human
 * notice FIRST and the report last (the notice is what a person reads; the report is
 * what a caller branches on), and callers merge the child's stdout and stderr into
 * one buffer. Anything that does not validate reads as undefined — a caller then says
 * "could not check" rather than acting on a half-parsed answer.
 */
export function parseUpdateReport(stdout: string): UpdateReport | undefined {
  const lines = stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  if (lines.length === 0) return undefined

  let raw: unknown
  try {
    raw = JSON.parse(lines[lines.length - 1] as string)
  } catch {
    return undefined
  }
  if (raw === null || typeof raw !== 'object') return undefined

  const node = raw as Record<string, unknown>
  const decision = node.decision
  const installed = node.installed
  const newest = node.newest
  const relation = node.relation
  const canSelfInstall = node.canSelfInstall
  const downloads = node.downloads
  const reason = node.reason
  const ok = node.ok

  if (!DECISIONS.includes(decision as (typeof DECISIONS)[number])) return undefined
  if (typeof installed !== 'string') return undefined
  if (newest !== null && typeof newest !== 'string') return undefined
  if (relation !== null && !RELATIONS.includes(relation as (typeof RELATIONS)[number])) return undefined
  if (typeof canSelfInstall !== 'boolean') return undefined
  if (!Array.isArray(downloads) || downloads.some((url) => typeof url !== 'string')) return undefined
  if (reason !== undefined && typeof reason !== 'string') return undefined
  if (ok !== undefined && typeof ok !== 'boolean') return undefined

  return {
    decision: decision as UpdateReport['decision'],
    installed,
    newest: newest as string | null,
    relation: relation as UpdateReport['relation'],
    canSelfInstall,
    downloads: downloads as string[],
    ...(reason === undefined ? {} : { reason }),
    ...(ok === undefined ? {} : { ok }),
  }
}

/**
 * Whether there is a release the user should be told about.
 *
 * The launcher has already done the version arithmetic and refuses to call a lagging
 * mirror's older tag an update (`relation === 'older'`), so this reads its verdict
 * rather than comparing anything here.
 */
export function isNewerAvailable(report: UpdateReport): boolean {
  return report.newest !== null && (report.relation === 'patch' || report.relation === 'minor' || report.relation === 'major')
}

/**
 * The one-line hint shown while a newer release is waiting.
 *
 * Kept short on purpose: it is painted in the hero's row under the card and at the RIGHT
 * of the docked status bar, both of which truncate, so the LEADING part has to be the
 * fact ("a newer release exists") and the tail the way to act on it. The installed
 * version is deliberately not named — the user asked for this wording, and the line has
 * to survive a narrow terminal — and the URLs are NOT here: two 85-character links
 * cannot fit a status line, so `/upgrade` puts them in the transcript instead (see
 * {@link updateNoticeLines}).
 */
export function updateHintText(offer: UpdateOffer): string {
  return `Update available: ${offer.version} - /upgrade for links`
}

/**
 * The transcript lines that carry the download URLs.
 *
 * One line per source, so each URL is a whole line a terminal or a mouse selection
 * can copy without dragging neighbouring text along. The wording matches the CLI's
 * `--auto` notice on purpose: it is the same sentence a person sees in either place.
 */
export function updateNoticeLines(offer: UpdateOffer): string[] {
  return [
    `qialike ${offer.version} is available (you have ${offer.installed}) — download it and replace the file by hand:`,
    ...offer.urls,
  ]
}
