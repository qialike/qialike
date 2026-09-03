/**
 * The models panel plugin (`tui-panel-models`): the `/models` dialog — a
 * provider/model picker, API-key management, and the "Add provider" flow —
 * matching the harness Settings → Models page in a TUI. Registers the
 * `connect` (fullscreen) panel and the `/models` command against the `tui`
 * service, consuming the `tuiModels` capability service.
 *
 * @module @yourname/dsh-tui-app/panels-models
 */

import { Box, Text } from 'ink'
import React from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { TuiService, ModelsOption, ProviderModelsEntry, Store } from '../index.tsx'
import { TUI_MODELS_SERVICE, type ModelsProviderOption, type ProviderTemplate, type TuiModelsService } from '../models.ts'
import { theme } from '../theme.ts'
import type { RawKey } from '../stdin.ts'

/** Stable Cordis plugin name. */
export const name = 'tui-panel-models'

/** The store service (see panels/conversation.tsx for the why-behind-the-seam). */
let store!: Store

/** The `tui` service (panel registration) and the models capability service. */
export const inject = ['tui', 'tuiModels']

/** The add-provider form's fields, in entry order (field 1 is the template dropdown). */
const PROVIDER_FORM_FIELDS: readonly string[] = [
  'route id (kebab-case)',
  'display name',
  'base URL',
  'API key',
  'model ids (comma-separated)',
]

/** Group configured providers into first-level entries (one per provider, its models in the second level). */
function buildProviderEntries(providers: readonly ModelsProviderOption[]): ProviderModelsEntry[] {
  return providers.map((p) => ({
    provider: p.provider,
    name: p.name,
    models: p.models.map((m) => ({
      provider: p.provider,
      model: m.id,
      label: m.name,
      ...(m.efforts === undefined ? {} : { efforts: m.efforts }),
      ...(m.defaultEffort === undefined ? {} : { defaultEffort: m.defaultEffort }),
    })),
  }))
}

/**
 * The `/models` dialog (opencode-style fullscreen modal): provider/model
 * picker, key status, "Add provider" flows. Reads all state from the store.
 */
