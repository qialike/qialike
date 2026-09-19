/**
 * qialike build-time patch — P1-B (policy text) + P3-A (temp hygiene).
 *
 * WHY THIS CARRIER: `deepseek-harness` is upstream and stays untouched, so every
 * harness-side fix is applied here, to the vendored `lib/` copies that
 * `pnpm build --single` stages under `apps/tui-bin/x/`. Anchors are literal and
 * asserted; a re-vendored harness that moved them fails the build loudly.
 *
 * P1-B — the `workspace-write` policy sentence was a hardcoded claim ("Some
 * platform temporary areas may also be writable") that the fs fence no longer
 * honours now that Windows grants the workspace root alone: the prompt asserted
 * a writable area the enforcement layer denies, which is exactly the kind of
 * drift that makes a model plan a write the sandbox then refuses. The sentence
 * is instead derived from `writableRoots(policy)` — the same allow-list the
 * fence enforces — so the two cannot disagree again.
 *
 * P3-A — `sandbox-local` creates one private temp directory per session
 * (`mkdtempSync(join(tmpdir(), 'dsh-'))`) and removes it on a clean teardown;
 * a crash skips that, and nothing else reclaims the residue. This machine's
 * shared temp tree held 154 `dsh-*` entries after three days. The sweep added
 * here is deliberately double-guarded (older than 72 h AND older than the
 * current boot) so it can never race a live session.
 */

import { readFileSync, writeFileSync } from 'node:fs';

/** Idempotency marker of the P1-B policy-text edit. */
export const POLICY_ALLOWSET_MARKER = 'qialike: derive this sentence from the SAME allow-list';
/** Idempotency marker of the P3-A temp-sweep edit. */
export const TEMP_SWEEP_MARKER = 'sweepStaleTempEntries';

const occurrences = (haystack, needle) => haystack.split(needle).length - 1;

/**
 * Apply anchored edits to one file. Each edit is skipped when its marker is
 * already present (idempotency) and otherwise requires its anchor exactly once.
 * @param file - absolute path of the file to edit.
 * @param edits - the edits, in order.
 * @param readFile - injected reader.
 * @param writeFile - injected writer.
 * @returns true when the file was modified.
 */
function applyEdits(file, edits, readFile, writeFile) {
    let source = readFile(file, 'utf8');
    let changed = false;
    for (const edit of edits) {
        if (source.includes(edit.marker)) continue;
        const anchorCount = occurrences(source, edit.anchor);
        if (anchorCount !== 1) {
            throw new Error(
                `policy-and-hygiene: ${edit.name} anchor not found exactly once in ${file} (found ${anchorCount});`
                + ' re-check apps/tui-bin/harness-patches/policy-and-hygiene.mjs against the harness version',
            );
        }
        source = source.replace(edit.anchor, edit.text);
        changed = true;
    }
    if (changed) writeFile(file, source, 'utf8');
    return changed;
}

/** P1-B: the `workspace-write` sentence, generated from the enforced allow-list. */
function policyEdits() {
    const text = [
        '\t\tcase "workspace-write": {',
        '\t\t\t// qialike: derive this sentence from the SAME allow-list the fs fence',
        '\t\t\t// enforces. It used to assert that "some platform temporary areas may',
        '\t\t\t// also be writable", which stopped being true on Windows once the',
        '\t\t\t// fence was narrowed to the workspace root.',
        '\t\t\tconst roots = writableRoots(policy);',
        '\t\t\tconst listed = roots.map((root) => JSON.stringify(root)).join(", ");',
        '\t\t\treturn `Current DSH file policy: workspace-write. Any available operation enforced by the DSH file sandbox may modify files under: ${listed}. The platform shell layer may additionally allow one session-private temporary directory; no other location is writable.`;',
        '\t\t}',
    ].join('\n');
    return [
        {
            name: 'policy allow-list import',
            marker: 'writableRoots } from "@deepseek-ai/dsh-sandbox"',
            anchor: 'import { canonicalPath } from "@deepseek-ai/dsh-sandbox";',
            text: 'import { canonicalPath, writableRoots } from "@deepseek-ai/dsh-sandbox";',
        },
        {
            name: 'policy allow-list sentence',
            marker: POLICY_ALLOWSET_MARKER,
            anchor: '\t\tcase "workspace-write": return `Current DSH file policy: workspace-write. Any available operation enforced by the DSH file sandbox may modify files under the session workspace: ${JSON.stringify(policy.workspaceRoot)}. Some platform temporary areas may also be writable.`;',
            text,
        },
    ];
}

/**
 * P3-A: the sweep plus its once-per-process guard.
 * @param indent - one indentation unit of the target file.
 * @param q - the target file's quote character.
 * @returns the edits for one file.
 */
