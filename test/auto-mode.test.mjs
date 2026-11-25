import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  apply as applyHost,
  classifyModelFamily,
  desiredPresetForModel,
  resolveAutoConfig,
  resolveHealthyTarget,
} from '../index.js'
import * as presetEntry from '../src/preset.js'

const ROOT_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

function createMockContext({
  initialDefaultId = 'standard',
  initialSelection = { provider: 'github-copilot-live', model: 'gemini-4-hydrogen' },
  availablePresets = [
    { id: 'standard', name: 'Standard' },
    { id: 'agy', name: 'Antigravity' },
    { id: 'codex', name: 'Codex' },
    { id: 'cordis', name: 'Creator' },
    { id: 'auto', name: 'Auto' },
  ],
  brokenPresets = new Set(),
} = {}) {
  const cleanups = []
  const eventListeners = new Map()
  const injectCallbacks = new Map()
  const liveAgents = new Map()
  const liveSessions = new Map()
  const fetchHandlers = new Map()
  const domainData = new Map()

  let currentSelection = { ...initialSelection }
  let currentDefaultId = initialDefaultId

  const makeSession = (id, initialPreset = null) => {
    const boundary = { openTurnStartSeq: null, lastTurn: 0 }
    let recordedPreset = initialPreset
    let currentModel = null
    const session = {
      id,
      header: { id, agentPreset: initialPreset ?? undefined },
      append(type, data) {
        if (type === 'agent-preset/selected') {
          recordedPreset = data.agentPreset
        } else if (type === 'turn/start') {
          boundary.lastTurn = data.turn
        } else if (type === 'model/selection') {
          currentModel = { ...data }
        }
        emit('session/event', session, { type, data })
      },
      _boundary: boundary,
      _setModel(sel) {
        currentModel = sel
      },
      _getModel() {
        return currentModel
      },
      _getPreset() {
        return recordedPreset
      },
    }
    return session
  }

  const agentPresets = {
    get defaultId() {
      return currentDefaultId
    },
    setDefaultId(id) {
      currentDefaultId = id
    },
    presetForSession(session) {
      return session._getPreset()
    },
    async list() {
      return availablePresets.map((p) => ({
        ...p,
        ...(brokenPresets.has(p.id) ? { broken: 'disabled in test' } : {}),
      }))
    },
    async resolve(id) {
      const wanted = id ?? currentDefaultId
      if (!availablePresets.some((p) => p.id === wanted)) {
        throw new Error(`Unknown agent preset: ${wanted}`)
      }
      if (brokenPresets.has(wanted)) {
        return { id: wanted, broken: 'disabled in test' }
      }
      return { id: wanted }
    },
    async mount(_agentCtx, id) {
      const resolved = await this.resolve(id)
      if (resolved.broken) throw new Error(resolved.broken)
      return { id: resolved.id }
    },
    async select(agent, id) {
      const boundary = agent.session._boundary
      if (boundary.openTurnStartSeq !== null || boundary.lastTurn > 0) {
        const err = new Error('This session has already started')
        err.code = 'agent-preset/locked'
        throw err
      }
      const resolved = await this.mount(agent.ctx, id)
      agent.session.append('agent-preset/selected', { agentPreset: resolved.id })
      return resolved.id
    },
  }

  const agentsService = {
    turnBoundaryOf(session) {
      return session._boundary
    },
    get(id) {
      return liveAgents.get(id)
    },
    list() {
      return [...liveAgents.values()]
    },
  }

  const sessionsService = {
    get(id) {
      return liveSessions.get(id)
    },
  }

  const sessionController = {
    agents: {
      async createSession(request = {}) {
        const sid = request.sessionId ?? `session-${liveAgents.size + 1}`
        const existingAgent = liveAgents.get(sid)
        const resolved = await agentPresets.resolve(request.agentPreset)
        if (existingAgent !== undefined && existingAgent.session._boundary.lastTurn === 0) {
          if (agentPresets.presetForSession(existingAgent.session) !== resolved.id) {
            await agentPresets.select(existingAgent, resolved.id)
          }
          return {
            agent: existingAgent,
            agentPreset: resolved.id,
          }
        }
        const session = makeSession(sid, resolved.id)
        const agent = {
          id: sid,
          ctx: {},
          session,
          model: {
            current() {
              return session._getModel() ?? { ...currentSelection }
            },
            select(sel) {
              session.append('model/selection', sel)
            },
          },
        }
        liveSessions.set(sid, session)
        liveAgents.set(sid, agent)
        return {
          agent,
          agentPreset: resolved.id,
        }
      },
    },
    commands: {
      async selectModel(request) {
        const agent = liveAgents.get(request.sessionId)
        if (!agent) throw new Error(`Unknown session: ${request.sessionId}`)
        const selected = {
          provider: request.provider ?? currentSelection.provider,
          model: request.model,
        }
        agent.model.select(selected)
        currentSelection = { ...selected }
        return { selected }
      },
    },
    create(req) {
      return this.agents.createSession(req)
    },
    selectModel(req) {
      return this.commands.selectModel(req)
    },
  }

  const storageDomain = {
    async open(spec) {
      let tableMap = domainData.get(spec.name)
      if (!tableMap) {
        tableMap = new Map()
        domainData.set(spec.name, tableMap)
      }
      let closed = false
      return {
        name: spec.name,
        table() {
          return {
            get(key) {
              return tableMap.get(key)
            },
            entries() {
              return tableMap.entries()
            },
            async put(key, value) {
              if (closed) throw new Error('Domain closed')
              tableMap.set(key, value)
            },
            async delete(key) {
              if (closed) throw new Error('Domain closed')
              return tableMap.delete(key)
            },
          }
        },
        async close() {
          closed = true
        },
      }
    },
  }

  const connection = {
    fetch: {
      register(handler) {
        fetchHandlers.set(handler.path, handler)
        return () => fetchHandlers.delete(handler.path)
      },
    },
  }

  function emit(name, ...args) {
    const list = eventListeners.get(name) ?? []
    for (const fn of [...list]) {
      fn(...args)
    }
  }

  const services = {
    agentPresets,
    agentDefaultModel: {
      currentSelection: () => ({ ...currentSelection }),
      async saveSelection(next) {
        currentSelection = { ...next }
      },
    },
    agents: agentsService,
    sessions: sessionsService,
    sessionController,
    storageDomain,
    connection,
    settings: {
      configure() {
        return () => {}
      },
    },
  }

  const ctx = {
    fiber: {},
    logger: { warn() {}, error() {} },
    ...services,
    get(key) {
      return services[key]
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') cleanups.push(dispose)
      return () => dispose?.()
    },
    on(event, fn) {
      if (!eventListeners.has(event)) eventListeners.set(event, [])
      eventListeners.get(event).push(fn)
      return () => {
        const arr = eventListeners.get(event)
        if (!arr) return
        const idx = arr.indexOf(fn)
        if (idx >= 0) arr.splice(idx, 1)
      }
    },
    inject(deps, cb) {
      const key = deps.join(',')
      injectCallbacks.set(key, cb)
      cb(ctx)
      return () => injectCallbacks.delete(key)
    },
    async disposeAll() {
      for (const cleanup of cleanups.splice(0).reverse()) {
        await cleanup()
      }
    },
  }

  return {
    ctx,
    agentPresets,
    sessionController,
    liveAgents,
    liveSessions,
    fetchHandlers,
    setDefaultModel(sel) {
      currentSelection = { ...sel }
    },
  }
}

