/**
 * qialike — the ripgrep provider behind the `glob` / `grep` tools.
 *
 * The harness's `@deepseek-ai/dsh-tool-fs-search` runs the packaged ripgrep
 * through `@vscode/ripgrep`, whose `rgPath` comes from
 * `createRequire(import.meta.url).resolve('@vscode/ripgrep-<platform>-<arch>/bin/rg')`.
 * A `bun build --compile` single file bundles that module's JavaScript but not
 * its optional platform package, so the resolution throws
 * (`Could not find @vscode/ripgrep-win32-x64`) and every `glob` / `grep` call
 * failed at launch with `ripgrep launch failed` — both tools were unusable in
 * the artifact.
 *
 * This module carries the binary instead. The build embeds the executable for
 * each build target (`src/ripgrep-binary.generated.ts`, imported lazily so a
 * runtime that never searches never pays for it) and the patch in
 * `apps/tui-bin/build.mjs` makes the bundled search package ask here first. The
 * bytes are written out once per content hash and the path returned — a real
 * file, which is what a spawned process needs.
 *
 * @module @yourname/qialike-app/ripgrep-shim
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RIPGREP_TEMP_DIR } from './ripgrep-mode.ts'

/** The embedded binary and its content-addressed file name, or `undefined` when absent. */
async function embedded(): Promise<{ base64: string; file: string } | undefined> {
  try {
    const generated = await import(`./ripgrep-binary.generated.ts` as string)
    const key = `${process.platform}-${process.arch}`
    const base64 = (generated.RIPGREP_BINARIES as Record<string, string | undefined>)[key]
    // The name is per target, not per build host: a cross-built Windows artifact
    // needs its `.exe` even when the build ran on Linux.
    const file = (generated.RIPGREP_BINARY_FILES as Record<string, string | undefined>)[key]
    if (base64 === undefined || file === undefined) return undefined
    return { base64, file }
  } catch {
    // A build that embedded nothing (a source checkout, or a target whose
    // package could not be obtained) leaves the harness on its own resolution.
    return undefined
  }
}

/**
 * Whether this artifact carries a ripgrep for the running platform.
 * @returns whether an embedded binary is usable here.
 */
export async function hasEmbeddedRipgrep(): Promise<boolean> {
  return (await embedded()) !== undefined
}

/**
 * Materialize the embedded ripgrep and return its path.
 *
 * The file name carries the binary's content hash, so a rebuilt artifact lands a
 * new file instead of racing an older one, and the write is idempotent across
 * concurrent calls (last writer wins with identical bytes).
 * @returns the executable's absolute path.
 * @throws when this artifact's platform has no embedded binary.
 */
export async function ripgrepPath(): Promise<string> {
  const binary = await embedded()
  if (binary === undefined) {
    throw new Error(`qialike has no embedded ripgrep for ${process.platform}-${process.arch}`)
  }
  const dir = join(tmpdir(), RIPGREP_TEMP_DIR)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, binary.file)
  // `writeFileSync` with a string would UTF-8 the binary's bytes; it is decoded
  // to a Buffer on purpose.
  if (!existsSync(file)) writeFileSync(file, Buffer.from(binary.base64, 'base64'), { mode: 0o700 })
  return file
}