function ModelsDialog(): React.JSX.Element {
  const [cursorOn, setCursorOn] = React.useState(true)
  React.useEffect(() => {
    const timer = setInterval(() => setCursorOn((on) => !on), 530)
    return () => clearInterval(timer)
  }, [])
  const block = <Text inverse={cursorOn}> </Text>
  const masked = '•'.repeat(store.secret.length)
  return (
    <Box flexDirection="column" height={store.rows} alignItems="center" justifyContent="center">
      <Box position="absolute" width="100%" height={store.rows} flexDirection="column">
        <Text backgroundColor={theme.bg} wrap="wrap">{' '.repeat(Math.max(0, store.width * store.rows))}</Text>
      </Box>
      <Box width={72} borderStyle="round" borderColor={theme.border} flexDirection="column" paddingX={1} paddingY={1}>
        {store.keyDialog ? (
          <>
            <Text color={theme.accent} bold>API key for {store.keyDialogName}</Text>
            <Text color={theme.primary}>{masked}{block}</Text>
            <Box marginTop={1}>
              <Text dimColor>{store.keyDialogConfigured ? 'replaces the current key · ' : ''}paste a single-line key · Enter save · Esc cancel</Text>
            </Box>
          </>
        ) : store.providerList ? (
          <>
            <Text color={theme.accent} bold>Add provider</Text>
            <Text dimColor>pick a provider to set or change its API key</Text>
            <Box borderStyle="round" borderColor={theme.accent} paddingX={1} marginY={1}>
              <Text color={theme.accent} bold>
                {store.providerListFilter !== '' ? `⌕ ${store.providerListFilter}` : '⌕ type to filter'}
                {block}
              </Text>
            </Box>
            <Box flexDirection="column" gap={0}>
              {(() => {
                const names = store.providerListFiltered
                // rows-15: the bordered filter box plus the two title lines and
                // the hint (with its top margin) must fit the terminal height,
                // or the top (title) line gets clipped like the model list's did.
                const listRows = Math.max(1, store.rows - 15)
                const start = Math.max(0, Math.min(
                  store.providerListIndex - Math.floor(listRows / 2),
                  Math.max(0, names.length - listRows),
                ))
                return names.slice(start, start + listRows).map((p, i) => {
                  const index = start + i
                  return (
                    <Text key={p.provider} color={index === store.providerListIndex ? theme.accent : undefined} inverse={index === store.providerListIndex}>
                      {index === store.providerListIndex ? '› ' : '  '}{p.name}
                      <Text dimColor>  </Text>
                      <Text color={p.configured ? theme.success : (p.needsBaseURL ? theme.info : theme.warning)}>
                        {p.configured ? '✓ key set' : (p.needsBaseURL ? 'endpoint required' : 'no key')}
                      </Text>
                    </Text>
                  )
                })
              })()}
              {store.providerListFiltered.length === 0 && <Text dimColor>no providers match "{store.providerListFilter}"</Text>}
            </Box>
            <Box marginTop={1}>
              <Text dimColor>↑/↓ · PgUp/PgDn · Home/End · Enter select · Esc clear/back</Text>
            </Box>
          </>
        ) : store.providerForm ? (
          <>
            <Text color={theme.accent} bold>Add a custom provider</Text>
            <Box flexDirection="column" marginTop={1}>
              <Text color={store.providerField === 0 ? theme.primary : undefined}>
                [ 1 ] provider: {store.providerTemplate < store.providerTemplates.length
                  ? store.providerTemplates[store.providerTemplate]?.name ?? ''
                  : 'Custom provider'}
                {store.providerField === 0 ? block : null}
              </Text>
              {PROVIDER_FORM_FIELDS.map((label, i) => {
                const field = i + 2
                return (
                  <Text key={label} color={field === store.providerField ? theme.primary : undefined}>
                    [ {field} ] {label}: {store.providerValues[i] ?? ''}
                    {field === store.providerField ? block : null}
                  </Text>
                )
              })}
            </Box>
            {store.providerFormError !== '' && <Text color={theme.error}>{store.providerFormError}</Text>}
            <Box marginTop={1}>
              <Text dimColor>↑/↓ choose provider · type fields · Enter next · Enter on last saves · Esc cancel</Text>
            </Box>
          </>
        ) : store.effortOpen ? (
          // Third level: the highlighted model's reasoning-effort picker
          // (shown when the model declares effort levels; confirming an effort
          // completes the model selection).
          <>
            <Text color={theme.accent} bold>Effort</Text>
            <Text dimColor>{store.effortLabel} · reasoning effort</Text>
            <Box flexDirection="column" gap={0} marginTop={1}>
              {store.effortChoices.map((effort, i) => (
                <Text key={effort.id} wrap="truncate"
                  color={i === store.effortIndex ? theme.accent : undefined}
                  inverse={i === store.effortIndex}>
                  {i === store.effortIndex ? '› ' : '  '}{effort.name}
                  {effort.description !== undefined && (
                    <Text dimColor> — {effort.description}</Text>
                  )}
                </Text>
              ))}
            </Box>
            <Box marginTop={1}>
              <Text dimColor>↑/↓ choose · number selects · Enter confirm · Esc back</Text>
            </Box>
          </>
        ) : store.modelScope !== '' ? (
          // Second level: the open provider's model list, live-filtered by the
          // `modelFilter` text (windowed so the highlight stays in view).
          <>
            <Text color={theme.accent} bold>{store.modelScopeName} models</Text>
            <Text dimColor>current: {store.modelFiltered[store.modelIndex]?.label ?? ''}</Text>
            <Box borderStyle="round" borderColor={theme.accent} paddingX={1} marginY={1}>
              <Text color={theme.accent} bold>
                {store.modelFilter !== '' ? `⌕ ${store.modelFilter}` : '⌕ type to filter'}
                {block}
              </Text>
            </Box>
            <Box flexDirection="column" gap={0}>
              {(() => {
                const list = store.modelFiltered
                // rows-15: the bordered filter box (marginY adds 2 rows) plus
                // title/current/hints (the hint carries a top margin) must fit
                // the terminal height, or the dialog overflows and the top
                // (title) line gets clipped.
                const listRows = Math.max(1, store.rows - 15)
                const start = Math.max(0, Math.min(
                  store.modelIndex - Math.floor(listRows / 2),
                  Math.max(0, list.length - listRows),
                ))
                return list.slice(start, start + listRows).map((m, i) => {
                  const index = start + i
                  return (
                    <Text key={`${m.provider}/${m.model}`} color={index === store.modelIndex ? theme.accent : undefined} inverse={index === store.modelIndex}>
                      {index === store.modelIndex ? '› ' : '  '}{m.label}
                    </Text>
                  )
                })
              })()}
              {store.modelFiltered.length === 0 && <Text dimColor>no models match "{store.modelFilter}"</Text>}
            </Box>
            <Box marginTop={1}>
              <Text dimColor>↑/↓ · PgUp/PgDn · Home/End · Enter save · Esc clear/back</Text>
            </Box>
          </>
        ) : (
          // First level: providers grouped with their models tucked underneath.
          <>
            <Text color={theme.accent} bold>Models</Text>
            <Text dimColor>current: {store.modelLabel !== '' ? store.modelLabel : 'not set'}</Text>
            <Box borderStyle="round" borderColor={theme.accent} paddingX={1} marginY={1}>
              <Text color={theme.accent} bold>
                {store.providerFilter !== '' ? `⌕ ${store.providerFilter}` : '⌕ type to filter'}
                {block}
              </Text>
            </Box>
            <Box flexDirection="column" gap={0}>
              {(() => {
                const list = store.providerFiltered
                const filtered = list.length < store.providers.length
                const listRows = Math.max(1, store.rows - 15)
                const start = Math.max(0, Math.min(
                  store.providerIndex - Math.floor(listRows / 2),
                  Math.max(0, list.length - listRows),
                ))
                const rows = list.slice(start, start + listRows).map((p, i) => {
                  const index = start + i
                  return (
                    <Text key={p.provider} color={index === store.providerIndex ? theme.accent : undefined} inverse={index === store.providerIndex}>
                      {index === store.providerIndex ? '› ' : '  '}{p.name}
                      <Text dimColor>  · {p.models.length} model{p.models.length === 1 ? '' : 's'}</Text>
                    </Text>
                  )
                })
                if (!filtered) {
                  rows.push(
                    <Text key="__add" color={store.providerIndex === store.providers.length ? theme.accent : undefined} inverse={store.providerIndex === store.providers.length}>
                      {store.providerIndex === store.providers.length ? '› ' : '  '}＋ Add provider
                      {store.providerTotal > 0 && (
                        <Text dimColor>  · {store.providerTotal} provider{store.providerTotal === 1 ? '' : 's'}</Text>
                      )}
                    </Text>,
                  )
                  rows.push(
                    <Text key="__add-custom" color={store.providerIndex === store.providers.length + 1 ? theme.accent : undefined} inverse={store.providerIndex === store.providers.length + 1}>
                      {store.providerIndex === store.providers.length + 1 ? '› ' : '  '}＋ Add a custom provider
                    </Text>,
                  )
                }
                return rows
              })()}
              {store.providerFiltered.length === 0 && <Text dimColor>no providers match "{store.providerFilter}"</Text>}
            </Box>
            {store.dialogNotice !== '' && <Text color={theme.warning}>{store.dialogNotice}</Text>}
            <Box marginTop={1}>
              <Text dimColor>↑/↓ · PgUp/PgDn · Home/End · Enter open models · Ctrl+D hide · Esc back</Text>
            </Box>
          </>
        )}
      </Box>
    </Box>
  )
}