test('router classifies gemini, gpt, and other model families cleanly', () => {
  assert.equal(classifyModelFamily('gemini-4-hydrogen'), 'gemini')
  assert.equal(classifyModelFamily({ model: 'gemini-3.5-pro' }), 'gemini')
  assert.equal(classifyModelFamily({ model: 'google/gemini-2.5-flash' }), 'gemini')

  assert.equal(classifyModelFamily('gpt-6.1-sol'), 'gpt')
  assert.equal(classifyModelFamily({ model: 'gpt-6-luna' }), 'gpt')
  assert.equal(classifyModelFamily({ model: 'openai/gpt-5.4' }), 'gpt')
  assert.equal(classifyModelFamily({ model: 'chatgpt-4o-latest' }), 'gpt')

  assert.equal(classifyModelFamily({ model: 'claude-sonnet-4.6' }), 'other')
  assert.equal(classifyModelFamily({ model: 'deepseek-chat' }), 'other')
  assert.equal(classifyModelFamily(null), 'other')

  const cfg = resolveAutoConfig({
    autoPresetId: 'auto',
    geminiPreset: 'auto', // self-reference prevented
    gptPreset: 'codex',
    fallbackPreset: 'standard',
  })
  assert.equal(cfg.geminiPreset, 'agy')
  assert.equal(desiredPresetForModel({ model: 'gemini-4-hydrogen' }, cfg), 'agy')
  assert.equal(desiredPresetForModel({ model: 'gpt-6.1-sol' }, cfg), 'codex')
  assert.equal(desiredPresetForModel({ model: 'deepseek-reasoner' }, cfg), 'standard')
})

