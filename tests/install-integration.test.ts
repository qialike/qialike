/**
 * Integration tests for the installer and the upgrade path, against a LOCAL
 * fixture that mimics GitHub's release redirect.
 *
 * Why this file exists: the installer is the only way a new user gets qialike,
 * yet nothing else exercises its download → unpack → place → PATH → verify
 * sequence. The release gate's install smoke deliberately does not run it — a
 * downloader would fetch the PUBLISHED release instead of the build under test —
 * so a broken installer could ship silently. The unit tests source single modules
 * or run `--dry-run`, which resolves nothing and downloads nothing.
 *
 * The fixture is a real HTTP server, so `curl`, the redirect the version is read
 * from, `tar`, `unzip` and the `curl | bash` upgrade pipe are all the real ones;
 * only the release HOST is local. That makes the happy paths deterministic and
 * offline, and it makes reachable the failures a real release cannot stage on
 * demand: a missing asset, a bad checksum, an asset that disagrees with its tag.
 *
 * The fixture runs as a SEPARATE PROCESS on purpose. An in-process server (via
 * `Bun.serve`) deadlocks against these tests: the installer and `upgrade()` use
 * `spawnSync`, which blocks the event loop, and a blocked event loop cannot answer
 * the very request the child is waiting on. Every case would time out at 5s.
 * Serving from a directory also lets each case change what is published with a
 * file write, and needs no IPC.
 *
 * What this does NOT replace: the deployed-host checks (that
 * `https://qialike.com/install` serves what the repo has, that the release really
 * carries all six assets, that the tag is bare). Those need the real network and
 * are verified per release — see qialike-development.md §9.4.11.
 *
 * Run with `bun test tests/install-integration.test.ts`.
 *
 * @module qialike/install-integration-test
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assetFor, detectTarget, upgrade } from '../packages/qialike-app/src/self-update.ts'
import { runUpgrade } from '../apps/tui-bin/src/upgrade-command.ts'

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const INSTALLER = join(REPO, 'scripts', 'install')

/**
 * The real artifact, used by the one case that must run AS the managed copy. It is
 * gitignored build output and legitimately absent (a `--package` build clears
 * `dist/`), so that case skips rather than fails.
 */
const BINARY_CANDIDATES = [join(REPO, 'dist', 'qialike'), join(REPO, 'dist', 'linux-x64', 'qialike')]

/** The tag the fixture publishes — a patch above any real release. */
const TAG = '0.6.9'

/**
 * The target the INSTALLER will detect on this host, so the unpinned cases fetch a
 * name that really matches. Derived rather than hardcoded to `linux-x64` because
 * the release carries six platforms and a contributor may run this elsewhere.
 */
const TARGET = detectTarget()
const ASSET = TARGET === undefined ? undefined : assetFor(TARGET)
/** `build.mjs --package` gives linux a `.tar.gz` and everyone else a `.zip`. */
const KIND = TARGET?.startsWith('linux') ? 'tar.gz' : 'zip'
/** Inside the archive the member is always the generic name (`.exe` on Windows). */
const INNER = TARGET?.startsWith('windows') ? 'qialike.exe' : 'qialike'

/**
 * Serves a directory as a release host: `tag`, `files/<name>`, `files/install`.
 *
 * Two shapes, because the installer now reads a list of sources and they do not
 * answer the same way. `github` issues the 302 that carries the tag; `gitcode`
 * answers the same path with an HTML page — verified against the real host — and
 * exposes the tag through an API instead, which is exactly the difference the
 * source list has to cope with.
 */
