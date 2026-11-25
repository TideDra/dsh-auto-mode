import { importDshPackage } from './src/dsh-deps.js'
import { resolveAutoConfig, resolveHealthyTarget } from './src/router.js'

const [{ default: z }, { z: zod }] = await Promise.all([
  importDshPackage('@deepseek-ai/schemastery'),
  importDshPackage('zod'),
])

const CORDIS_ORIGINAL = Symbol.for('cordis.original')
const STATE_ENDPOINT = '/api/local/auto-mode/state'
const STORAGE_DOMAIN_NAME = 'dsh-auto-mode'

export const name = 'auto-mode'
export const inject = ['agentPresets', 'agentDefaultModel', 'agents', 'sessions']

export const Config = z.object({
  autoPresetId: z.string().default('auto'),
  geminiPreset: z.string().default('agy'),
  gptPreset: z.string().default('codex'),
  fallbackPreset: z.string().default('standard'),
  routeSubagents: z.boolean().default(true),
})

function unwrapService(service) {
  return service?.[CORDIS_ORIGINAL] ?? service
}

/**
 * Install the Auto preset mode router into the Host runtime.
 *
 * When a new or blank session selects `auto` (either explicitly or as the
 * configured default), this plugin resolves `gemini*` models to `agy`
 * (Antigravity mode), `gpt*` models to `codex` (Codex mode), and all other
 * models to `standard` (configurable via `fallbackPreset`).
 *
 * While the session remains blank (before Turn 1 starts), changing the model
 * automatically switches the session's active preset and recomposes its tools,
 * prompts, and UI controls. Once Turn 1 begins, the matched preset locks for
 * the lifetime of that conversation.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [rawConfig]
 */