test('resolveHealthyTarget falls back safely when preferred preset is missing or broken', async () => {
  const cfg = resolveAutoConfig()
  const presets = [
    { id: 'auto' },
    { id: 'agy', broken: 'missing plugin' },
    { id: 'standard' },
  ]
  const target = await resolveHealthyTarget({
    selection: { model: 'gemini-4-hydrogen' },
    config: cfg,
    resolvePreset: async (id) => {
      const found = presets.find((p) => p.id === id)
      if (!found) throw new Error('missing')
      return found
    },
    listPresets: async () => presets,
  })
  assert.equal(target, 'standard')
})

test('Host integration: Auto resolves on create, switches on model change while blank, and locks after Turn 1', async () => {
  const env = createMockContext({
    initialDefaultId: 'auto',
    initialSelection: { provider: 'github-copilot-live', model: 'gemini-4-hydrogen' },
  })
  applyHost(env.ctx, {})

  // 1. New session with default='auto' and gemini model -> resolves to 'agy'
  const created = await env.sessionController.create({})
  const sid = created.agent.id
  assert.equal(created.agentPreset, 'agy')
  assert.equal(env.agentPresets.presetForSession(created.agent.session), 'agy')

  const stateRes1 = await env.fetchHandlers.get('/api/local/auto-mode/state').fetch()
  const state1 = await stateRes1.json()
  assert.equal(state1.defaultIsAuto, true)
  assert.deepEqual(state1.sessions[sid], { auto: true, resolvedPreset: 'agy' })

  // 2. Switching model on blank Auto session to GPT -> auto-switches to 'codex'
  await env.sessionController.selectModel({
    sessionId: sid,
    provider: 'github-copilot-live',
    model: 'gpt-6.1-sol',
  })
  assert.equal(env.agentPresets.presetForSession(created.agent.session), 'codex')

  // 3. Switching model to Claude -> auto-switches to 'standard'
  await env.sessionController.selectModel({
    sessionId: sid,
    provider: 'github-copilot-live',
    model: 'claude-sonnet-4.6',
  })
  assert.equal(env.agentPresets.presetForSession(created.agent.session), 'standard')

  // 4. Switching back to Gemini -> auto-switches back to 'agy'
  await env.sessionController.selectModel({
    sessionId: sid,
    provider: 'github-copilot-live',
    model: 'gemini-3.5-pro',
  })
  assert.equal(env.agentPresets.presetForSession(created.agent.session), 'agy')

  // 5. Explicit user selection of 'codex' exits Auto mode; later model changes do NOT auto-switch
  await env.agentPresets.select(created.agent, 'codex')
  assert.equal(env.agentPresets.presetForSession(created.agent.session), 'codex')
  const stateRes2 = await env.fetchHandlers.get('/api/local/auto-mode/state').fetch()
  const state2 = await stateRes2.json()
  assert.equal(state2.sessions[sid], undefined)

  await env.sessionController.selectModel({
    sessionId: sid,
    provider: 'github-copilot-live',
    model: 'gemini-4-hydrogen',
  })
  assert.equal(env.agentPresets.presetForSession(created.agent.session), 'codex')

  // 6. Re-entering Auto mode on blank session switches back to 'agy' for current Gemini model
  await env.agentPresets.select(created.agent, 'auto')
  assert.equal(env.agentPresets.presetForSession(created.agent.session), 'agy')

  // 7. Starting Turn 1 locks the session and clears Auto blank tracking
  created.agent.session.append('turn/start', { turn: 1 })
  await new Promise((r) => setTimeout(r, 10))

  const stateRes3 = await env.fetchHandlers.get('/api/local/auto-mode/state').fetch()
  const state3 = await stateRes3.json()
  assert.equal(state3.sessions[sid], undefined)

  // Switching model mid-session must NOT alter the locked preset
  await env.sessionController.selectModel({
    sessionId: sid,
    provider: 'github-copilot-live',
    model: 'gpt-6.1-sol',
  })
  assert.equal(env.agentPresets.presetForSession(created.agent.session), 'agy')

  await assert.rejects(() => env.agentPresets.select(created.agent, 'auto'), {
    code: 'agent-preset/locked',
  })

  // 8. Reusing/recreating blank session survives reload via storageDomain
  env.setDefaultModel({ provider: 'github-copilot-live', model: 'gpt-6.1-sol' })
  const created2 = await env.sessionController.create({})
  const sid2 = created2.agent.id
  assert.equal(created2.agentPreset, 'codex')

  // Simulate Host plugin reload (same underlying storageDomain)
  await env.ctx.disposeAll()
  applyHost(env.ctx, {})

  // After reload, switching model on sid2 still auto-switches
  await env.sessionController.selectModel({
    sessionId: sid2,
    provider: 'github-copilot-live',
    model: 'gemini-4-hydrogen',
  })
  assert.equal(env.agentPresets.presetForSession(created2.agent.session), 'agy')

  await env.ctx.disposeAll()
})