const FIXTURE_SERVER = `
import http.server, json, os, re, socketserver, sys

root = sys.argv[1]
shape = sys.argv[2]
files = os.path.join(root, 'files')

def tag():
    with open(os.path.join(root, 'tag')) as fh:
        return fh.read().strip()

class Handler(http.server.BaseHTTPRequestHandler):
    def _notfound(self):
        self.send_response(404)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def _send(self, path, status=200, content_type=None):
        if not os.path.isfile(path):
            return self._notfound()
        with open(path, 'rb') as fh:
            body = fh.read()
        self.send_response(status)
        if content_type:
            self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _html(self):
        body = b'<!DOCTYPE html><html><body>releases</body></html>'
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        # The releases API a mirror without a redirect is read through.
        if self.path == '/api/latest':
            body = json.dumps({'tag_name': tag()}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        # GitHub 404s BOTH of these when the release carries no such asset, so the
        # fixture must too: that is the real shape of "this platform was never
        # published", and it is the version RESOLUTION that fails first.
        latest = re.match(r'^/latest/download/(.+)$', self.path)
        if latest:
            name = latest.group(1)
            if not os.path.isfile(os.path.join(files, name)):
                return self._notfound()
            if shape == 'gitcode':
                return self._html()
            self.send_response(302)
            self.send_header('Location', '/download/%s/%s' % (tag(), name))
            self.end_headers()
            return
        if self.path == '/install':
            return self._send(os.path.join(files, 'install'))
        download = re.match(r'^/download/([^/]+)/(.+)$', self.path)
        if download:
            if download.group(1) != tag():
                return self._notfound()
            return self._send(os.path.join(files, download.group(2)))
        self._notfound()

    def log_message(self, *args):
        pass

server = socketserver.TCPServer(('127.0.0.1', 0), Handler)
with open(os.path.join(root, 'port-' + shape), 'w') as fh:
    fh.write(str(server.server_address[1]))
server.serve_forever()
`

const temporaries: string[] = []
process.on('exit', () => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temporaries.push(dir)
  return dir
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * A one-member archive holding an executable that reports `qialike <version>`.
 *
 * The member name is load bearing: the installer looks for exactly the name its
 * own table derives (`qialike`, or `qialike.exe` on Windows) and refuses an
 * archive that does not contain it, so a fixture that shipped anything else would
 * test the refusal rather than the happy path.
 */
function stubArchive(dir: string, kind: 'tar.gz' | 'zip', member: string, version: string): Uint8Array {
  const payload = join(dir, member)
  writeFileSync(payload, `#!/bin/sh\necho "qialike ${version}"\n`)
  chmodSync(payload, 0o755)

  // Named so it can never collide with the member it carries.
  const archive = join(dir, `stub.${kind}`)
  const built = kind === 'zip'
    ? spawnSync('zip', ['-q', '-j', archive, payload], { encoding: 'utf8' })
    : spawnSync('tar', ['-czf', archive, '-C', dir, member], { encoding: 'utf8' })
  expect(built.status, `could not build the fixture archive: ${built.stderr}`).toBe(0)
  return readFileSync(archive)
}

let fixtureFiles = ''
let fixtureBase = ''
let mirrorBase = ''
const fixtureChildren: { kill(): void }[] = []

/** Publish (or, with `undefined`, unpublish) one file the fixture serves. */
function publish(name: string, bytes: Uint8Array | undefined): void {
  const path = join(fixtureFiles, name)
  if (bytes === undefined) rmSync(path, { force: true })
  else writeFileSync(path, bytes)
}

beforeAll(async () => {
  const root = tempDir('qialike-fixture-')
  fixtureFiles = join(root, 'files')
  mkdirSync(fixtureFiles, { recursive: true })
  writeFileSync(join(root, 'tag'), `${TAG}\n`)
  // The fixture serves the REAL installer at /install, so the `curl | bash`
  // upgrade path downloads the same bytes qialike.com would.
  copyFileSync(INSTALLER, join(fixtureFiles, 'install'))

  const script = join(root, 'fixture.py')
  writeFileSync(script, FIXTURE_SERVER)

  // Both shapes over the SAME published files, so a case can serve one host and
  // withhold the other without publishing the bytes twice.
  for (const [shape, assign] of [['github', (base: string) => { fixtureBase = base }], ['gitcode', (base: string) => { mirrorBase = base }]] as const) {
    fixtureChildren.push(Bun.spawn(['python3', script, root, shape], { stdout: 'ignore', stderr: 'ignore' }))
    const portFile = join(root, `port-${shape}`)
    const deadline = Date.now() + 10_000
    while (!existsSync(portFile) && Date.now() < deadline) await Bun.sleep(50)
    if (!existsSync(portFile)) throw new Error(`the ${shape} fixture server never reported a port`)
    assign(`http://127.0.0.1:${readFileSync(portFile, 'utf8').trim()}`)
  }
})

afterAll(() => { for (const child of fixtureChildren) child.kill() })

/** A throwaway HOME with a profile, so the PATH step has something to append to. */
function makeHome(): string {
  const home = tempDir('qialike-fixture-home-')
  writeFileSync(join(home, '.bashrc'), '# mine\n')
  return home
}

/**
 * Run the REAL installer against the fixture.
 *
 * The release host goes in through `--base-url`, the documented flag, rather than
 * the `QIALIKE_INSTALL_BASE_URL` the piped cases must use — `upgrade()` can only
 * hand the installer an environment, so covering the flag here and the variable
 * there is what exercises both spellings.
 *
 * `base: null` passes no `--base-url` at all, which is what the case that supplies a
 * whole `QIALIKE_INSTALL_SOURCES` list needs: the flag would replace that list with a
 * single host and the fallback under test would never happen. The sentinel is `null`
 * and not `undefined` because passing `undefined` to a defaulted parameter RESTORES
 * the default — which silently made this helper pass the GitHub fixture while the
 * case believed it had supplied only a source list.
 */
function install(home: string, args: string[] = [], env: Record<string, string> = {}, base: string | null = fixtureBase) {
  const result = spawnSync('bash', [INSTALLER, ...(base === null ? [] : ['--base-url', base]), ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      HOME: home,
      PATH: '/usr/bin:/bin',
      ...env,
    },
  })
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

/**
 * The environment for the `--auto` case.
 *
 * It must NOT inherit the update switches. The release gate exports
 * `QIALIKE_DISABLE_AUTOUPDATE=1` for every child it spawns, so that no test
 * reaches the network — the variable doing its job, but fatal here: the policy
 * would decline, nothing would install, and this case would fail for a reason that
 * has nothing to do with the update path. Offline is instead guaranteed by
 * construction, since the fixture is the only release host this environment names.
 */
function autoEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    PATH: '/usr/bin:/bin',
    QIALIKE_INSTALL_BASE_URL: fixtureBase,
    QIALIKE_INSTALL_URL: `${fixtureBase}/install`,
  }
  delete env.QIALIKE_DISABLE_AUTOUPDATE
  delete env.QIALIKE_ALWAYS_NOTIFY_UPDATE
  return env
}