function hygieneEdits(indent, q) {
    const qq = (value) => `${q}${value}${q}`;
    const helper = [
        '/** qialike P3-A: whether the stale-temp sweep already ran in this process. */',
        'let sweptStaleTempEntries = false;',
        '/**',
        ' * qialike P3-A: reclaim the `dsh-*` entries the platform temp root is holding.',
        ' *',
        ' * `revokeAclGrants()` removes a session\'s private temp directory on a clean',
        ' * teardown, but a crash skips it and nothing else ever reclaims the residue:',
        ' * this machine\'s shared temp tree held 154 `dsh-*` entries after three days',
        ' * (session temps, spill roots, subprocess spools, log frames).',
        ' *',
        ' * Two guards keep the sweep off live sessions: an entry must be older than',
        ' * {@link STALE_TEMP_MAX_AGE_MS}, and it must predate the current boot — no',
        ' * process alive today can own a directory older than the boot, so a live',
        ' * session\'s directories are never eligible. Every failure is ignored by',
        ' * design: an entry another process holds open is left for the next sweep',
        ' * rather than failing the session that triggered this one.',
        ' * @param root - the platform temp root to sweep.',
        ' */',
        'const STALE_TEMP_MAX_AGE_MS = 72 * 60 * 60 * 1000;',
        'function sweepStaleTempEntries(root) {',
        `${indent}let entries;`,
        `${indent}try {`,
        `${indent}${indent}entries = readdirSync(root, { withFileTypes: true });`,
        `${indent}} catch {`,
        `${indent}${indent}return;`,
        `${indent}}`,
        `${indent}const cutoff = Math.max(Date.now() - STALE_TEMP_MAX_AGE_MS, Date.now() - uptime() * 1000);`,
        `${indent}for (const entry of entries) {`,
        `${indent}${indent}if (!entry.name.startsWith(${qq('dsh-')})) continue;`,
        `${indent}${indent}const path = join(root, entry.name);`,
        `${indent}${indent}try {`,
        `${indent}${indent}${indent}if (statSync(path).mtimeMs >= cutoff) continue;`,
        `${indent}${indent}${indent}rmSync(path, { recursive: true, force: true });`,
        `${indent}${indent}} catch {`,
        `${indent}${indent}${indent}// A live owner, or a path this process may not remove: leave it.`,
        `${indent}${indent}}`,
        `${indent}}`,
        '}',
        '',
    ].join('\n');
    const call = [
        `${indent}${indent}if (!sweptStaleTempEntries) {`,
        `${indent}${indent}${indent}sweptStaleTempEntries = true;`,
        `${indent}${indent}${indent}${TEMP_SWEEP_MARKER}(tmpdir());`,
        `${indent}${indent}}`,
        '',
    ].join('\n');
    return [
        {
            name: 'temp-sweep fs import',
            marker: 'readdirSync, rmSync, statSync',
            anchor: `import { existsSync, mkdtempSync, rmSync } from ${qq('node:fs')};`,
            text: `import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from ${qq('node:fs')};`,
        },
        {
            name: 'temp-sweep os import',
            marker: `import { tmpdir, uptime } from ${qq('node:os')};`,
            anchor: `import { tmpdir } from ${qq('node:os')};`,
            text: `import { tmpdir, uptime } from ${qq('node:os')};`,
        },
        {
            name: 'temp-sweep helper',
            marker: `${TEMP_SWEEP_MARKER}(root) {`,
            anchor: q === '"'
                ? 'var LocalSandboxProvider = class extends SandboxProvider {'
                : 'export class LocalSandboxProvider extends SandboxProvider {',
            text: `${helper}${q === '"' ? 'var LocalSandboxProvider = class extends SandboxProvider {' : 'export class LocalSandboxProvider extends SandboxProvider {'}`,
        },
        {
            name: 'temp-sweep call',
            marker: `${TEMP_SWEEP_MARKER}(tmpdir());`,
            anchor: `${indent}${indent}const tempDir = mkdtempSync(join(tmpdir(), ${qq('dsh-')}));`,
            text: `${call}${indent}${indent}const tempDir = mkdtempSync(join(tmpdir(), ${qq('dsh-')}));`,
        },
    ];
}

/**
 * Apply the P1-B + P3-A patch to the vendored `lib/` copies.
 * @param options - patch options.
 * @param options.root - the vendored `apps/tui-bin/x` directory.
 * @param options.dirs - explicit file paths, for a tree whose package
 *   directories are not named the vendored way (the npm install).
 * @param options.readFile - injected reader (defaults to node:fs).
 * @param options.writeFile - injected writer (defaults to node:fs).
 * @param options.log - progress sink.
 * @returns the list of files actually modified.
 */
export function patchPolicyAndHygiene({ root, dirs, readFile, writeFile, log = () => {} }) {
    const reader = readFile ?? readFileSync;
    const writer = writeFile ?? writeFileSync;
    const targets = [
        { file: dirs?.policy ?? `${root}/-deepseek-ai-dsh-sandbox-policy/lib/index.js`, edits: policyEdits() },
        { file: dirs?.sandboxLocal ?? `${root}/-deepseek-ai-dsh-sandbox-local/lib/index.js`, edits: hygieneEdits('\t', '"') },
    ];
    const changed = [];
    for (const { file, edits } of targets) {
        if (applyEdits(file, edits, reader, writer)) {
            changed.push(file);
            log(`policy-and-hygiene: patched ${file}`);
        } else {
            log(`policy-and-hygiene: already patched ${file}`);
        }
    }
    return changed;
}