/** Handle one key while the connect panel is active; returns true (consumed). */
function connectKey(k: RawKey): boolean {
  const char = k.char ?? ''
  if (store.keyDialog) {
    if (k.return) {
      const done = store.keyDialogDone()
      if (done !== null) store.keyDialogSubmit(done.provider, done.name, done.key)
    } else if (k.backspace || k.delete) {
      store.popSecret()
    } else if (k.escape || (k.ctrl && char === 'c')) {
      store.cancelKeyDialog()
    } else if (char) {
      store.pushSecret(char)
    }
    return true
  }
  if (store.providerList) {
    const page = Math.max(1, store.rows - 12)
    if (k.pageUp) { store.moveProviderListIndex(store.providerListIndex - page); return true }
    if (k.pageDown) { store.moveProviderListIndex(store.providerListIndex + page); return true }
    if (k.home) { store.moveProviderListIndex(0); return true }
    if (k.end) { store.moveProviderListIndex(store.providerListFiltered.length - 1); return true }
    if (k.upArrow) { store.bumpProviderListIndex(-1); return true }
    if (k.downArrow) { store.bumpProviderListIndex(1); return true }
    if (k.return) {
      const picked = store.selectProviderList()
      if (picked !== undefined) {
        // Deployment-configured providers (Azure/Cloudflare/Vertex…) need a
        // base URL the user must supply: open the pre-filled custom form
        // instead of the bare key dialog.
        if (picked.needsBaseURL) store.startProviderFormForTemplate(picked.provider)
        else store.openKeyDialog(picked.provider, picked.name, picked.configured)
      }
    } else if (k.escape || (k.ctrl && char === 'c')) {
      if (store.providerListFilter !== '') store.clearProviderListFilter()
      else store.cancelProviderList()
    } else if (k.backspace || k.delete) {
      store.providerListFilterBackspace()
    } else if (char) {
      store.providerListFilterType(char)
    }
    return true
  }
  if (store.providerForm) {
    if (store.providerField === 0 && (k.upArrow || k.downArrow)) {
      store.bumpProviderTemplate(k.upArrow ? -1 : 1)
      return true
    }
    if (k.return) {
      if (store.providerFormAdvance()) {
        const values = store.providerValues
        store.cancelProviderForm()
        store.providerFormSubmit({
          route: values[0] ?? '',
          displayName: values[1] ?? '',
          baseURL: values[2] ?? '',
          apiKey: values[3] ?? '',
          models: (values[4] ?? '').split(',').map((s) => s.trim()).filter((s) => s !== ''),
        })
      }
    } else if (k.backspace || k.delete) {
      store.providerFormBackspace()
    } else if (k.escape || (k.ctrl && char === 'c')) {
      store.cancelProviderForm()
    } else if (char) {
      store.providerFormType(char)
    }
    return true
  }
  if (store.effortOpen) {
    // Third level: pick a reasoning effort for the highlighted model
    // (Enter confirms and completes the selection; Esc returns to the list).
    const choices = store.effortChoices
    if (k.upArrow) { store.bumpEffortIndex(-1); return true }
    if (k.downArrow) { store.bumpEffortIndex(1); return true }
    if (k.return) {
      const option = store.modelFiltered[store.modelIndex]
      const effort = choices[store.effortIndex]?.id
      store.cancelConnect()
      if (option !== undefined && effort !== undefined) store.modelsSaveAction(option.provider, option.model, effort)
      return true
    }
    if (/^[1-9]$/.test(char)) {
      const digit = Number(char)
      const option = store.modelFiltered[store.modelIndex]
      if (option !== undefined && digit >= 1 && digit <= choices.length) {
        const effort = choices[digit - 1]?.id
        store.cancelConnect()
        if (effort !== undefined) store.modelsSaveAction(option.provider, option.model, effort)
      }
      return true
    }
    if (k.escape || (k.ctrl && char === 'c')) store.cancelEffort()
    return true
  }
  if (store.modelScope !== '') {
    // Second level: live type-to-filter over the open provider's models
    // (Enter saves, Esc clears the filter first, then backs out).
    const page = Math.max(1, store.rows - 12)
    if (k.pageUp) { store.moveModelIndex(store.modelIndex - page); return true }
    if (k.pageDown) { store.moveModelIndex(store.modelIndex + page); return true }
    if (k.home) { store.moveModelIndex(0); return true }
    if (k.end) { store.moveModelIndex(store.modelFiltered.length - 1); return true }
    if (k.upArrow) { store.bumpModelIndex(-1); return true }
    if (k.downArrow) { store.bumpModelIndex(1); return true }
    if (k.return) {
      // Read the selection BEFORE closing: cancelConnect clears the filter,
      // which would otherwise widen `modelFiltered` back to the full list.
      const option = store.modelFiltered[store.modelIndex]
      // Effort-capable models (e.g. the DeepSeek official trio) step through
      // the Effort picker first; the model choice completes only after an
      // effort is confirmed there.
      if ((option?.efforts?.length ?? 0) > 0) { store.openEffort(); return true }
      store.cancelConnect()
      if (option !== undefined) store.modelsSaveAction(option.provider, option.model)
    } else if (k.escape || (k.ctrl && char === 'c')) {
      if (store.modelFilter !== '') store.clearModelFilter()
      else store.cancelProviderModels()
    } else if (k.backspace || k.delete) {
      store.modelFilterBackspace()
    } else if (char) {
      store.modelFilterType(char)
    }
    return true
  }
  // First level: pick a provider (Enter drills into its models; while
  // unfiltered the last two slots are the add-provider entries).
  const page = Math.max(1, store.rows - 12)
  if ((k.ctrl && char === 'd') || (k.meta && char === 'd')) {
    // Ctrl+D / Alt+D hides the highlighted provider from the /models first
    // level AND removes its API key (deactivate). Re-adding = pick the
    // provider in "Add provider" and set a key again.
    const entry = store.providerFiltered[store.providerIndex]
    if (entry === undefined) store.setDialogNotice('no provider to hide')
    else store.deactivateProvider(entry.provider, entry.name)
    return true
  }
  if (k.pageUp) { store.moveProviderIndex(store.providerIndex - page); return true }
  if (k.pageDown) { store.moveProviderIndex(store.providerIndex + page); return true }
  if (k.home) { store.moveProviderIndex(0); return true }
  if (k.end) { store.moveProviderIndex(store.providerFiltered.length - 1); return true }
  if (k.upArrow) { store.bumpProviderIndex(-1); return true }
  if (k.downArrow) { store.bumpProviderIndex(1); return true }
  if (k.return) {
    const filtered = store.providerFiltered.length < store.providers.length
    if (!filtered && store.providerIndex === store.providers.length) {
      void store.openProviderList()
      return true
    }
    if (!filtered && store.providerIndex === store.providers.length + 1) { store.startProviderForm(store.providerTemplates); return true }
    const entry = store.providerFiltered[store.providerIndex]
    if (entry !== undefined) {
      const initial = store.currentModel.provider === entry.provider
        ? Math.max(0, entry.models.findIndex((m) => m.model === store.currentModel.model))
        : 0
      store.openProviderModels(entry, initial)
    }
  } else if (k.escape || (k.ctrl && char === 'c')) {
    if (store.providerFilter !== '') store.clearProviderFilter()
    else store.cancelConnect()
  } else if (k.backspace || k.delete) {
    store.providerFilterBackspace()
  } else if (char) {
    store.providerFilterType(char)
  }
  return true
}

/** Register the connect (fullscreen) panel and the `/models` command. */
export function apply(ctx: Context): void {
  store = ctx.get('tuiStore') as Store
  const tui = ctx.get('tui') as TuiService
  const modelsService = ctx.get(TUI_MODELS_SERVICE) as TuiModelsService | undefined
  tui.panels.register({
    id: 'connect',
    mode: 'fullscreen',
    render: () => <ModelsDialog />,
    handleKey: (k) => connectKey(k),
  })
  tui.commands.register({
    name: 'models',
    hint: 'manage models and the API key',
    run: () => {
      if (modelsService === undefined) {
        store.append('status', 'models: service unavailable', true)
        return
      }
      const current = store.currentModel
      void modelsService.listConfigured().then((providers) => {
        const entries = buildProviderEntries(providers)
        store.openModels(entries, Math.max(0, entries.findIndex((e) => e.provider === current.provider)))
        // Refresh the total-provider count shown after ＋ Add provider.
        void modelsService.listAll().then((names) => store.setProviderTotal(names.length)).catch(() => {})
      })
    },
  })
}
