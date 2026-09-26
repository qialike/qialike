#!/usr/bin/env node
/**
 * The `qialike` npm entry point: locate the platform binary and hand over.
 *
 * WHY THIS FILE EXISTS. qialike is a compiled single-file executable, not a
 * Node program, but npm is how Windows users install command-line tools — that
 * platform has no `bash`, so the documented `curl … | bash` installer cannot
 * run there and the README has to walk people through downloading a zip,
 * unpacking it by hand and editing their PATH. This wrapper is what turns that
 * into `npm i -g qialike`.
 *
 * WHY A WRAPPER AT ALL, rather than pointing `bin` straight at `qialike.exe`:
 * npm's `cmd-shim` does support a shebang-less target ("assume it's something
 * that'll be compiled … just call it directly"), but no widely used package
 * relies on that path — esbuild, Biome, SWC and sharp all ship a small script
 * in front of the binary, and the reason is the failure mode below: an
 * `optionalDependency` can go missing (a mirrored registry that dropped it,
 * `--no-optional`, a partial install), and only a wrapper can say so in words.
 * A bare exec would fail with whatever the shell prints for a missing file.
 *
 * WHY `optionalDependencies` IN THE PARENT: npm installs only the platform
 * package whose `os`/`cpu` match, so exactly one ~55 MB payload is downloaded
 * per machine instead of every target. That mechanism is load-bearing — this
 * file is the part that reports when it breaks.
 *
 * @module qialike/bin
 */

'use strict'

const { spawnSync } = require('node:child_process')
const { existsSync, readFileSync } = require('node:fs')
const { dirname, join } = require('node:path')

/** The installer this npm channel stands in for, quoted in every message. */
const SHELL_INSTALLER = 'curl -fsSL https://qialike.com/install | bash'
const RELEASES = 'https://github.com/qialike/qialike/releases'

const platform = process.platform
const arch = process.arch
const name = `qialike-${platform}-${arch}`

/**
 * The version of the parent package, read from its own `package.json`. Used
 * only to write an exact reinstall command: a bare `npm i -g <name>` could
 * fetch a platform package that does not match the parent that resolved it.
 * @returns {string} the semver string, or `latest` when it cannot be read.
 */
function ownVersion() {
  try {
    const manifest = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'))
    return typeof manifest.version === 'string' && manifest.version.length > 0 ? manifest.version : 'latest'
  } catch {
    return 'latest'
  }
}

/**
 * Report a fatal setup problem and stop, without pretending the binary ran.
 * The exit code is always 1, never the binary's own — a wrapper failure is not
 * a model turn failing.
 * @param {string} message - the full, already-wrapped diagnostic.
 * @returns {never} always exits.
 */
function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

// This channel carries Windows binaries only. Refuse loudly and name the route
// that does work for the platform we are on: silently doing nothing, or dying
// with a spawn error, would both be worse than one actionable sentence.
if (platform !== 'win32') {
  fail(
    `qialike: the npm channel ships Windows binaries only (this is ${platform}-${arch}).\n`
    + '\n'
    + '  Install it with the shell installer instead:\n'
    + `      ${SHELL_INSTALLER}\n`
    + '\n'
    + '  That is what Linux and macOS use; "npm i -g qialike" exists because\n'
    + '  Windows has no bash to run the installer with.\n',
  )
}

// x64 and arm64 are the only Windows targets the release publishes. Anything
// else (ia32, or a future arch) has no package to resolve.
if (arch !== 'x64' && arch !== 'arm64') {
  fail(
    `qialike: no npm build for ${platform}-${arch}.\n`
    + '\n'
    + '  Published Windows targets are x64 and arm64. For anything else, fetch a\n'
    + `  release archive from ${RELEASES}\n`,
  )
}

// Resolve the platform package through Node itself, so the same relative layout
// works for a global install (%APPDATA%\npm\node_modules\…), a local install and
// a workspace. `package.json` is used purely as a landmark: it keeps resolving
// even for a package that declares `exports`.
let manifestPath
try {
  manifestPath = require.resolve(`${name}/package.json`)
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error)
  const skipped = process.env.npm_config_optional === 'false'
  fail(
    `qialike: the ${name} package is missing, so there is no binary to run.\n`
    + '\n'
    + '  This is expected when npm was told to skip optional dependencies\n'
    + `  (${skipped ? 'npm_config_optional=false is set right now' : '--no-optional / --omit=optional'}),\n`
    + '  and possible when a mirror dropped it or the install was interrupted.\n'
    + '\n'
    + '  Install it explicitly:\n'
    + `      npm i -g ${name}@${ownVersion()}\n`
    + '\n'
    + `  (resolution error: ${reason})\n`,
  )
}

const exe = join(dirname(manifestPath), 'qialike.exe')
if (!existsSync(exe)) {
  fail(
    `qialike: ${name} is installed but carries no qialike.exe.\n`
    + '\n'
    + `  Expected at: ${exe}\n`
    + `  Reinstall: npm i -g ${name}@${ownVersion()}\n`,
  )
}

// Hand the terminal over: stdio is inherited, because the TUI owns raw mode,
// colour and resize. The child's exit code is what the caller sees.
const result = spawnSync(exe, process.argv.slice(2), { stdio: 'inherit' })

if (result.error) {
  const reason = result.error instanceof Error ? result.error.message : String(result.error)
  fail(
    `qialike: failed to launch ${exe}\n`
    + '\n'
    + `  ${reason}\n`
    + '\n'
    + '  If the file exists and this persists the download may be incomplete —\n'
    + `  reinstall: npm i -g ${name}@${ownVersion()}\n`,
  )
}

// A signal-terminated child has `status === null`; count that as a failure
// rather than as success, because the turn did not complete.
process.exit(result.status === null ? 1 : result.status)