describe.skipIf(TARGET === undefined || ASSET === undefined)('a published asset installs end to end', () => {
  test('the host archive: fetched, unpacked, placed, put on PATH, and verified', () => {
    const work = tempDir('qialike-fixture-a-')
    const bytes = stubArchive(work, KIND, INNER, TAG)
    publish(ASSET!, bytes)
    // A correct manifest, so the checksum branch runs for real (it is dead code
    // against the live release, which publishes none).
    publish('sha256sums.txt', Buffer.from(`${sha256(bytes)}  ${ASSET}\n`))

    const home = makeHome()
    const { status, output } = install(home)

    expect(status, output).toBe(0)
    expect(output).toContain(`installing qialike ${TAG} for ${TARGET}`)
    const dest = join(home, '.dsh', 'bin', INNER)
    expect(existsSync(dest)).toBe(true)
    expect(spawnSync(dest, ['--version'], { encoding: 'utf8' }).stdout.trim()).toBe(`qialike ${TAG}`)
    // The PATH line `qialike uninstall` matches byte-for-byte.
    expect(readFileSync(join(home, '.bashrc'), 'utf8')).toContain('export PATH="$HOME/.dsh/bin:$PATH"')
  })

  test('a zip is unpacked with unzip and keeps its .exe name on Windows', () => {
    const work = tempDir('qialike-fixture-b-')
    publish('qialike-windows-x64.zip', stubArchive(work, 'zip', 'qialike.exe', TAG))
    publish('sha256sums.txt', undefined) // no manifest: the branch must simply skip

    const home = makeHome()
    const { status, output } = install(home, [], { QIALIKE_INSTALL_TARGET: 'windows-x64' })

    expect(status, output).toBe(0)
    // Reaching "installed" at all is what proves the zip branch ran: a `.zip`
    // cannot be extracted by `tar`, and the member the installer demands is
    // `qialike.exe` rather than `qialike`.
    expect(output).toContain(`installing qialike ${TAG} for windows-x64`)
    const dest = join(home, '.dsh', 'bin', 'qialike.exe')
    expect(existsSync(dest)).toBe(true)
    expect(spawnSync(dest, ['--version'], { encoding: 'utf8' }).stdout.trim()).toBe(`qialike ${TAG}`)
  })
})

