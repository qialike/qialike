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

/**
 * The fixture's version pair, derived from the tree.
 *
 * The cases need TWO relationships, and hardcoding either end breaks one of them:
 *   * `--auto` with the REAL artifact as the managed copy needs the published tag
 *     to be above the build under test, or the policy correctly refuses it as
 *     "not an update" (`fae9975`) and the case sees an empty output;
 *   * the cases that inject `installed` need the published tag to be exactly one
 *     PATCH above it, because they assert the "patch update available" wording.
 *
 * So derive both from `package.json`: `PATCH_BELOW` is the tree's own version (what
 * those cases pretend is installed) and `TAG` is one patch above it. Hardcoding
 * `0.6.0`/`0.6.9` did exactly the stale thing when the tree moved to `0.7.0`.
 */
function treeVersion(): string {
  const version = (JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { version: string }).version
  const match = /^(\d+\.\d+\.\d+)/.exec(version)
  if (match === null) throw new Error(`unparseable package version: ${version}`)
  return match[1]
}
const PATCH_BELOW = treeVersion()
const TAG = (() => {
  const [major, minor, patch] = PATCH_BELOW.split('.')
  return `${major}.${minor}.${Number(patch) + 1}`
})()

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
import http.server, json, os, re, socketserver, sys, time

SLOW_SECONDS = 1
root = sys.argv[1]
shape = sys.argv[2]
files = os.path.join(root, 'files')

def tag():
    with open(os.path.join(root, 'tag')) as fh:
        return fh.read().strip()

# THREADED, not the plain TCPServer: one case deliberately stalls a body for a second
# while the installer is sampling or downloading, and on a single-threaded server that
# one connection blocks every later request — including the probes of unrelated cases,
# which then fail as "could not resolve" long after the case that caused it.
class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True

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
            # A source can be slow for the BODY while answering the small probe at once.
            # That is the GitHub shape this comparison exists for (the redirect comes
            # from github.com, the 55 MB comes from release-assets.githubusercontent.com),
            # so the switch delays only the transfer, never the probe.
            if os.path.isfile(os.path.join(root, 'slow-' + shape)):
                time.sleep(SLOW_SECONDS)
            return self._send(os.path.join(files, download.group(2)))
        self._notfound()

    def log_message(self, *args):
        pass

server = Server(('127.0.0.1', 0), Handler)
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

let fixtureRoot = ''
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

/**
 * Publish `asset` together with a manifest that lists its digest — the shape of a
 * COMPLETE release, which is what the installer now requires before it will place
 * anything. Tests that are about the manifest itself (`publish('sha256sums.txt', …)`)
 * deliberately bypass this.
 */
function publishRelease(asset: string, bytes: Uint8Array): void {
  publish(asset, bytes)
  publish('sha256sums.txt', Buffer.from(`${sha256(bytes)}  ${asset}\n`))
}