test('Preset subplugin exports valid Config and leaks zero services', () => {
  assert.equal(typeof presetEntry.apply, 'function')
  assert.equal(typeof presetEntry.Config, 'function')
  const parsed = presetEntry.Config({})
  assert.deepEqual(parsed, {
    geminiPreset: 'agy',
    gptPreset: 'codex',
    fallbackPreset: 'standard',
  })
  assert.equal(presetEntry.apply(), undefined)
})

test('Client module loads cleanly, masks blank Auto sessions in sessions.list, and unwraps cleanly on dispose', async () => {
  const clientCode = await readFile(join(ROOT_DIR, 'client.js'), 'utf8')
  let loadedModule = null
  const mockWindow = {
    __ModuleLoader__: {
      load(def) {
        loadedModule = def
      },
    },
  }
  const fn = new Function('window', clientCode)
  fn(mockWindow)
  assert.ok(loadedModule)
  assert.equal(loadedModule.id, '@local/dsh-auto-mode')

  const pluginDef = loadedModule.factory((spec) => {
    if (spec === 'react') {
      return {
        createElement: (type, props, ...children) => ({ type, props, children }),
        useSyncExternalStore: (sub, getSnap) => getSnap(),
      }
    }
    throw new Error(`Unexpected require: ${spec}`)
  })

  // Mock Client services
  const listListeners = new Set()
  let rawListState = {
    ids: ['s1'],
    byId: {
      s1: {
        id: 's1',
        blank: true,
        projectionValues: { agentPreset: 'agy' },
      },
    },
  }
  const sessions = {
    list: {
      getSnapshot: () => rawListState,
      set: (next) => {
        rawListState = next
        for (const l of listListeners) l()
      },
      subscribe: (l) => {
        listListeners.add(l)
        return () => listListeners.delete(l)
      },
    },
  }

  const remotePresets = {}
  Object.defineProperty(remotePresets, 'list', {
    configurable: true,
    enumerable: true,
    get: () => async () => ({
      ok: true,
      value: {
        presets: [
          { id: 'auto', name: 'Auto', isDefault: true },
          { id: 'agy', name: 'Antigravity', isDefault: false },
          { id: 'codex', name: 'Codex', isDefault: false },
        ],
      },
    }),
  })
  Object.defineProperty(remotePresets, 'select', {
    configurable: true,
    enumerable: true,
    get: () => async (_sid, id) => ({
      ok: true,
      value: id === 'auto' ? 'agy' : id,
    }),
  })

  const remoteSession = {}
  Object.defineProperty(remoteSession, 'create', {
    configurable: true,
    enumerable: true,
    get: () => async () => ({
      ok: true,
      value: { sessionId: 's2', agentPreset: 'codex' },
    }),
  })
  Object.defineProperty(remoteSession, 'selectModel', {
    configurable: true,
    enumerable: true,
    get: () => async (req) => ({
      ok: true,
      value: { selected: { provider: req.provider, model: req.model } },
    }),
  })

  const slotRegs = []
  const cleanups = []
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    assert.equal(url, '/api/local/auto-mode/state')
    return {
      ok: true,
      async json() {
        return {
          ok: true,
          defaultIsAuto: true,
          config: {
            autoPresetId: 'auto',
            geminiPreset: 'agy',
            gptPreset: 'codex',
            fallbackPreset: 'standard',
          },
          sessions: {
            s1: { auto: true, resolvedPreset: 'agy' },
          },
        }
      },
    }
  }

  try {
    const clientCtx = {
      slots: {
        inject(key, cb) {
          const d = cb()
          cleanups.push(d)
          return d
        },
        register(opts, comp) {
          slotRegs.push({ opts, comp })
          return () => {}
        },
      },
      locale: {
        register: () => () => {},
        bind: () => (k) => k,
        getLocale: () => ({ id: 'zh' }),
      },
      sessions,
      remote: {
        $on: () => () => {},
      },
      on: () => () => {},
      effect(cb) {
        const d = cb()
        if (typeof d === 'function') cleanups.push(d)
        return d
      },
      get(name) {
        if (name === 'remote.agentPresets') return remotePresets
        if (name === 'remote.session') return remoteSession
        return undefined
      },
    }

    const disposePlugin = pluginDef.apply(clientCtx)
    await new Promise((r) => setTimeout(r, 15))

    // s1 is blank & Auto -> sessions.list exposes 'auto'
    assert.equal(sessions.list.getSnapshot().byId.s1.projectionValues.agentPreset, 'auto')

    // AutoModeIndicator renders Auto -> Antigravity
    assert.equal(slotRegs.length, 1)
    const { opts, comp } = slotRegs[0]
    const injected = opts.inject()
    const useAutoState = (sel) => sel(injected.hooks.autoState.getSnapshot())
    const rendered = comp({
      useAutoState,
      useSession: (sel) => sel({ blank: true, subagent: null }),
      useProjection: (key) => (key === 'agentPreset' ? 'agy' : { next: { model: 'gemini-4-hydrogen' } }),
      sessionId: 's1',
      t: (k, v) => `${k}:${v?.preset ?? ''}`,
    })
    assert.equal(rendered.props['data-auto-mode-target'], 'agy')

    // Selecting model updates indicator & remote.agentPresets.select('s1', 'agy') exits Auto
    await remoteSession.selectModel({ sessionId: 's1', provider: 'p', model: 'gpt-6.1-sol' })
    assert.equal(injected.hooks.autoState.getSnapshot().sessions.get('s1').resolvedPreset, 'codex')

    const manualRes = await remotePresets.select('s1', 'codex')
    assert.equal(manualRes.value, 'codex')
    assert.equal(sessions.list.getSnapshot().byId.s1.projectionValues.agentPreset, 'agy')

    const autoRes = await remotePresets.select('s1', 'auto')
    assert.equal(autoRes.value, 'auto')
    assert.equal(sessions.list.getSnapshot().byId.s1.projectionValues.agentPreset, 'auto')

    // Once session becomes non-blank, sessions.list reveals real preset again
    sessions.list.set({
      ids: ['s1'],
      byId: {
        s1: {
          id: 's1',
          blank: false,
          projectionValues: { agentPreset: 'agy' },
        },
      },
    })
    assert.equal(sessions.list.getSnapshot().byId.s1.projectionValues.agentPreset, 'agy')

    disposePlugin()
    for (const c of cleanups.reverse()) c()
  } finally {
    globalThis.fetch = origFetch
  }
})