export function apply(ctx, rawConfig = {}) {
  const config = resolveAutoConfig(rawConfig)
  const rawPresets = unwrapService(ctx.agentPresets)

  // Suppress an empty generic Settings page for this plugin; Auto lives in Agent presets.
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber))
  })

  // Process-local authoritative map of blank sessions currently in Auto mode:
  // sessionId -> { auto: true, resolvedPreset: string, updatedAt: number }
  const autoBlankSessions = new Map()
  const internalAutoSwitching = new Set()
  const sessionChains = new Map()
  let storageTable = null
  let domainHandle = null
  let storageReadyPromise = Promise.resolve()

  const enqueueSession = (sessionId, operation) => {
    const prev = sessionChains.get(sessionId) ?? Promise.resolve()
    const next = prev.then(operation, operation)
    const settled = next.then(
      () => undefined,
      () => undefined,
    )
    sessionChains.set(sessionId, settled)
    settled.finally(() => {
      if (sessionChains.get(sessionId) === settled) {
        sessionChains.delete(sessionId)
      }
    })
    return next
  }

  const isBlankSession = (session) => {
    if (!session) return false
    const boundary = ctx.agents.turnBoundaryOf(session)
    return boundary.openTurnStartSeq === null && boundary.lastTurn === 0
  }

  const getEffectiveModel = (agent) => {
    return agent?.model?.current?.() ?? ctx.agentDefaultModel.currentSelection()
  }

  const markAutoSession = async (sessionId, resolvedPreset) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return
    const record = {
      auto: true,
      resolvedPreset: typeof resolvedPreset === 'string' && resolvedPreset.length > 0
        ? resolvedPreset
        : config.fallbackPreset,
      updatedAt: Date.now(),
    }
    autoBlankSessions.set(sessionId, record)
    if (storageTable !== null) {
      try {
        await storageTable.put(sessionId, record)
      } catch (error) {
        ctx.logger.warn(`auto-mode: failed to persist session "${sessionId}": ${String(error)}`)
      }
    }
  }

  const clearAutoSession = async (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return
    const existed = autoBlankSessions.delete(sessionId)
    if (storageTable !== null && (existed || storageTable.get(sessionId) !== undefined)) {
      try {
        await storageTable.delete(sessionId)
      } catch (error) {
        ctx.logger.warn(`auto-mode: failed to remove session "${sessionId}": ${String(error)}`)
      }
    }
  }

  const pruneNonBlankSessions = async () => {
    for (const sessionId of [...autoBlankSessions.keys()]) {
      const attached = ctx.sessions.get(sessionId)
      if (attached !== undefined && !isBlankSession(attached)) {
        await clearAutoSession(sessionId)
      }
    }
  }

  // Open optional durable storageDomain so Auto mode survives Host restarts while blank.
  ctx.inject(['storageDomain'], (storageCtx) => {
    let closed = false
    const openTask = (async () => {
      try {
        const recordSchema = zod.object({
          auto: zod.literal(true),
          resolvedPreset: zod.string(),
          updatedAt: zod.number(),
        })
        const domain = await storageCtx.storageDomain.open({
          name: STORAGE_DOMAIN_NAME,
          version: 1,
          invalidRecords: 'backup-and-skip',
          tables: {
            sessions: { valueSchema: recordSchema },
          },
        })
        if (closed) {
          await domain.close().catch(() => {})
          return
        }
        domainHandle = domain
        storageTable = domain.table('sessions')
        for (const [sessionId, record] of storageTable.entries()) {
          if (!autoBlankSessions.has(sessionId)) {
            autoBlankSessions.set(sessionId, record)
          }
        }
        await pruneNonBlankSessions()
      } catch (error) {
        ctx.logger.warn(`auto-mode: durable storageDomain unavailable, using memory only: ${String(error)}`)
      }
    })()
    storageReadyPromise = openTask
    storageCtx.effect(() => async () => {
      closed = true
      await openTask.catch(() => {})
      storageTable = null
      const handle = domainHandle
      domainHandle = null
      if (handle !== null) {
        await handle.close().catch(() => {})
      }
    }, 'auto-mode: storageDomain lifecycle')
  })

  // Capture original methods before wrapping
  const origResolve = rawPresets.resolve.bind(rawPresets)
  const origMount = rawPresets.mount.bind(rawPresets)
  const origSelect = rawPresets.select.bind(rawPresets)
  const origList = rawPresets.list.bind(rawPresets)

  const resolveTargetForSelection = async (selection) => {
    return resolveHealthyTarget({
      selection,
      config,
      resolvePreset: origResolve,
      listPresets: origList,
    })
  }

  const runInternalAutoSelect = async (agent, target) => {
    internalAutoSwitching.add(agent.id)
    try {
      return await origSelect(agent, target)
    } finally {
      internalAutoSwitching.delete(agent.id)
    }
  }

  const reconcileAutoSession = async (sessionId, modelSelection) => {
    await storageReadyPromise.catch(() => {})
    const entry = autoBlankSessions.get(sessionId)
    if (!entry?.auto) return
    const agent = ctx.agents.get(sessionId)
    if (agent === undefined) return
    if (!isBlankSession(agent.session)) {
      await clearAutoSession(sessionId)
      return
    }
    const target = await resolveTargetForSelection(modelSelection ?? getEffectiveModel(agent))
    const current = rawPresets.presetForSession(agent.session)
    if (current !== target) {
      const committed = await runInternalAutoSelect(agent, target)
      await markAutoSession(sessionId, committed)
    } else if (entry.resolvedPreset !== target) {
      await markAutoSession(sessionId, target)
    }
  }

  // Wrap AgentPresetRegistry methods
  rawPresets.resolve = async function wrappedResolve(id) {
    await storageReadyPromise.catch(() => {})
    const wanted = id ?? rawPresets.defaultId
    if (wanted !== config.autoPresetId) {
      return origResolve(id)
    }
    const target = await resolveTargetForSelection(ctx.agentDefaultModel.currentSelection())
    return origResolve(target)
  }

  rawPresets.mount = async function wrappedMount(agentCtx, id) {
    await storageReadyPromise.catch(() => {})
    const wanted = id ?? rawPresets.defaultId
    if (wanted !== config.autoPresetId) {
      return origMount(agentCtx, id)
    }
    const target = await resolveTargetForSelection(ctx.agentDefaultModel.currentSelection())
    return origMount(agentCtx, target)
  }

  rawPresets.select = async function wrappedSelect(agent, agentPreset) {
    await storageReadyPromise.catch(() => {})
    if (agentPreset === config.autoPresetId) {
      return enqueueSession(agent.id, async () => {
        if (!isBlankSession(agent.session)) {
          // Delegate to origSelect so the official agent-preset/locked RemoteError is thrown.
          return origSelect(agent, agentPreset)
        }
        const target = await resolveTargetForSelection(getEffectiveModel(agent))
        const committed = await runInternalAutoSelect(agent, target)
        await markAutoSession(agent.id, committed)
        return committed
      })
    }

    if (internalAutoSwitching.has(agent.id)) {
      return origSelect(agent, agentPreset)
    }

    return enqueueSession(agent.id, async () => {
      const committed = await origSelect(agent, agentPreset)
      await clearAutoSession(agent.id)
      return committed
    })
  }

  ctx.effect(() => () => {
    rawPresets.resolve = origResolve
    rawPresets.mount = origMount
    rawPresets.select = origSelect
  }, 'auto-mode: restore agentPresets wrappers')

  // Wrap SessionController (`createSession` & `selectModel`)
  ctx.inject(['sessionController'], (scCtx) => {
    const rawSC = unwrapService(scCtx.sessionController)
    const agentsController = rawSC?.agents
    const commandsController = rawSC?.commands
    const restoreCallbacks = []

    if (agentsController && typeof agentsController.createSession === 'function') {
      const origCreateSession = agentsController.createSession.bind(agentsController)
      agentsController.createSession = async function wrappedCreateSession(request) {
        await storageReadyPromise.catch(() => {})
        const explicit = request?.agentPreset
        const named = request?.sessionId
        const existingEntry = typeof named === 'string' ? autoBlankSessions.get(named) : undefined
        const isRestoringAuto =
          existingEntry?.auto === true &&
          explicit !== undefined &&
          explicit !== config.autoPresetId &&
          existingEntry.resolvedPreset === explicit

        const wantsAuto =
          explicit === config.autoPresetId ||
          (explicit === undefined && rawPresets.defaultId === config.autoPresetId) ||
          isRestoringAuto

        let effectiveRequest = request
        let markedInternalSwitch = false
        if (wantsAuto) {
          const live = typeof named === 'string' ? ctx.agents.get(named) : undefined
          const modelSel =
            live !== undefined && isBlankSession(live.session)
              ? getEffectiveModel(live)
              : ctx.agentDefaultModel.currentSelection()
          const target = await resolveTargetForSelection(modelSel)
          effectiveRequest = { ...request, agentPreset: target }
          if (typeof named === 'string') {
            internalAutoSwitching.add(named)
            markedInternalSwitch = true
          }
        }

        let created
        try {
          created = await origCreateSession(effectiveRequest)
        } finally {
          if (markedInternalSwitch && typeof named === 'string') {
            internalAutoSwitching.delete(named)
          }
        }

        const createdId = created?.agent?.id
        if (typeof createdId === 'string') {
          if (wantsAuto && isBlankSession(created.agent.session)) {
            await markAutoSession(createdId, created.agentPreset)
          } else {
            await clearAutoSession(createdId)
          }
        }
        return created
      }
      restoreCallbacks.push(() => {
        agentsController.createSession = origCreateSession
      })
    }

    if (commandsController && typeof commandsController.selectModel === 'function') {
      const origSelectModel = commandsController.selectModel.bind(commandsController)
      commandsController.selectModel = async function wrappedSelectModel(request) {
        const result = await origSelectModel(request)
        const sessionId = request?.sessionId
        if (typeof sessionId === 'string' && sessionId.length > 0) {
          await enqueueSession(sessionId, () =>
            reconcileAutoSession(sessionId, result?.selected ?? request),
          )
        }
        return result
      }
      restoreCallbacks.push(() => {
        commandsController.selectModel = origSelectModel
      })
    }

    scCtx.effect(() => () => {
      for (const restore of restoreCallbacks.reverse()) {
        restore()
      }
    }, 'auto-mode: restore sessionController wrappers')
  })

  // Route cross-family subagent models (e.g., AGY spawning a GPT reviewer via AgentTeams)
  // to their matching agentPreset (gpt-* -> codex, gemini-* -> agy) when the subagent
  // provider supports independent preset selection (e.g., `spawn`, never `fork`).
  if (config.routeSubagents) {
    ctx.inject(['subagents'], (subCtx) => {
      const rawSubagents = unwrapService(subCtx.subagents)
      if (!rawSubagents || typeof rawSubagents !== 'object') return

      const supportsIndependentPreset = (providerName) => {
        if (typeof providerName !== 'string' || providerName.length === 0) return false
        const providerMap = rawSubagents.providers
        if (providerMap && typeof providerMap.get === 'function') {
          const provider = providerMap.get(providerName)
          if (!provider) return false
          return Boolean(provider.capabilities?.agentPreset) && !provider.inheritsParentContext
        }
        return providerName !== 'fork'
      }

      const parentPresetOf = (parent) => {
        if (!parent) return undefined
        try {
          if (typeof rawPresets.composedPreset === 'function' && parent.ctx) {
            const composed = rawPresets.composedPreset(parent.ctx)
            if (typeof composed === 'string' && composed.length > 0) return composed
          }
        } catch {}
        try {
          if (typeof rawPresets.presetForSession === 'function' && parent.session) {
            const fromSession = rawPresets.presetForSession(parent.session)
            if (typeof fromSession === 'string' && fromSession.length > 0) return fromSession
          }
        } catch {}
        return undefined
      }

      const resolveSubagentRequest = async (providerName, request) => {
        if (!request || typeof request !== 'object') return request
        if (!supportsIndependentPreset(providerName)) return request

        const explicitPreset = request.agentPreset
        if (explicitPreset !== undefined && explicitPreset !== config.autoPresetId) {
          return request
        }

        const childModel =
          typeof request.agentOptions?.model === 'string' && request.agentOptions.model.trim().length > 0
            ? request.agentOptions
            : explicitPreset === config.autoPresetId
              ? getEffectiveModel(request.parent)
              : undefined

        if (!childModel) return request

        const target = await resolveTargetForSelection(childModel)
        if (explicitPreset === config.autoPresetId) {
          return { ...request, agentPreset: target }
        }

        const parentPreset = parentPresetOf(request.parent)
        if (parentPreset === target) {
          return request
        }

        return { ...request, agentPreset: target }
      }

      subCtx.effect(() => {
        const disposers = []
        for (const key of ['start', 'startContinuable', 'startActivation']) {
          const original = rawSubagents[key]
          if (typeof original !== 'function') continue
          const descriptor = Object.getOwnPropertyDescriptor(rawSubagents, key)

          const wrapped = async function wrappedSubagentStart(...args) {
            await storageReadyPromise.catch(() => {})
            try {
              if (key === 'start' && args.length >= 2) {
                const nextReq = await resolveSubagentRequest(args[0], args[1])
                if (nextReq !== args[1]) {
                  const nextArgs = [...args]
                  nextArgs[1] = nextReq
                  return Reflect.apply(original, this, nextArgs)
                }
              } else if (key === 'startContinuable' && args[0] && typeof args[0] === 'object') {
                const spec = args[0]
                const nextReq = await resolveSubagentRequest(spec.provider, spec.request)
                if (nextReq !== spec.request) {
                  const nextArgs = [...args]
                  nextArgs[0] = { ...spec, request: nextReq }
                  return Reflect.apply(original, this, nextArgs)
                }
              } else if (key === 'startActivation' && args[0] && typeof args[0] === 'object') {
                const spec = args[0]
                if (spec.request !== undefined && typeof spec.request === 'object') {
                  const nextReq = await resolveSubagentRequest(spec.provider, spec.request)
                  if (nextReq !== spec.request) {
                    const nextArgs = [...args]
                    nextArgs[0] = { ...spec, request: nextReq }
                    return Reflect.apply(original, this, nextArgs)
                  }
                } else {
                  const nextSpec = await resolveSubagentRequest(spec.provider, spec)
                  if (nextSpec !== spec) {
                    const nextArgs = [...args]
                    nextArgs[0] = nextSpec
                    return Reflect.apply(original, this, nextArgs)
                  }
                }
              }
            } catch (error) {
              ctx.logger.warn(`auto-mode: subagent preset routing skipped for "${key}": ${String(error)}`)
            }
            return Reflect.apply(original, this, args)
          }

          Object.defineProperty(rawSubagents, key, {
            value: wrapped,
            writable: true,
            configurable: true,
          })
          disposers.push(() => {
            if (Object.getOwnPropertyDescriptor(rawSubagents, key)?.value !== wrapped) return
            if (descriptor === undefined) {
              Reflect.deleteProperty(rawSubagents, key)
            } else {
              Object.defineProperty(rawSubagents, key, descriptor)
            }
          })
        }
        return () => {
          for (const dispose of disposers.reverse()) {
            dispose()
          }
        }
      }, 'auto-mode: subagent preset routing')
    })
  }

  // Observe durable session events to:
  // 1) Lock and stop auto-switching once Turn 1 begins (`turn/start`)
  // 2) Reconcile direct `agent.model.select()` calls on blank Auto sessions (`model/selection`)
  ctx.on('session/event', (session, event) => {
    if (!session) return
    if (event.type === 'turn/start') {
      if (autoBlankSessions.has(session.id)) {
        void enqueueSession(session.id, () => clearAutoSession(session.id))
      }
      return
    }
    if (event.type === 'model/selection' && autoBlankSessions.has(session.id)) {
      const agent = ctx.agents.get(session.id)
      if (agent !== undefined && isBlankSession(session)) {
        void enqueueSession(session.id, () => reconcileAutoSession(session.id, event.data))
      }
    }
  })

  // Expose authenticated Host state endpoint for the Web Client plugin
  ctx.inject(['connection'], (connCtx) => {
    connCtx.effect(
      () =>
        connCtx.connection.fetch.register({
          path: STATE_ENDPOINT,
          methods: ['GET'],
          requestBody: 'buffered',
          fetch: async () => {
            await storageReadyPromise.catch(() => {})
            await pruneNonBlankSessions()
            const sessions = {}
            for (const [sessionId, entry] of autoBlankSessions.entries()) {
              const live = ctx.agents.get(sessionId)
              if (live !== undefined && !isBlankSession(live.session)) continue
              const livePreset = live !== undefined ? rawPresets.presetForSession(live.session) : null
              sessions[sessionId] = {
                auto: true,
                resolvedPreset: livePreset ?? entry.resolvedPreset,
              }
            }
            return new Response(
              JSON.stringify({
                ok: true,
                defaultIsAuto: rawPresets.defaultId === config.autoPresetId,
                config,
                sessions,
              }),
              {
                status: 200,
                headers: {
                  'content-type': 'application/json; charset=utf-8',
                  'cache-control': 'no-store',
                },
              },
            )
          },
        }),
      'auto-mode: state endpoint',
    )
  })
}

export * from './src/router.js'