describe.skipIf(TARGET === undefined || ASSET === undefined)('failures are reported and leave nothing half-installed', () => {
  test('a platform the release never published fails at resolution', () => {
    const home = makeHome()
    publish(ASSET!, undefined) // e.g. an asset that was never uploaded

    const { status, output } = install(home)

    expect(status).not.toBe(0)
    expect(output).toContain('could not resolve the latest version from')
    expect(output).toContain(ASSET!)
    // Refused BEFORE any write: no install dir, and the profile is untouched.
    expect(existsSync(join(home, '.dsh', 'bin'))).toBe(false)
    expect(readFileSync(join(home, '.bashrc'), 'utf8')).toBe('# mine\n')
  })

  test('a pinned version whose asset 404s fails at the download', () => {
    // The updater always pins (it decided on a version already), so this is the
    // failure mode the upgrade path actually hits.
    const home = makeHome()
    publish(ASSET!, undefined)

    const { status, output } = install(home, [], { QIALIKE_VERSION: TAG })

    expect(status).not.toBe(0)
    expect(output).toContain('download failed:')
    expect(output).toContain(ASSET!)
    expect(existsSync(join(home, '.dsh', 'bin'))).toBe(false)
    expect(readFileSync(join(home, '.bashrc'), 'utf8')).toBe('# mine\n')
  })

  test('a checksum that disagrees with the asset is refused', () => {
    const work = tempDir('qialike-fixture-c-')
    publish(ASSET!, stubArchive(work, KIND, INNER, TAG))
    publish('sha256sums.txt', Buffer.from(`${'0'.repeat(64)}  ${ASSET}\n`))

    const home = makeHome()
    const { status, output } = install(home)

    expect(status).not.toBe(0)
    expect(output).toContain(`SHA256 mismatch for ${ASSET}`)
    expect(existsSync(join(home, '.dsh', 'bin', INNER))).toBe(false)
  })

  test('an asset that disagrees with its tag is reported, but the install still succeeds', () => {
    const work = tempDir('qialike-fixture-d-')
    // The archive says 0.6.8 while the release tag is 0.6.9.
    publish(ASSET!, stubArchive(work, KIND, INNER, '0.6.8'))
    publish('sha256sums.txt', undefined)

    const home = makeHome()
    const { status, output } = install(home)

    // A warning, not a failure: the binary installed and works, so failing here
    // would leave the user with a working command and a non-zero exit code.
    expect(status, output).toBe(0)
    expect(output).toContain('the release asset and its tag disagree')
    expect(existsSync(join(home, '.dsh', 'bin', INNER))).toBe(true)
  })
})