test('Subagent auto-preset routing: AGY spawning GPT routes to codex, fork and same-family stay untouched, and unwraps on dispose', async () => {
  const { apply } = await import('../index.js')

  const presets = new Map([
    ['auto', { id: 'auto' }],
    ['agy', { id: 'agy' }],
    ['codex', { id: 'codex' }],
    ['standard', { id: 'standard' }],
  ])

  const received = []
  const origStartActivation = async (spec) => {
    received.push({ method: 'startActivation', spec })
    return { childId: 'child-1', result: Promise.resolve({}) }
  }
  const origStartContinuable = async (spec) => {
    received.push({ method: 'startContinuable', spec })
    return { childId: 'child-2' }
  }
  const origStart = async (provider, request) => {
    received.push({ method: 'start', provider, request })
    return { childId: 'child-3' }
  }

  const subagents = {
    providers: new Map([
      ['spawn', { name: 'spawn', capabilities: { agentPreset: true }, inheritsParentContext: false }],
      ['fork', { name: 'fork', capabilities: { agentPreset: false }, inheritsParentContext: true }],
    ]),
    startActivation: origStartActivation,
    startContinuable: origStartContinuable,
    start: origStart,
  }

  const effectDisposers = []
  const agyParent = {
    id: 'parent-agy',
    ctx: { tag: 'agy-ctx' },
    session: { id: 'parent-agy', header: { agentPreset: 'agy' } },
    model: { current: () => ({ provider: 'github-copilot-live', model: 'gemini-4-neon' }) },
  }

  const fakeCtx = {
    logger: { warn() {}, info() {} },
    agentPresets: {
      defaultId: 'auto',
      resolve: async (id) => presets.get(id),
      mount: async () => {},
      select: async (_agent, id) => id,
      list: async () => [...presets.values()],
      presetForSession: (s) => s?.header?.agentPreset,
      composedPreset: (c) => (c?.tag === 'agy-ctx' ? 'agy' : undefined),
    },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'github-copilot-live', model: 'gemini-4-neon' }),
    },
    agents: {
      get: () => undefined,
      turnBoundaryOf: () => ({ openTurnStartSeq: null, lastTurn: 0 }),
    },
    sessions: {
      get: () => undefined,
    },
    subagents,
    on: () => () => {},
    effect(cb) {
      const dispose = cb()
      if (typeof dispose === 'function') effectDisposers.push(dispose)
      return dispose
    },
    inject(deps, cb) {
      if (deps.includes('subagents')) {
        cb(fakeCtx)
      }
    },
  }

  apply(fakeCtx, {
    autoPresetId: 'auto',
    geminiPreset: 'agy',
    gptPreset: 'codex',
    fallbackPreset: 'standard',
  })

  // 1) AGY parent spawning gpt-6.1-sol via rc.5 flat startActivation -> routed to codex
  await subagents.startActivation({
    provider: 'spawn',
    label: 'agent-teams:exp:gpt-reviewer',
    parent: agyParent,
    agentOptions: { provider: 'github-copilot-live', model: 'gpt-6.1-sol', reasoningEffort: 'medium' },
  })
  assert.equal(received.at(-1).spec.agentPreset, 'codex')

  // 2) AGY parent spawning gemini-4-carbon -> same family as parent, leaves agentPreset omitted
  await subagents.startActivation({
    provider: 'spawn',
    label: 'agent-teams:exp:gemini-helper',
    parent: agyParent,
    agentOptions: { provider: 'github-copilot-live', model: 'gemini-4-carbon' },
  })
  assert.equal(received.at(-1).spec.agentPreset, undefined)

  // 3) Fork provider (inheritsParentContext: true) -> never injects agentPreset
  await subagents.startActivation({
    provider: 'fork',
    parent: agyParent,
    agentOptions: { provider: 'github-copilot-live', model: 'gpt-6.1-sol' },
  })
  assert.equal(received.at(-1).spec.agentPreset, undefined)

  // 4) Explicit agentPreset is preserved; explicit 'auto' is resolved
  await subagents.startContinuable({
    provider: 'spawn',
    request: {
      parent: agyParent,
      agentPreset: 'standard',
      agentOptions: { provider: 'github-copilot-live', model: 'gpt-6.1-sol' },
    },
  })
  assert.equal(received.at(-1).spec.request.agentPreset, 'standard')

  await subagents.start('spawn', {
    parent: agyParent,
    agentPreset: 'auto',
    agentOptions: { provider: 'github-copilot-live', model: 'gpt-6.1-sol' },
  })
  assert.equal(received.at(-1).request.agentPreset, 'codex')

  // 5) Dispose restores original subagent methods cleanly
  for (const dispose of effectDisposers.reverse()) dispose()
  assert.equal(subagents.startActivation, origStartActivation)
  assert.equal(subagents.startContinuable, origStartContinuable)
  assert.equal(subagents.start, origStart)
})
