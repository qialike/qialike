/**
 * P3-A verification: exercise the PATCHED sweep source directly.
 *
 * The sweep is module-private and only runs from the provider's first
 * materializeAclGrant call, which needs a full cordis context — so this test
 * lifts the function out of the patched file, evaluates it with the same
 * imports, and runs it against a fake temp root that carries the exact cases the
 * two guards exist for:
 *   - a fresh `dsh-*` entry: never touched (a live session's directory);
 *   - an entry older than 72 h but created after the boot: never touched;
 *   - an entry older than the boot AND older than 72 h: reclaimed;
 *   - a non-`dsh-` entry older than both: never touched.
 */
import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir, uptime } from 'node:os';
import { join } from 'node:path';

const file = process.argv[2]
if (file === undefined) throw new Error('usage: bun sweep-test.mjs <patched sandbox-local lib/index.js>')
const source = readFileSync(file, 'utf8')
const start = source.indexOf('function sweepStaleTempEntries(root) {')
if (start === -1) throw new Error('the patched sweep function is missing')
const end = source.indexOf('\n}\n', start)
if (end === -1) throw new Error('cannot find the end of the patched sweep function')
const body = source.slice(start, end + 3)
const threshold = /const STALE_TEMP_MAX_AGE_MS = ([^;]+);/.exec(source)
if (threshold === null) throw new Error('the patched age threshold is missing')
const STALE_TEMP_MAX_AGE_MS = eval(threshold[1])
const sweep = new Function('readdirSync', 'statSync', 'rmSync', 'join', 'uptime', 'STALE_TEMP_MAX_AGE_MS', `${body}\nreturn sweepStaleTempEntries;`)(
    readdirSync, statSync, rmSync, join, uptime, STALE_TEMP_MAX_AGE_MS,
)

const root = mkdtempSync(join(tmpdir(), 'sweep-lab-'))
const now = Date.now()
const bootTime = now - uptime() * 1000
const make = (name, mtimeMs) => {
    const path = join(root, name)
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'payload.txt'), 'x')
    utimesSync(path, new Date(mtimeMs), new Date(mtimeMs))
}
make('dsh-fresh', now - 60 * 1000)
make('dsh-after-boot', Math.max(bootTime + 60 * 1000, now - 100 * 60 * 60 * 1000))
make('dsh-stale', Math.min(bootTime - 60 * 1000, now - 200 * 60 * 60 * 1000))
mkdirSync(join(root, 'other-old'), { recursive: true })
utimesSync(join(root, 'other-old'), new Date(now - 200 * 60 * 60 * 1000), new Date(now - 200 * 60 * 60 * 1000))

sweep(root)

const surviving = readdirSync(root).sort()
const expectedStaleRemoved = statSync(join(root, 'dsh-after-boot')).isDirectory() && !surviving.includes('dsh-stale')
const report = {
    uptimeHours: Math.round(uptime() / 3600),
    ageThresholdHours: STALE_TEMP_MAX_AGE_MS / 3600000,
    surviving,
    freshKept: surviving.includes('dsh-fresh'),
    afterBootKept: surviving.includes('dsh-after-boot'),
    staleRemoved: !surviving.includes('dsh-stale'),
    foreignKept: surviving.includes('other-old'),
}
rmSync(root, { recursive: true, force: true })
console.log(JSON.stringify(report, null, 2))
if (!report.freshKept || !report.afterBootKept || !report.staleRemoved || !report.foreignKept || !expectedStaleRemoved) {
    throw new Error('sweep behaviour does not match the documented guards')
}