describe.skipIf(TARGET === undefined || ASSET === undefined)('the source list is probed, and the mirror takes over', () => {
  test('a dead primary falls through to a mirror that has no redirect at all', () => {
    // The feature end to end, and the reason the source list exists: a user who
    // cannot reach GitHub still gets an install. The mirror here answers
    // `/latest/download/...` with an HTML page exactly as gitcode does, so the tag
    // can only come from its API — the whole fallback chain, resolve and download.
    const work = tempDir('qialike-fixture-mirror-')
    publish(ASSET!, stubArchive(work, KIND, INNER, TAG))
    publish('sha256sums.txt', undefined)

    const home = makeHome()
    const { status, output } = install(
      home,
      [],
      // Port 1 refuses immediately, so this costs no wait: the point under test is
      // the fallback, not the timeout budget.
      { QIALIKE_INSTALL_SOURCES: `http://127.0.0.1:1/releases,${mirrorBase}|${mirrorBase}/api/latest` },
      null,
    )

    expect(status, output).toBe(0)
    expect(output).toContain('did not answer')
    expect(output).toContain('can lag behind')
    expect(output).toContain(`installing qialike ${TAG} for ${TARGET}`)
    const dest = join(home, '.dsh', 'bin', INNER)
    expect(existsSync(dest)).toBe(true)
    expect(spawnSync(dest, ['--version'], { encoding: 'utf8' }).stdout.trim()).toBe(`qialike ${TAG}`)
  })

  test('the primary is preferred when it answers, and the mirror is never contacted', () => {
    const work = tempDir('qialike-fixture-primary-')
    publish(ASSET!, stubArchive(work, KIND, INNER, TAG))
    publish('sha256sums.txt', undefined)

    const home = makeHome()
    const { status, output } = install(
      home,
      [],
      // The mirror is listed but points at a dead port: if the probe did not stop at
      // the first source that answered, this install could not succeed.
      { QIALIKE_INSTALL_SOURCES: `${fixtureBase},http://127.0.0.1:1/releases` },
      null,
    )

    expect(status, output).toBe(0)
    expect(output).not.toContain('did not answer')
    expect(existsSync(join(home, '.dsh', 'bin', INNER))).toBe(true)
  })

  test('an explicit --base-url is the ONLY source, so there is no silent fallback', () => {
    // A configured host must be the whole truth: the public mirrors are not appended
    // to it, or a deliberately dead host would be papered over and this would install
    // something the operator did not ask for.
    const home = makeHome()
    publish(ASSET!, undefined)

    const { status, output } = install(home, [], { QIALIKE_VERSION: TAG }, 'http://127.0.0.1:1/releases')

    expect(status).not.toBe(0)
    expect(output).toContain('download failed:')
    expect(output).toContain('http://127.0.0.1:1/releases')
    expect(output).not.toContain('gitcode.com')
    expect(existsSync(join(home, '.dsh', 'bin'))).toBe(false)
  })
})

describe.skipIf(TARGET === undefined || ASSET === undefined)('the release host comes from the caller, not from the ambient environment', () => {
  test('runUpgrade resolves through the injected env alone', () => {
    // The gates read `io.env`, so release resolution must too — otherwise the two
    // disagree about which host this run is talking to, and a caller that injects
    // an environment (a test, or any future embedding) silently reaches the real
    // GitHub while every other check obeys the injection. `--check` is read-only,
    // so this runs the resolver itself with nothing else in the way.
    //
    // Published here rather than relied on from an earlier case: the resolver needs
    // the asset to exist to get its redirect, so without this the case would only
    // pass as part of the whole file and fail under a `-t` filter.
    const work = tempDir('qialike-fixture-g-')
    publish(ASSET!, stubArchive(work, KIND, INNER, TAG))

    const out: string[] = []
    const err: string[] = []
    const code = runUpgrade(['--check'], {
      installed: '0.6.0',
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      // Deliberately NOT `...process.env`: the base URL exists only here, so a
      // resolve that consults `process.env` cannot find it and cannot pass.
      env: { QIALIKE_INSTALL_BASE_URL: fixtureBase } as NodeJS.ProcessEnv,
    })

    expect(code, err.join('\n')).toBe(0)
    expect(out.join('\n')).toContain(`newest     ${TAG}`)
    expect(out.join('\n')).toContain('patch update available')
  })

  test('--auto on Windows announces the patch and installs NOTHING', () => {
    // The Windows contract, end to end against a real release host: a patch the
    // POSIX policy would install silently has to become a notice carrying both
    // download URLs, and the installer must never be fetched. `platform` is
    // injected because the suite runs on whatever host is at hand — the point is
    // the decision, and `--auto` must not reach for bash on the way.
    const work = tempDir('qialike-fixture-h-')
    publish(ASSET!, stubArchive(work, KIND, INNER, TAG))
    // The fixture already serves the REAL installer at /install (see `beforeAll`),
    // and this case must never fetch it — that is half of what is being pinned.

    const out: string[] = []
    const err: string[] = []
    const code = runUpgrade(['--auto', '--json'], {
      installed: '0.6.0',
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      platform: 'win32',
      env: { QIALIKE_INSTALL_BASE_URL: fixtureBase } as NodeJS.ProcessEnv,
    })

    expect(code, err.join('\n')).toBe(0)
    // The last line is the machine-readable report the startup relay branches on;
    // everything before it is the notice a person reads.
    const report = JSON.parse(out[out.length - 1] as string)
    expect(report).toMatchObject({
      decision: 'notify',
      installed: '0.6.0',
      newest: TAG,
      canSelfInstall: false,
      downloads: [`${fixtureBase}/download/${TAG}/${ASSET}`],
    })
    const notice = out.slice(0, -1).join('\n')
    expect(notice).toContain(`qialike ${TAG} is available (you have 0.6.0)`)
    expect(notice).toContain('download it and replace the file by hand:')
    expect(notice).not.toContain("run 'qialike upgrade'")
    // Nothing was installed, and nothing tried to be.
    expect(notice).not.toContain('updated to qialike')
    expect(notice).not.toContain('automatic update failed')
  })

  test('--check --json answers even when no source can be reached', () => {
    // The TUI renders this answer, so "I could not check" has to travel as data:
    // the report still arrives (with `newest: null` and the releases page as the
    // fallback link) and only the EXIT CODE says the probe failed. A dead host is
    // enough — no fixture traffic is involved.
    const out: string[] = []
    const err: string[] = []
    const code = runUpgrade(['--check', '--json'], {
      installed: '0.6.0',
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      env: { QIALIKE_INSTALL_BASE_URL: 'http://127.0.0.1:1/releases' } as NodeJS.ProcessEnv,
    })

    expect(code, err.join('\n')).toBe(1)
    expect(out).toHaveLength(1)
    expect(JSON.parse(out[0] as string)).toEqual({
      // `decision` is part of the contract (it is how a caller tells "could not
      // check" from "up to date"), and the emitter always sets it.
      decision: 'check',
      installed: '0.6.0',
      newest: null,
      relation: null,
      canSelfInstall: false,
      downloads: ['http://127.0.0.1:1/releases'],
    })
  })
})

