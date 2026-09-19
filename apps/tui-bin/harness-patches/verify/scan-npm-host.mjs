/**
 * Inventory the downstream patches applied to the npm-installed DSH host.
 * Walks the install's `@deepseek-ai` packages and reports every file carrying a
 * patch marker, so the revert target list is measured rather than remembered.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2] ?? 'C:/Users/43418/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const markers = [
    'qialike:',
    'setTokenIntegrityLow',
    'setLowIntegrityLabel',
    'sweepStaleTempEntries',
    'process.platform === "win32" ? [policy.workspaceRoot]',
]

const hits = []
const walk = (dir) => {
    let entries
    try {
        entries = readdirSync(dir, { withFileTypes: true })
    } catch {
        return
    }
    for (const entry of entries) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules') continue
            walk(path)
            continue
        }
        if (!entry.name.endsWith('.js')) continue
        if (statSync(path).size > 8_000_000) continue
        let text
        try {
            text = readFileSync(path, 'utf8')
        } catch {
            continue
        }
        const found = markers.filter((marker) => text.includes(marker))
        if (found.length > 0) hits.push({ path: path.replace(`${root}/`, ''), found })
    }
}

walk(root)
console.log(JSON.stringify({ scannedRoot: root, patchedFiles: hits.length }, null, 2))
for (const hit of hits) console.log(`${hit.path}\n    markers: ${hit.found.join(' | ')}`)
