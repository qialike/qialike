/**
 * Bottom-bar session stats for the conversation view — a dsh-tui port of the
 * dsh web StatsLine subset: steps/turns and provider-reported input/output
 * tokens. (LLM & tool wall times are folded for debugging/telemetry but not
 * shown in the bar — see {@link formatSessionStats}.)
 *
 * Tokens come from the harness-normalized `usage` carried on each
 * `assistant/message` session event (adapters fill `TokenUsage` regardless of
 * provider — DeepSeek, OpenCode Zen, custom gateways all report through the
 * same seam; a provider that omits usage simply contributes zero, and the
 * tokens group disappears). Steps/turns/tokens AND wall times are foldable
 * from the durable session log: every logged event carries a wall-clock
 * `time`, so `step/start → assistant/message` yields the LLM time and
 * `tool/call → tool/result` the tool time — restarts and `/sessions` resumes
 * show the same figures as the live listener.
 *
 * @module @yourname/dsh-tui-app/session-stats
 */

/** Whole-session activity/usage figures for the bottom bar. */
export interface SessionStats {
  /** Distinct assistant turns seen (live) / counted (replay). */
  turns: number
  /** Assistant steps (one per `assistant/message`). */
  steps: number
  /** Summed LLM wall time (step/start → assistant/message), live only. */
  llmMs: number
  /** Summed tool wall time (tool/call → tool/result), live only. */
  toolMs: number
  /** Summed provider-reported prompt tokens (includes cache, when reported). */
  inputTokens: number
  /** Summed provider-reported completion tokens. */
  outputTokens: number
}

/** A session event as the fold needs it (structural: no harness import). */
export interface SessionStatsEventLike {
  type: string
  data: unknown
  /** Wall-clock millisecond time every logged event carries (Date.now()). */
  time?: number
}

/** Zero stats (fresh session). */
export function emptySessionStats(): SessionStats {
  return { turns: 0, steps: 0, llmMs: 0, toolMs: 0, inputTokens: 0, outputTokens: 0 }
}

/**
 * Fold the durable session log into cumulative stats. Every logged event
 * carries a wall-clock `time`, so LLM (step/start → assistant/message) and
 * tool (tool/call → tool/result, FIFO per turn:step) wall times are recovered
 * too — a resumed session shows the same figures as the live listener.
 * @param events - the session's logged events (a resumed session's history).
 * @returns cumulative stats.
 */
export function foldSessionStats(events: readonly SessionStatsEventLike[]): SessionStats {
  const folding = createSessionStatsFolding()
  for (const event of events) folding.observe(event)
  return folding.snapshot()
}

/**
 * Incremental session-stats folding. The resume path folds the transcript rows
 * AND the stats from the same event log; folding the stats through this
 * accumulator lets that single pass also produce the stats, instead of a
 * second `foldSessionStats` walk over the whole log.
 * @returns an accumulator: feed each logged event to {@link observe}, then read
 * the cumulative result with {@link snapshot}.
 */
export interface SessionStatsFolding {
  /** Fold one logged event into the running totals (no-op for unrelated types). */
  observe(event: SessionStatsEventLike): void
  /** The cumulative stats after every event observed so far. */
  snapshot(): SessionStats
}

/** {@link createSessionStatsFolding} — see {@link SessionStatsFolding}. */
export function createSessionStatsFolding(): SessionStatsFolding {
  const turns = new Set<number>()
  let steps = 0
  let llmMs = 0
  let toolMs = 0
  let inputTokens = 0
  let outputTokens = 0
  const stepStart = new Map<string, number>()
  const toolCalls = new Map<string, number[]>()
  return {
    observe(event) {
      const at = event.time
      switch (event.type) {
        case 'step/start': {
          const data = event.data as { turn?: number; step?: number }
          if (typeof at === 'number' && typeof data.turn === 'number' && typeof data.step === 'number') {
            stepStart.set(`${data.turn}:${data.step}`, at)
          }
          break
        }
        case 'tool/call': {
          const data = event.data as { turn?: number; step?: number }
          if (typeof at === 'number' && typeof data.turn === 'number' && typeof data.step === 'number') {
            const key = `${data.turn}:${data.step}`
            const queue = toolCalls.get(key) ?? []
            queue.push(at)
            toolCalls.set(key, queue)
          }
          break
        }
        case 'tool/result': {
          const data = event.data as { turn?: number; step?: number }
          const key = `${data.turn}:${data.step}`
          const started = toolCalls.get(key)?.shift()
          if (typeof at === 'number' && started !== undefined) toolMs += Math.max(0, at - started)
          break
        }
        case 'assistant/message': {
          const data = event.data as { turn?: number; step?: number; usage?: { inputTokens?: number; outputTokens?: number } }
          if (typeof data.turn === 'number') turns.add(data.turn)
          steps += 1
          const started = stepStart.get(`${data.turn}:${data.step}`)
          if (typeof at === 'number' && started !== undefined) llmMs += Math.max(0, at - started)
          if (data.usage !== undefined) {
            inputTokens += data.usage.inputTokens ?? 0
            outputTokens += data.usage.outputTokens ?? 0
          }
          break
        }
        default:
      }
    },
    snapshot() {
      return { turns: turns.size, steps, llmMs, toolMs, inputTokens, outputTokens }
    },
  }
}

/** Compact wall-clock text: `0.6s` under a minute, `2m42s` above. */
export function formatStatDuration(ms: number): string {
  const s = ms / 1_000
  if (s < 60) return `${Math.round(s * 10) / 10}s`
  return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`
}

/** Compact token count: `923`, `1.2k`, `3.4M`. */
export function formatStatTokens(n: number): string {
  if (n >= 1_000_000) return `${Math.round((n / 1_000_000) * 10) / 10}M`
  if (n >= 1_000) return `${Math.round((n / 1_000) * 10) / 10}k`
  return String(n)
}

/**
 * The bottom-bar text (web StatsLine style, ` | `-separated groups; a group
 * with no data drops out whole). Empty when nothing happened yet.
 *
 * LLM/Tool wall durations are still folded into {@link SessionStats}
 * (`llmMs`/`toolMs`, kept for debugging/telemetry), but are NOT shown in the
 * bottom bar: cumulative whole-session durations carry little actionable
 * meaning, so the bar stays compact with steps/turns · tokens only.
 * @param stats - the session stats.
 * @returns display string, or '' for a session with no activity.
 */
export function formatSessionStats(stats: SessionStats): string {
  const groups: string[] = []
  if (stats.steps > 0) {
    groups.push(`${stats.steps} step${stats.steps === 1 ? '' : 's'} · ${stats.turns} turn${stats.turns === 1 ? '' : 's'}`)
  }
  if (stats.inputTokens > 0 || stats.outputTokens > 0) {
    groups.push(`${formatStatTokens(stats.inputTokens)} tok in · ${formatStatTokens(stats.outputTokens)} tok out`)
  }
  return groups.join(' | ')
}
