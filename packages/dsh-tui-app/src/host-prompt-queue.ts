/**
 * The host-mode prompt gate: prompts typed while the session on screen is not
 * (yet) the one the host has attached.
 *
 * In host mode the client can be AHEAD of the host in two ways, and both mean a
 * prompt typed right now must be held rather than sent:
 *   - the log file was rendered first and the host is still materializing the
 *     same session in the background (M6: the transcript is on screen ~1 s
 *     after launch, the host needs seconds to minutes for a giant log);
 *   - a session SWITCH is in flight: the screen already shows the new session
 *     while the host still has the old one attached, so an immediate prompt
 *     would be delivered to the session the user just left.
 *
 * Held prompts are sent in arrival order the moment the host confirms it is
 * attached. The gate only decides WHEN a prompt may go out; sending stays the
 * caller's job, so this module holds no transport and stays testable.
 *
 * This is deliberately a gate rather than a one-shot flag: a flag that only ever
 * flips to `true` cannot express "a switch is in flight" — which is how a
 * non-file launch once ended up with every prompt queued forever (the flag was
 * set only on the file-backed path).
 *
 * @module @yourname/dsh-tui-app/host-prompt-queue
 */

/** Prompts held until the host reports the session attached. */
export interface PromptQueue {
  /** Whether a prompt may be sent right now. */
  readonly ready: boolean
  /** Prompts currently held. */
  readonly size: number
  /**
   * Offer a prompt. `true` means the caller must NOT send it (it is held) and
   * should say so; `false` means send it now.
   * The ARRAY is copied (so a reused draft array cannot grow a held prompt);
   * the block objects are shared by reference — they are plain JSON by the
   * protocol's contract and are not mutated after submit.
   * @param blocks - the message's content blocks, sent as plain JSON.
   * @returns whether the prompt was held.
   */
  enqueue(blocks: readonly unknown[]): boolean
  /** Close the gate again: prompts are held until the next {@link release}.
   *  Used when a switch starts, because the host is still on the old session. */
  hold(): void
  /**
   * The host attached the session now on screen: send everything held, in
   * arrival order, and open the gate.
   * @param send - how to send one prompt.
   */
  release(send: (blocks: readonly unknown[]) => void): void
}

/**
 * Create an empty gate. It starts CLOSED: at launch nothing is attached yet.
 * @returns the queue.
 */
export function createPromptQueue(): PromptQueue {
  const held: unknown[][] = []
  let ready = false
  return {
    get ready() { return ready },
    get size() { return held.length },
    enqueue(blocks) {
      if (ready) return false
      held.push([...blocks])
      return true
    },
    hold() { ready = false },
    release(send) {
      ready = true
      // A copy: `send` may re-enter (a transport failure is reported through the
      // caller's own error path), and the held list must not be mutated twice.
      for (const blocks of held.splice(0, held.length)) send(blocks)
    },
  }
}
