/**
 * qialike build-time patch — default imports of CJS-only packages.
 *
 * WHY THIS EXISTS. The harness compiles to ESM and relies on Node's CommonJS
 * interop, where
 *
 *     import rrulePackage from 'rrule'
 *
 * resolves through the package's `main` (a CJS build whose `module.exports` becomes
 * the default). Bun resolves the same specifier through `module` instead, and
 * `rrule`'s ESM build has named exports only, so the single-file compile dies with
 *
 *     No matching export in .../rrule/dist/esm/index.js for import "default"
 *
 * before any target is produced. `rrule` reached the composition in harness 0.2.2
 * (`@deepseek-ai/dsh-util-time` gained bounded Cron/RRULE recurrence), so this is a
 * new arrival rather than a regression in a previously-patched file.
 *
 * WHY A NAMESPACE IMPORT, and not a resolver alias. The dependency's ESM build DOES
 * export the two names the harness destructures (`Weekday`, `rrulestr`), so pointing
 * the import at the namespace is a one-token change with the same runtime meaning.
 * An alias would instead have to mirror or copy a second build of the package into
 * the farm — more moving parts for the same result — and `aliasUndici` only exists
 * because Bun *intercepts* that specifier and must be stepped around, which is not
 * the case here.
 *
 * The edit is anchored and asserted, like every other carrier: a rrule (or harness)
 * revision that spells the import differently fails the build loudly instead of
 * shipping a binary that cannot start.
 *
 * This edits `apps/tui-bin/x/**` (our transform of the harness's compiled `lib/`),
 * never the harness checkout.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/** Idempotency marker of the namespace-import rewrite. */
export const CJS_INTEROP_MARKER = 'qialike: namespace import — see harness-patches/cjs-interop.mjs';

/**
 * Rewrite one default import into a namespace import, in place.
 * @param file - absolute path of the vendored module.
 * @param specifier - the bare package specifier to convert.
 * @param readFile - injected reader.
 * @param writeFile - injected writer.
 * @returns true when the file was modified.
 */
function rewriteDefaultImport(file, specifier, readFile, writeFile) {
    const source = readFile(file, 'utf8');
    if (source.includes(CJS_INTEROP_MARKER)) return false;
    // Both quote styles, because tsdown's emitted quotes differ between the `lib/`
    // entry and the per-module copies under `lib/types/`.
    const pattern = new RegExp(
        `import\\s+(\\w+)\\s+from\\s+(["'])${specifier}\\2;?`,
        'g',
    );
    const matches = source.match(pattern) ?? [];
    if (matches.length !== 1) {
        throw new Error(
            `cjs-interop: expected exactly one \`import <name> from "${specifier}"\` in ${file} `
            + `(found ${matches.length}); re-check apps/tui-bin/harness-patches/cjs-interop.mjs `
            + 'against the harness version',
        );
    }
    const next = source.replace(pattern, (_match, name, quote) => (
        `/* ${CJS_INTEROP_MARKER} */\nimport * as ${name} from ${quote}${specifier}${quote};`
    ));
    writeFile(file, next, 'utf8');
    return true;
}

/**
 * Apply the CJS-interop rewrite to the vendored copies.
 * @param options - patch options.
 * @param options.root - the vendored `apps/tui-bin/x` directory.
 * @param options.readFile - injected reader (defaults to node:fs).
 * @param options.writeFile - injected writer (defaults to node:fs).
 * @param options.log - progress sink.
 * @returns the list of files actually modified.
 */
export function patchCjsInterop({ root, readFile, writeFile, log = () => {} }) {
    const reader = readFile ?? readFileSync;
    const writer = writeFile ?? writeFileSync;
    const targets = [
        // The compiled entry the bundle actually follows.
        { file: `${root}/-deepseek-ai-dsh-util-time/lib/index.js`, specifier: 'rrule' },
    ];
    const changed = [];
    for (const { file, specifier } of targets) {
        if (!existsSync(file)) {
            // A harness that stops shipping this module simply stops needing the
            // patch; that is not a build failure.
            log(`cjs-interop: ${file} not in the farm; nothing to patch`);
            continue;
        }
        if (rewriteDefaultImport(file, specifier, reader, writer)) {
            changed.push(file);
            log(`cjs-interop: patched the ${specifier} default import in ${file}`);
        } else {
            log(`cjs-interop: already patched ${file}`);
        }
    }
    return changed;
}
