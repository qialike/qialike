/**
 * Airtight npm-host integrity check: every JavaScript file the published DSH
 * host ships is compared byte-for-byte against the SAME file in the harness
 * checkout it was built from (`repository.directory` in each package.json maps
 * the install back to the monorepo path), so a patch that carries no marker —
 * or one applied by an earlier session — still shows up as a mismatch.
 *
 * package.json is deliberately NOT compared: publishing rewrites it
 * (`workspace:^` → concrete versions), so a difference there is expected.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const HOST = process.argv[2] ?? 'C:/Users/43418/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const CHECKOUT = process.argv[3] ?? 'C:/deepseek/deepseek-harness'

const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const walk = (dir) => {
    const out = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules') continue
            out.push(...walk(path))
            continue
        }
        out.push(path)
    }
    return out
}

const report = { packages: 0, mapped: 0, compared: 0, identical: 0, mismatches: [], missingInCheckout: [], unmapped: [] }
for (const entry of readdirSync(HOST, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('dsh-')) continue
    const packageDir = join(HOST, entry.name)
    const manifestPath = join(packageDir, 'package.json')
    if (!existsSync(manifestPath)) continue
    report.packages += 1
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const directory = manifest.repository?.directory
    if (typeof directory !== 'string') {
        report.unmapped.push(entry.name)
        continue
    }
    const sourceRoot = join(CHECKOUT, directory)
    if (!existsSync(sourceRoot)) {
        report.unmapped.push(`${entry.name} -> ${directory}`)
        continue
    }
    report.mapped += 1
    for (const file of walk(packageDir)) {
        const rel = relative(packageDir, file)
        if (rel === 'package.json' || !file.endsWith('.js')) continue
        const source = join(sourceRoot, rel)
        if (!existsSync(source)) {
            report.missingInCheckout.push(`${entry.name}/${rel}`)
            continue
        }
        report.compared += 1
        if (sha(file) === sha(source)) report.identical += 1
        else report.mismatches.push(`${entry.name}/${rel}`)
    }
}

console.log(JSON.stringify({
    packages: report.packages,
    mapped: report.mapped,
    jsFilesCompared: report.compared,
    identical: report.identical,
    mismatches: report.mismatches,
    publishedOnly: report.missingInCheckout.length,
    unmapped: report.unmapped,
}, null, 2))