describe.skipIf(TARGET === undefined || ASSET === undefined)('the upgrade path runs the real installer over a real pipe', () => {
  test('upgrade() fetches /install, pipes it to bash, and reports what landed', () => {
    const work = tempDir('qialike-fixture-e-')
    publish(ASSET!, stubArchive(work, KIND, INNER, TAG))
    publish('sha256sums.txt', undefined)

    const home = makeHome()
    const dir = join(home, '.dsh', 'bin')
    mkdirSync(dir, { recursive: true })
    // A managed copy, because upgrade() refuses to install over nothing.
    writeFileSync(join(dir, 'qialike'), '#!/bin/sh\necho "qialike 0.6.0"\n')
    chmodSync(join(dir, 'qialike'), 0o755)

    const result = upgrade(TAG, {
      dir,
      installUrl: `${fixtureBase}/install`,
      env: {
        ...process.env,
        HOME: home,
        PATH: '/usr/bin:/bin',
        QIALIKE_INSTALL_BASE_URL: fixtureBase,
      } as NodeJS.ProcessEnv,
    })

    expect(result.ok, result.error).toBe(true)
    // Read back from the installed file — the upgrade reports what is on disk.
    expect(result.version).toBe(TAG)
  })

  const binary = BINARY_CANDIDATES.find((path) => existsSync(path))
  test.skipIf(binary === undefined)('--auto installs a patch through the real binary', () => {
    // The strongest form available offline: the REAL artifact runs the policy, the
    // resolution, the installer fetch and the replacement, against a local host.
    const work = tempDir('qialike-fixture-f-')
    publish(ASSET!, stubArchive(work, KIND, INNER, TAG))
    publish('sha256sums.txt', undefined)

    const home = makeHome()
    const dir = join(home, '.dsh', 'bin')
    mkdirSync(dir, { recursive: true })
    // The managed copy IS the build under test, so the fixture's tag is a patch
    // above it and the policy chooses "install" rather than "notify".
    const managed = join(dir, 'qialike')
    copyFileSync(binary!, managed)
    chmodSync(managed, 0o755)

    const result = spawnSync(managed, ['upgrade', '--auto'], {
      encoding: 'utf8',
      timeout: 120_000,
      env: autoEnv(home),
    })

    expect(result.status, result.stderr).toBe(0)
    expect(`${result.stdout}${result.stderr}`).toContain(`updated to qialike ${TAG}`)
    expect(spawnSync(managed, ['--version'], { encoding: 'utf8' }).stdout.trim()).toBe(`qialike ${TAG}`)
  })
})
