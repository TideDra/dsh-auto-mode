window.__ModuleLoader__.load({
  id: '@local/dsh-auto-mode',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const CORDIS_ORIGINAL = Symbol.for('cordis.original')
    const LOCALE_NS = 'auto-mode'
    const STYLE_TAG_ID = '@local/dsh-auto-mode/client.css'
    const STATE_ENDPOINT = '/api/local/auto-mode/state'

    const GEMINI_MODEL_RE = /(?:^|[^a-z0-9])gemini/i
    const GPT_MODEL_RE = /(?:^|[^a-z0-9])(?:chat)?gpt/i

    const EN_DICT = {
      'preset.auto': 'Auto',
      'preset.auto.description':
        'Automatically selects Antigravity mode for Gemini models, Codex mode for GPT models, and Standard mode for other models.',
      'preset.standard': 'Standard mode',
      'preset.agy': 'Antigravity',
      'preset.codex': 'Codex',
      'preset.ptc': 'PTC mode',
      'preset.minimal': 'Minimal mode',
      'preset.cordis': 'Creator mode',
      'badge.label': 'Auto → {preset}',
      'badge.title.model':
        'Auto mode matched {preset} for {model}. Switching models before the first turn automatically switches presets.',
      'badge.title.default':
        'Auto mode matched {preset}. Switching models before the first turn automatically switches presets.',
    }

    const ZH_DICT = {
      'preset.auto': 'Auto',
      'preset.auto.description':
        '根据所选模型自动切换预设模式：选择 Gemini 模型时对应 Antigravity 模式，选择 GPT 模型时对应 Codex 模式，其余模型默认使用标准模式。',
      'preset.standard': '标准模式',
      'preset.agy': 'Antigravity',
      'preset.codex': 'Codex',
      'preset.ptc': 'PTC 模式',
      'preset.minimal': '极简模式',
      'preset.cordis': '创造模式',
      'badge.label': '自动 → {preset}',
      'badge.title.model':
        'Auto 模式已根据当前模型（{model}）自动匹配为「{preset}」；在首条消息发送前切换模型会自动切换预设模式。',
      'badge.title.default':
        'Auto 模式已自动匹配为「{preset}」；在首条消息发送前切换模型会自动切换预设模式。',
    }

    const CSS = [
      '.dshAutoMode_pill {',
      '  display: inline-flex;',
      '  align-items: center;',
      '  gap: 5px;',
      '  height: 22px;',
      '  max-width: min(220px, 100%);',
      '  padding: 0 8px;',
      '  border-radius: var(--dsw-radius-xs, 4px);',
      '  border: 1px solid var(--dsw-alias-border-l1);',
      '  background: var(--dsw-alias-fill-tsp-secondary);',
      '  color: var(--dsw-alias-label-secondary);',
      '  font-size: 12px;',
      '  font-weight: 400;',
      '  line-height: 20px;',
      '  white-space: nowrap;',
      '  overflow: hidden;',
      '  text-overflow: ellipsis;',
      '  user-select: none;',
      '}',
      '.dshAutoMode_dot {',
      '  width: 6px;',
      '  height: 6px;',
      '  border-radius: 999px;',
      '  flex: none;',
      '  background: var(--dsw-alias-brand-primary);',
      '}',
      '.dshAutoMode_text {',
      '  min-width: 0;',
      '  overflow: hidden;',
      '  text-overflow: ellipsis;',
      '}',
      '@container (width <= 540px) {',
      '  .dshAutoMode_pill { display: none; }',
      '}',
    ].join('\n')

    function unwrapService(service) {
      return service?.[CORDIS_ORIGINAL] ?? service
    }

    function desiredPresetForModel(model, config) {
      const m = typeof model === 'string' ? model.trim() : ''
      if (m.length > 0) {
        if (GEMINI_MODEL_RE.test(m)) return config.geminiPreset
        if (GPT_MODEL_RE.test(m)) return config.gptPreset
      }
      return config.fallbackPreset
    }

    function wrapServiceMethod(rawObj, methodName, wrapFactory) {
      if (!rawObj) return () => {}
      const origDesc = Object.getOwnPropertyDescriptor(rawObj, methodName)
      if (origDesc && typeof origDesc.get === 'function') {
        const wrappedGetter = function () {
          const origFn = origDesc.get.call(this)
          if (typeof origFn !== 'function') return origFn
          return wrapFactory(origFn)
        }
        Object.defineProperty(rawObj, methodName, {
          configurable: true,
          enumerable: origDesc.enumerable ?? true,
          get: wrappedGetter,
        })
        return () => {
          const cur = Object.getOwnPropertyDescriptor(rawObj, methodName)
          if (cur && cur.get === wrappedGetter) {
            Object.defineProperty(rawObj, methodName, origDesc)
          }
        }
      }
      const origVal = rawObj[methodName]
      if (typeof origVal === 'function') {
        const wrappedFn = wrapFactory(origVal)
        rawObj[methodName] = wrappedFn
        return () => {
          if (rawObj[methodName] === wrappedFn) {
            rawObj[methodName] = origVal
          }
        }
      }
      return () => {}
    }

    function formatTemplate(template, vars) {
      let out = String(template)
      for (const [k, v] of Object.entries(vars ?? {})) {
        out = out.replaceAll(`{${k}}`, String(v ?? ''))
      }
      return out
    }

    function AutoModeIndicator({ useSession, useProjection, sessionId, useAutoState, t }) {
      const snap = useAutoState((s) => s)
      const blank = useSession((s) => s.blank)
      const subagent = useSession((s) => s.subagent)
      const activePreset = useProjection('agentPreset')
      const modelSelection = useProjection('modelSelection')

      const entry = sessionId ? snap.sessions.get(sessionId) : undefined
      if (!blank || subagent !== null || !entry?.auto) {
        return null
      }

      const resolvedId =
        typeof activePreset === 'string' && activePreset !== snap.config.autoPresetId
          ? activePreset
          : entry.resolvedPreset || snap.config.fallbackPreset

      const translate = typeof t === 'function' ? t : (k, vars) => formatTemplate(EN_DICT[k] || k, vars)

      const knownFallbackKey = `preset.${resolvedId}`
      const presetLabel =
        snap.presetNames.get(resolvedId) ??
        (['standard', 'agy', 'codex', 'ptc', 'minimal', 'cordis'].includes(resolvedId)
          ? translate(knownFallbackKey)
          : resolvedId)

      const activeModel = modelSelection?.next?.model ?? modelSelection?.lastUsed?.model ?? ''
      const title = activeModel
        ? translate('badge.title.model', { preset: presetLabel, model: activeModel })
        : translate('badge.title.default', { preset: presetLabel })

      return h(
        'span',
        {
          className: 'dshAutoMode_pill',
          'data-auto-mode-target': resolvedId,
          title,
        },
        h('span', { className: 'dshAutoMode_dot', 'aria-hidden': 'true' }),
        h('span', { className: 'dshAutoMode_text' }, translate('badge.label', { preset: presetLabel })),
      )
    }

    return {
      inject: ['slots', 'locale', 'sessions', 'remote', 'remote.agentPresets', 'remote.session'],
      apply(ctx) {
        const disposers = []

        // 1. Register component styles
        ctx.effect(() => {
          if (typeof document === 'undefined') return () => {}
          let styleEl = document.querySelector(
            'style[data-plugin-css=' + JSON.stringify(STYLE_TAG_ID) + ']',
          )
          let created = false
          if (styleEl === null) {
            styleEl = document.createElement('style')
            styleEl.dataset.plugin = '@local/dsh-auto-mode'
            styleEl.dataset.pluginCss = STYLE_TAG_ID
            styleEl.textContent = CSS
            document.head.appendChild(styleEl)
            created = true
          }
          return () => {
            if (created && styleEl && styleEl.parentNode) {
              styleEl.parentNode.removeChild(styleEl)
            }
          }
        }, 'auto-mode: styles')

        // 2. Register locale dictionaries
        ctx.effect(() => ctx.locale.register(LOCALE_NS, { en: EN_DICT, zh: ZH_DICT }), 'auto-mode: locales')

        // 3. Shared observable Auto state store
        const autoListeners = new Set()
        let stateVersion = 0
        let mutationEpoch = 0
        let stateSnapshot = {
          version: 0,
          defaultIsAuto: false,
          config: {
            autoPresetId: 'auto',
            geminiPreset: 'agy',
            gptPreset: 'codex',
            fallbackPreset: 'standard',
          },
          sessions: new Map(),
          presetNames: new Map(),
        }

        const emitAutoState = () => {
          stateVersion += 1
          stateSnapshot = {
            version: stateVersion,
            defaultIsAuto: stateSnapshot.defaultIsAuto,
            config: stateSnapshot.config,
            sessions: new Map(stateSnapshot.sessions),
            presetNames: new Map(stateSnapshot.presetNames),
          }
          for (const listener of [...autoListeners]) {
            try {
              listener()
            } catch {}
          }
        }

        const autoStore = {
          getSnapshot: () => stateSnapshot,
          subscribe: (listener) => {
            autoListeners.add(listener)
            return () => autoListeners.delete(listener)
          },
        }

        const listSubscribers = new Set()
        const notifySessionList = () => {
          for (const listener of [...listSubscribers]) {
            try {
              listener()
            } catch {}
          }
        }

        const setSessionAuto = (sessionId, isAuto, resolvedPreset) => {
          if (typeof sessionId !== 'string' || sessionId.length === 0) return false
          mutationEpoch += 1
          const prev = stateSnapshot.sessions.get(sessionId)
          if (isAuto) {
            const nextEntry = {
              auto: true,
              resolvedPreset:
                typeof resolvedPreset === 'string' && resolvedPreset.length > 0
                  ? resolvedPreset
                  : prev?.resolvedPreset ?? stateSnapshot.config.fallbackPreset,
            }
            if (prev?.auto === true && prev.resolvedPreset === nextEntry.resolvedPreset) {
              return false
            }
            stateSnapshot.sessions.set(sessionId, nextEntry)
            emitAutoState()
            if (prev?.auto !== true) notifySessionList()
            return true
          }
          if (!stateSnapshot.sessions.has(sessionId)) return false
          stateSnapshot.sessions.delete(sessionId)
          emitAutoState()
          notifySessionList()
          return true
        }

        // 4. Patch `sessions.list` so blank Auto sessions display `'auto'` in Hero preset picker,
        //    while `binding.session.projections` keeps the real resolved preset (`agy` / `codex`)
        //    so `dsh-agy-mode` / `dsh-codex-mode` composer toggles render naturally!
        const listStore = ctx.sessions?.list
        const realPresetById = new Map()
        if (listStore && typeof listStore.getSnapshot === 'function' && typeof listStore.subscribe === 'function') {
          const origGetSnapshot = listStore.getSnapshot.bind(listStore)
          const origSubscribe = listStore.subscribe.bind(listStore)
          const origSet = typeof listStore.set === 'function' ? listStore.set.bind(listStore) : null

          if (origSet !== null) {
            listStore.set = function patchedSessionsListSet(nextState) {
              if (nextState && nextState.byId) {
                let prunedAuto = false
                for (const id of Object.keys(nextState.byId)) {
                  const row = nextState.byId[id]
                  const real = row?.projectionValues?.agentPreset
                  if (typeof real === 'string' && real !== stateSnapshot.config.autoPresetId) {
                    realPresetById.set(id, real)
                  }
                  if (row && row.blank === false && stateSnapshot.sessions.has(id)) {
                    stateSnapshot.sessions.delete(id)
                    mutationEpoch += 1
                    prunedAuto = true
                  }
                }
                if (prunedAuto) emitAutoState()
              }
              return origSet(nextState)
            }
            disposers.push(() => {
              listStore.set = origSet
            })
          }

          let cachedRaw = null
          let cachedVersion = -1
          let cachedResult = null

          listStore.getSnapshot = function patchedSessionsListGetSnapshot() {
            const raw = origGetSnapshot()
            if (cachedResult !== null && cachedRaw === raw && cachedVersion === stateVersion) {
              return cachedResult
            }
            if (!raw || !raw.byId) {
              cachedRaw = raw
              cachedVersion = stateVersion
              cachedResult = raw
              return raw
            }

            const autoId = stateSnapshot.config.autoPresetId
            let changed = false
            const nextById = {}

            for (const id of Object.keys(raw.byId)) {
              const row = raw.byId[id]
              if (!row) {
                nextById[id] = row
                continue
              }
              const isAutoBlank = row.blank === true && stateSnapshot.sessions.get(id)?.auto === true
              const curPreset = row.projectionValues?.agentPreset
              if (isAutoBlank) {
                if (curPreset !== autoId) {
                  if (typeof curPreset === 'string' && curPreset !== autoId) {
                    realPresetById.set(id, curPreset)
                  }
                  nextById[id] = {
                    ...row,
                    projectionValues: {
                      ...row.projectionValues,
                      agentPreset: autoId,
                    },
                  }
                  changed = true
                  continue
                }
              } else if (curPreset === autoId && realPresetById.has(id)) {
                nextById[id] = {
                  ...row,
                  projectionValues: {
                    ...row.projectionValues,
                    agentPreset: realPresetById.get(id),
                  },
                }
                changed = true
                continue
              }
              nextById[id] = row
            }

            cachedRaw = raw
            cachedVersion = stateVersion
            cachedResult = changed ? { ...raw, byId: nextById } : raw
            return cachedResult
          }

          listStore.subscribe = function patchedSessionsListSubscribe(listener) {
            listSubscribers.add(listener)
            const unsubOrig = origSubscribe(listener)
            return () => {
              listSubscribers.delete(listener)
              unsubOrig()
            }
          }

          disposers.push(() => {
            listStore.getSnapshot = origGetSnapshot
            listStore.subscribe = origSubscribe
            notifySessionList()
          })
        }

        // 5. Sync authoritative Auto state from Host HTTP endpoint with epoch fencing
        let disposed = false
        let inflightRefresh = null
        let staleRetryQueued = false
        const refreshState = () => {
          if (disposed || typeof globalThis.fetch !== 'function') return Promise.resolve()
          if (inflightRefresh !== null) {
            staleRetryQueued = true
            return inflightRefresh
          }
          const startEpoch = mutationEpoch
          inflightRefresh = globalThis
            .fetch(STATE_ENDPOINT, {
              method: 'GET',
              credentials: 'same-origin',
              cache: 'no-store',
            })
            .then((res) => (res.ok ? res.json() : null))
            .then((payload) => {
              if (disposed || !payload || payload.ok !== true) return
              if (mutationEpoch !== startEpoch) {
                staleRetryQueued = true
                return
              }
              let listAffected = false
              const nextConfig = {
                autoPresetId: payload.config?.autoPresetId || 'auto',
                geminiPreset: payload.config?.geminiPreset || 'agy',
                gptPreset: payload.config?.gptPreset || 'codex',
                fallbackPreset: payload.config?.fallbackPreset || 'standard',
              }
              const nextSessions = new Map()
              const rawSessions = payload.sessions && typeof payload.sessions === 'object' ? payload.sessions : {}
              for (const [sid, val] of Object.entries(rawSessions)) {
                if (val && val.auto === true) {
                  nextSessions.set(sid, {
                    auto: true,
                    resolvedPreset:
                      typeof val.resolvedPreset === 'string' && val.resolvedPreset.length > 0
                        ? val.resolvedPreset
                        : nextConfig.fallbackPreset,
                  })
                }
              }

              if (nextSessions.size !== stateSnapshot.sessions.size) {
                listAffected = true
              } else {
                for (const [sid, entry] of nextSessions.entries()) {
                  const prev = stateSnapshot.sessions.get(sid)
                  if (!prev || prev.auto !== entry.auto || prev.resolvedPreset !== entry.resolvedPreset) {
                    listAffected = true
                    break
                  }
                }
              }

              stateSnapshot.defaultIsAuto = Boolean(payload.defaultIsAuto)
              stateSnapshot.config = nextConfig
              stateSnapshot.sessions = nextSessions
              emitAutoState()
              if (listAffected) notifySessionList()
            })
            .catch(() => {})
            .finally(() => {
              inflightRefresh = null
              if (staleRetryQueued && !disposed) {
                staleRetryQueued = false
                void refreshState()
              }
            })
          return inflightRefresh
        }

        // 6. Wrap `remote.agentPresets` (`list`, `select`) & `remote.session` (`create`, `selectModel`)
        const rawRemotePresets = unwrapService(ctx.get('remote.agentPresets'))
        const rawRemoteSession = unwrapService(ctx.get('remote.session'))

        disposers.push(
          wrapServiceMethod(rawRemotePresets, 'list', (origList) => async (...args) => {
            const res = await origList(...args)
            if (res?.ok && Array.isArray(res.value?.presets)) {
              const autoId = stateSnapshot.config.autoPresetId
              let isDefaultAuto = false
              let namesChanged = false
              const nextNames = new Map(stateSnapshot.presetNames)
              const localeSnap = ctx.locale.getLocale?.()
              const isZh = typeof localeSnap?.id === 'string' && localeSnap.id.startsWith('zh')
              const localizedDesc = isZh ? ZH_DICT['preset.auto.description'] : EN_DICT['preset.auto.description']

              const presets = res.value.presets.map((row) => {
                if (row.id === autoId) {
                  if (row.isDefault) isDefaultAuto = true
                  nextNames.set(row.id, row.name || 'Auto')
                  return {
                    ...row,
                    description: localizedDesc,
                  }
                }
                if (typeof row.name === 'string' && row.name.length > 0 && nextNames.get(row.id) !== row.name) {
                  nextNames.set(row.id, row.name)
                  namesChanged = true
                }
                return row
              })

              if (stateSnapshot.defaultIsAuto !== isDefaultAuto || namesChanged) {
                stateSnapshot.defaultIsAuto = isDefaultAuto
                stateSnapshot.presetNames = nextNames
                emitAutoState()
              }

              return {
                ...res,
                value: {
                  ...res.value,
                  presets,
                },
              }
            }
            return res
          }),
        )

        disposers.push(
          wrapServiceMethod(rawRemotePresets, 'select', (origSelect) => async (sessionId, agentPreset, ...rest) => {
            const res = await origSelect(sessionId, agentPreset, ...rest)
            const autoId = stateSnapshot.config.autoPresetId
            if (res?.ok) {
              if (agentPreset === autoId) {
                setSessionAuto(sessionId, true, res.value)
                return {
                  ...res,
                  value: autoId,
                }
              }
              setSessionAuto(sessionId, false, res.value)
            }
            return res
          }),
        )

        disposers.push(
          wrapServiceMethod(rawRemoteSession, 'create', (origCreate) => async (request, ...rest) => {
            const res = await origCreate(request, ...rest)
            const autoId = stateSnapshot.config.autoPresetId
            if (res?.ok && res.value?.sessionId) {
              const sid = res.value.sessionId
              const explicit = request?.agentPreset
              const prevEntry = stateSnapshot.sessions.get(sid)
              const isRestoring =
                prevEntry?.auto === true &&
                explicit !== undefined &&
                explicit !== autoId &&
                prevEntry.resolvedPreset === explicit

              if (explicit === autoId || (explicit === undefined && stateSnapshot.defaultIsAuto) || isRestoring) {
                setSessionAuto(sid, true, res.value.agentPreset ?? stateSnapshot.config.fallbackPreset)
              } else if (explicit !== undefined) {
                setSessionAuto(sid, false, res.value.agentPreset)
              }
              void refreshState()
            }
            return res
          }),
        )

        disposers.push(
          wrapServiceMethod(rawRemoteSession, 'selectModel', (origSelectModel) => async (request, ...rest) => {
            const res = await origSelectModel(request, ...rest)
            const sid = request?.sessionId
            if (res?.ok && typeof sid === 'string' && stateSnapshot.sessions.get(sid)?.auto === true) {
              const selectedModel = res.value?.selected?.model ?? request?.model
              const optimisticTarget = desiredPresetForModel(selectedModel, stateSnapshot.config)
              setSessionAuto(sid, true, optimisticTarget)
              void refreshState()
            }
            return res
          }),
        )

        // 7. Refresh on reconnect / settings changes
        disposers.push(
          ctx.on('connection/reset', () => {
            void refreshState()
          }),
        )
        if (typeof ctx.remote?.$on === 'function') {
          disposers.push(
            ctx.remote.$on('settings/document-updated', (ns) => {
              if (ns === 'agent-preset-registry') {
                void refreshState()
              }
            }),
          )
        }

        // 8. Additive Hero row indicator (`Auto → Antigravity` / `Auto → Codex`)
        const tBound = ctx.locale.bind(LOCALE_NS)
        ctx.slots.inject('conversation.hero.options', () =>
          ctx.slots.register(
            {
              name: 'conversation.hero.options',
              id: 'auto-mode-indicator',
              order: 10,
              label: () => tBound('preset.auto'),
              locale: LOCALE_NS,
              inject: () => ({
                hooks: { autoState: autoStore },
              }),
            },
            AutoModeIndicator,
          ),
        )

        void refreshState()

        return () => {
          disposed = true
          for (const dispose of disposers.reverse()) {
            try {
              dispose()
            } catch {}
          }
          autoListeners.clear()
          listSubscribers.clear()
        }
      },
    }
  },
})