beforeAll(async () => {
  const root = tempDir('qialike-fixture-')
  fixtureRoot = root
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
  //
  // The two are reached under DIFFERENT hostnames on purpose: the installer names the
  // host it chose, and `127.0.0.1` twice would make "which one won" unassertable.
  // `localhost` resolves to the same loopback listener (verified), so this costs
  // nothing but makes the decision visible.
  for (const [shape, host, assign] of [
    ['github', '127.0.0.1', (base: string) => { fixtureBase = base }],
    ['gitcode', 'localhost', (base: string) => { mirrorBase = base }],
  ] as const) {
    fixtureChildren.push(Bun.spawn(['python3', script, root, shape], { stdout: 'ignore', stderr: 'ignore' }))
    const portFile = join(root, `port-${shape}`)
    const deadline = Date.now() + 10_000
    while (!existsSync(portFile) && Date.now() < deadline) await Bun.sleep(50)
    if (!existsSync(portFile)) throw new Error(`the ${shape} fixture server never reported a port`)
    assign(`http://${host}:${readFileSync(portFile, 'utf8').trim()}`)
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
    // A complete release: the asset and the manifest that vouches for it.
    publishRelease(ASSET!, bytes)

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
    publishRelease('qialike-windows-x64.zip', stubArchive(work, 'zip', 'qialike.exe', TAG))

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
    // A manifest that lists this asset with a digest the bytes do not have. Unlike a
    // MISSING manifest, this is not a reason to try another host: bytes that contradict
    // their published digest are corruption or substitution.
    publish('sha256sums.txt', Buffer.from(`${'0'.repeat(64)}  ${ASSET}\n`))

    const home = makeHome()
    const { status, output } = install(home)

    expect(status).not.toBe(0)
    expect(output).toContain(`SHA256 mismatch for ${ASSET}`)
    expect(existsSync(join(home, '.dsh', 'bin', INNER))).toBe(false)
  })

  test('a release with no manifest is refused rather than installed unverified', () => {
    const work = tempDir('qialike-fixture-manifest-missing-')
    // The bytes are right there and intact; only the manifest that could vouch for
    // them is missing. Installing anyway would mean the one check standing between a
    // release host and the user's shell silently did nothing.
    publish(ASSET!, stubArchive(work, KIND, INNER, TAG))
    // Explicitly unpublished, not merely not-published: the fixture directory is shared
    // across tests, so a case that needs an ABSENT manifest has to remove whatever a
    // previous case left there.
    publish('sha256sums.txt', undefined)

    const home = makeHome()
    const { status, output } = install(home)

    expect(status).not.toBe(0)
    expect(output).toContain('refusing to install unverified bytes')
    // Refusing without naming the way out leaves the user stuck, so the override has
    // to be in the message.
    expect(output).toContain('QIALIKE_ALLOW_UNVERIFIED=1')
    expect(existsSync(join(home, '.dsh', 'bin', INNER))).toBe(false)
    // Nothing half-done: no PATH line either.
    expect(readFileSync(join(home, '.bashrc'), 'utf8')).toBe('# mine\n')
  })

  test('a manifest that does not list this asset proves nothing about it', () => {
    const work = tempDir('qialike-fixture-manifest-unlisted-')
    publish(ASSET!, stubArchive(work, KIND, INNER, TAG))
    // A manifest for some other platform: present, well-formed, and silent about the
    // bytes we were served.
    publish('sha256sums.txt', Buffer.from(`${'a'.repeat(64)}  qialike-other-x64.tar.gz\n`))

    const home = makeHome()
    const { status, output } = install(home)

    expect(status).not.toBe(0)
    expect(output).toContain('refusing to install unverified bytes')
    expect(existsSync(join(home, '.dsh', 'bin', INNER))).toBe(false)
  })

  test('QIALIKE_ALLOW_UNVERIFIED=1 installs anyway, and says so', () => {
    const work = tempDir('qialike-fixture-manifest-optout-')
    publish(ASSET!, stubArchive(work, KIND, INNER, TAG))
    // Same shared-fixture caveat as the refusal case above: absent means removed.
    publish('sha256sums.txt', undefined)

    const home = makeHome()
    const { status, output } = install(home, [], { QIALIKE_ALLOW_UNVERIFIED: '1' })

    expect(status, output).toBe(0)
    expect(output).toContain('WITHOUT integrity verification')
    expect(existsSync(join(home, '.dsh', 'bin', INNER))).toBe(true)
  })

  test('an asset that disagrees with its tag is reported, but the install still succeeds', () => {
    const work = tempDir('qialike-fixture-d-')
    // The archive says 0.6.8 while the release tag is 0.6.9.
    publishRelease(ASSET!, stubArchive(work, KIND, INNER, '0.6.8'))

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
    publishRelease(ASSET!, stubArchive(work, KIND, INNER, TAG))

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

  test('an unreachable mirror is named, and the primary installs anyway', () => {
    const work = tempDir('qialike-fixture-primary-')
    publishRelease(ASSET!, stubArchive(work, KIND, INNER, TAG))

    const home = makeHome()
    const { status, output } = install(
      home,
      [],
      // The mirror is listed but points at a dead port. It IS asked whether it is
      // there — case 2 is decided by connectivity, not by guessing — and the answer
      // costs one refused connection, because port 1 fails instantly. What must not
      // happen is the install depending on it.
      { QIALIKE_INSTALL_SOURCES: `${fixtureBase},http://127.0.0.1:1/releases` },
      null,
    )

    expect(status, output).toBe(0)
    // The canonical host answered, so this is the ordinary install: a note that names
    // the dead mirror, and NOT the mirror-lag warning (nothing is being read from it).
    expect(output).toContain('not reachable')
    expect(output).not.toContain('did not answer')
    // One reachable source means nothing to compare.
    expect(output).not.toContain('source speeds')
    expect(existsSync(join(home, '.dsh', 'bin', INNER))).toBe(true)
  })

  test('case 4: neither source answers — the update stops and writes nothing at all', () => {
    // The user-visible half of the policy: with no reachable source there is nothing
    // to download, nothing to fall back to, and nothing that may be touched. Both
    // ports refuse immediately, so this is about the decision, not a timeout budget.
    const home = makeHome()
    const rc = join(home, '.bashrc')
    writeFileSync(rc, '# mine\n')

    const { status, output } = install(
      home,
      [],
      { QIALIKE_INSTALL_SOURCES: 'http://127.0.0.1:1/releases,http://127.0.0.1:2/releases' },
      null,
    )

    // Its own exit status (3), which is how the automatic updater tells this apart
    // from a failed install and keeps the installed version instead of reporting.
    expect(status, output).toBe(3)
    expect(output).toContain('no release source is reachable')
    expect(output).toContain('nothing was installed')
    // Both hosts are named, so the user can see it was not one bad host.
    expect(output).toContain('http://127.0.0.1:1/releases')
    expect(output).toContain('http://127.0.0.1:2/releases')
    // Nothing was written: no install dir, no PATH line, no archive.
    expect(existsSync(join(home, '.dsh'))).toBe(false)
    expect(readFileSync(rc, 'utf8')).toBe('# mine\n')
    expect(output).not.toContain('installing qialike')
  })

  test('an explicit --base-url is the ONLY source, so there is no silent fallback', () => {
    // A configured host must be the whole truth: the public mirrors are not appended
    // to it, or a deliberately dead host would be papered over and this would install
    // something the operator did not ask for. With that one host down, the policy's
    // fourth case applies — nothing is installed and the public hosts are never named.
    const home = makeHome()
    publish(ASSET!, undefined)

    const { status, output } = install(home, [], { QIALIKE_VERSION: TAG }, 'http://127.0.0.1:1/releases')

    expect(status, output).toBe(3)
    expect(output).toContain('no release source is reachable')
    expect(output).toContain('http://127.0.0.1:1/releases')
    expect(output).not.toContain('gitcode.com')
    expect(output).not.toContain('github.com')
    expect(existsSync(join(home, '.dsh', 'bin'))).toBe(false)
  })
})

describe.skipIf(TARGET === undefined || ASSET === undefined)('with two sources the fastest wins, not the first that answered', () => {
  /** Make one shape stall on the BODY only (the probe still answers at once). */
  function slow(shape: 'github' | 'gitcode', on: boolean): void {
    const flag = join(fixtureRoot, `slow-${shape}`)
    if (on) writeFileSync(flag, '1')
    else rmSync(flag, { force: true })
  }

  /** Both fixture hosts as a source list: github first, mirror second. */
  const bothSources = () => `${fixtureBase},${mirrorBase}|${mirrorBase}/api/latest`

  test('a primary that is only slow for the body loses to the mirror', () => {
    // The reason this feature exists: the probe to the primary SUCCEEDS (it reads a
    // 302 and never asks for the body), so reachability alone would pick it and then
    // crawl. Sampling the real asset is the only thing that can tell them apart.
    const work = tempDir('qialike-fixture-speed-')
    publishRelease(ASSET!, stubArchive(work, KIND, INNER, TAG))
    slow('github', true)
    try {
      const home = makeHome()
      const { status, output } = install(home, [], { QIALIKE_INSTALL_SOURCES: bothSources() }, null)

      expect(status, output).toBe(0)
      expect(output).toContain('source speeds')
      // The mirror is the fast one, and it is the one the download used. Named by host:
      // the two fixtures are the same listener under different names.
      expect(output).toContain('downloading from localhost')
      expect(spawnSync(join(home, '.dsh', 'bin', INNER), ['--version'], { encoding: 'utf8' }).stdout.trim()).toBe(`qialike ${TAG}`)
    } finally {
      slow('github', false)
    }
  })

  test('a mirror that cannot serve the tag is never chosen, however fast it looks', () => {
    // A lagging mirror 404s this tag. Measuring must treat that as "not a candidate"
    // rather than as a winner, or the install would fail on the mirror and only then
    // retry — which is the retry the measurement exists to avoid.
    const work = tempDir('qialike-fixture-speed2-')
    publishRelease(ASSET!, stubArchive(work, KIND, INNER, TAG))
    slow('github', true)
    try {
      const home = makeHome()
      // The mirror's base points at a path the fixture answers 404 for, so it can be
      // measured (fast) but never downloaded from.
      const { status, output } = install(home, [], {
        QIALIKE_INSTALL_SOURCES: `${fixtureBase},${mirrorBase}/empty|${mirrorBase}/api/latest`,
      }, null)

      expect(status, output).toBe(0)
      expect(output).toContain('unavailable')
      expect(output).toContain('downloading from 127.0.0.1')
    } finally {
      slow('github', false)
    }
  })

  test('a single source is never compared (there is nothing to compare against)', () => {
    // `--source github` / `--source gitcode` / `--base-url` all resolve to exactly one
    // host, and that is the case this covers: one source means no sampling, no extra
    // request and no message. (`--source`'s own parsing — including that a bare
    // gitcode base still gets its API derived — is pinned offline in
    // `install-script.test.ts`; a live `--source gitcode` here would download from the
    // real mirror, which this suite must never do.)
    const work = tempDir('qialike-fixture-speed3-')
    publishRelease(ASSET!, stubArchive(work, KIND, INNER, TAG))

    // (i) `--base-url`, redirect-shaped host: one source, resolved through its 302.
    const one = makeHome()
    const first = install(one, [], {}, fixtureBase)
    expect(first.status, first.output).toBe(0)
    expect(first.output).not.toContain('source speeds')
    expect(first.output).not.toContain('downloading from')

    // (ii) One host as a full spec WITH its API — the shape `--source gitcode` resolves
    // to, since a mirror has no `latest` redirect and so needs its API to be resolvable
    // at all.
    const two = makeHome()
    const second = install(two, [], { QIALIKE_INSTALL_SOURCES: `${mirrorBase}|${mirrorBase}/api/latest` }, null)
    expect(second.status, second.output).toBe(0)
    expect(second.output).not.toContain('source speeds')
    expect(second.output).not.toContain('downloading from')
    expect(existsSync(join(two, '.dsh', 'bin', INNER))).toBe(true)
  })

  test('the comparison can be turned off, restoring the probe order', () => {
    // The escape hatch, and the reason the older order tests keep their meaning: with
    // MEASURE=0 nothing is sampled and the first source that answered is used.
    const work = tempDir('qialike-fixture-speed4-')
    publishRelease(ASSET!, stubArchive(work, KIND, INNER, TAG))
    slow('github', true)
    try {
      const home = makeHome()
      const { status, output } = install(home, [], {
        QIALIKE_INSTALL_SOURCES: bothSources(),
        QIALIKE_INSTALL_MEASURE: '0',
      }, null)

      expect(status, output).toBe(0)
      expect(output).not.toContain('source speeds')
      expect(output).not.toContain('downloading from')
    } finally {
      slow('github', false)
    }
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
    publishRelease(ASSET!, stubArchive(work, KIND, INNER, TAG))

    const out: string[] = []
    const err: string[] = []
    const code = runUpgrade(['--check'], {
      installed: PATCH_BELOW,
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
    publishRelease(ASSET!, stubArchive(work, KIND, INNER, TAG))
    // The fixture already serves the REAL installer at /install (see `beforeAll`),
    // and this case must never fetch it — that is half of what is being pinned.

    const out: string[] = []
    const err: string[] = []
    const code = runUpgrade(['--auto', '--json'], {
      installed: PATCH_BELOW,
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
      installed: PATCH_BELOW,
      newest: TAG,
      canSelfInstall: false,
      downloads: [`${fixtureBase}/download/${TAG}/${ASSET}`],
    })
    const notice = out.slice(0, -1).join('\n')
    expect(notice).toContain(`qialike ${TAG} is available (you have ${PATCH_BELOW})`)
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
      installed: PATCH_BELOW,
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
      installed: PATCH_BELOW,
      newest: null,
      relation: null,
      canSelfInstall: false,
      downloads: ['http://127.0.0.1:1/releases'],
    })
  })
})

/**
 * The automatic updater does not download anything itself: it fetches `/install` and
 * pipes it to bash. These cases therefore execute the REAL script through the REAL
 * pipe, which is also what runs on macOS.
 *
 * Coverage boundary worth knowing (it is how a macOS abort shipped): the bash here is
 * the HOST's, and the class of failure that broke macOS was a bash-3.2-only rule about
 * empty arrays — invisible on bash >= 4.4 whatever the script contains. The portable
 * guard for that is the static check in `tests/install-bundle.test.ts`; what these
 * cases add is that the pipe, the environment hand-off and the placement still work
 * end to end.
 */
describe.skipIf(TARGET === undefined || ASSET === undefined)('the upgrade path runs the real installer over a real pipe', () => {
  test('upgrade() fetches /install, pipes it to bash, and reports what landed', () => {
    const work = tempDir('qialike-fixture-e-')
    publishRelease(ASSET!, stubArchive(work, KIND, INNER, TAG))

    const home = makeHome()
    const dir = join(home, '.dsh', 'bin')
    mkdirSync(dir, { recursive: true })
    // A managed copy, because upgrade() refuses to install over nothing.
    writeFileSync(join(dir, 'qialike'), `#!/bin/sh\necho "qialike ${PATCH_BELOW}"\n`)
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

  test('an unverifiable release stops the upgrade, and leaves the install alone', () => {
    const work = tempDir('qialike-fixture-upgrade-unverified-')
    // The asset is served; the manifest that could vouch for it is not.
    publish(ASSET!, stubArchive(work, KIND, INNER, TAG))
    // Explicitly removed: the fixture directory is shared with the cases above.
    publish('sha256sums.txt', undefined)

    const home = makeHome()
    const dir = join(home, '.dsh', 'bin')
    mkdirSync(dir, { recursive: true })
    const managed = join(dir, 'qialike')
    writeFileSync(managed, `#!/bin/sh\necho "qialike ${PATCH_BELOW}"\n`)
    chmodSync(managed, 0o755)

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

    // The updater downloads nothing itself: it fetches `/install` and pipes it to bash,
    // so the installer's refusal is the only thing standing between an unverifiable
    // release and the user's machine. This pins that the delegation really carries the
    // check — "the updater verifies too" is true by construction, and a construction is
    // exactly the kind of claim that quietly stops being true.
    expect(result.ok).toBe(false)
    expect(result.error).toContain('QIALIKE_ALLOW_UNVERIFIED')
    // The point of refusing: what is already installed is untouched.
    expect(spawnSync(managed, ['--version'], { encoding: 'utf8' }).stdout.trim()).toBe(`qialike ${PATCH_BELOW}`)
  })

  const binary = BINARY_CANDIDATES.find((path) => existsSync(path))
  test.skipIf(binary === undefined)('--auto installs a patch through the real binary', () => {
    // The strongest form available offline: the REAL artifact runs the policy, the
    // resolution, the installer fetch and the replacement, against a local host.
    const work = tempDir('qialike-fixture-f-')
    publishRelease(ASSET!, stubArchive(work, KIND, INNER, TAG))

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
