/**
 * P3-A against the real residue: run the PATCHED sweep source over the actual
 * platform temp root, listing what is eligible (dry run) before reclaiming it.
 * The boot guard is what makes this safe: no process alive today can own a
 * directory older than the current boot, and every `dsh-*` entry measured on
 * this machine predates it (uptime ~2.6 h, oldest entry 3 days).
 */
import { readdirSync, statSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir, uptime } from 'node:os';
import { join } from 'node:path';

const file = 'C:/deepseek/qialike/apps/tui-bin/x/-deepseek-ai-dsh-sandbox-local/lib/index.js'
const mode = process.argv[2] ?? 'dry'
const source = readFileSync(file, 'utf8')
const start = source.indexOf('function sweepStaleTempEntries(root) {')
if (start === -1) throw new Error('the patched sweep function is missing')
const end = source.indexOf('\n}\n', start)
const body = source.slice(start, end + 3)
const STALE_TEMP_MAX_AGE_MS = eval(/const STALE_TEMP_MAX_AGE_MS = ([^;]+);/.exec(source)[1])
const sweep = new Function('readdirSync', 'statSync', 'rmSync', 'join', 'uptime', 'STALE_TEMP_MAX_AGE_MS', `${body}\nreturn sweepStaleTempEntries;`)(
    readdirSync, statSync, rmSync, join, uptime, STALE_TEMP_MAX_AGE_MS,
)

const root = tmpdir()
const cutoff = Math.max(Date.now() - STALE_TEMP_MAX_AGE_MS, Date.now() - uptime() * 1000)
const sizeOf = (path) => {
    let total = 0
    const walk = (target) => {
        let stats
        try { stats = statSync(target) } catch { return }
        if (!stats.isDirectory()) { total += stats.size; return }
        for (const entry of readdirSync(target)) walk(join(target, entry))
    }
    walk(path)
    return total
}
const eligible = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.name.startsWith('dsh-'))
    .map((entry) => ({ name: entry.name, mtimeMs: statSync(join(root, entry.name)).mtimeMs }))
    .filter((entry) => entry.mtimeMs < cutoff)

const total = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.name.startsWith('dsh-')).length
console.log(JSON.stringify({
    mode,
    tempRoot: root,
    uptimeHours: Math.round(uptime() / 3600),
    cutoffIso: new Date(cutoff).toISOString(),
    dshEntries: total,
    eligible: eligible.length,
    oldestIso: new Date(Math.min(...eligible.map((entry) => entry.mtimeMs))).toISOString(),
    eligibleBytes: eligible.reduce((sum, entry) => sum + sizeOf(join(root, entry.name)), 0),
}, null, 2))

if (mode === 'apply') {
    sweep(root)
    const after = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.name.startsWith('dsh-')).length
    console.log(JSON.stringify({ reclaimed: total - after, remaining: after }))
}
