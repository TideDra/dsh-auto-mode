import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolvePackageDirFrom } from '../src/dsh-deps.js'

const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DSH_DIR = resolvePackageDirFrom('@deepseek-ai/dsh')
assert.ok(DSH_DIR, 'Could not locate @deepseek-ai/dsh package directory')

const PROFILE_DIR = process.env.DSH_PROFILE_DIR || join(homedir(), '.dsh', 'profiles', 'web')

const AGY_BUNDLE_DIR = [
  process.env.AGY_BUNDLE_DIR,
  resolve(WORKSPACE_ROOT, '../../dsh-agy-mode'),
  resolve(WORKSPACE_ROOT, '../dsh-agy-mode'),
  join(PROFILE_DIR, 'node_modules', '@local', 'dsh-agy-mode'),
].find((p) => typeof p === 'string' && existsSync(join(p, 'package.json')))

const CODEX_BUNDLE_DIR = [
  process.env.CODEX_BUNDLE_DIR,
  resolve(WORKSPACE_ROOT, '../../dsh-codex-mode'),
  resolve(WORKSPACE_ROOT, '../dsh-codex-mode'),
  join(PROFILE_DIR, 'node_modules', '@local', 'dsh-codex-mode'),
].find((p) => typeof p === 'string' && existsSync(join(p, 'package.json')))

assert.ok(AGY_BUNDLE_DIR, 'Could not locate @local/dsh-agy-mode bundle')
assert.ok(CODEX_BUNDLE_DIR, 'Could not locate @local/dsh-codex-mode bundle')

const { runProfile } = await import(join(DSH_DIR, 'lib/profile-boot.js'))
const { loadLayeredEnv } = await import(
  join(resolvePackageDirFrom('@deepseek-ai/dsh-app-boot'), 'lib/index.js')
)

const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-auto-mode-e2e-'))
const tempHome = join(tempRoot, 'dsh-home')
const tempRuntime = join(tempRoot, 'xdg-runtime')
const tempWorkspace = join(tempRoot, 'workspace')
mkdirSync(tempHome, { recursive: true })
mkdirSync(tempRuntime, { recursive: true })
mkdirSync(tempWorkspace, { recursive: true })

process.env.DSH_HOME = tempHome
process.env.XDG_RUNTIME_DIR = tempRuntime
process.env.XDG_CACHE_HOME = join(tempHome, 'cache')
process.env.XDG_STATE_HOME = join(tempHome, 'state')
process.env.NPM_CONFIG_STORE_DIR = join(tempHome, 'pnpm-store')
process.env.DSH_TELEMETRY_DISABLED = '1'
process.env.OPENAI_API_KEY = 'test-auto-mode-dummy-key'

let booted
let mockServer

try {
  mockServer = createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (c) => {
      raw += c
    })
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(
        `data: ${JSON.stringify({
          id: 'chatcmpl-auto-mode-test',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'auto-mode-ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
        })}\n\ndata: [DONE]\n\n`,
      )
      res.end()
    })
  })
  await new Promise((r) => mockServer.listen(0, '127.0.0.1', r))
  const mockBaseUrl = `http://127.0.0.1:${mockServer.address().port}/v1`

  const extraPatch = join(tempHome, 'auto-mode-mock.patch.yml')
  writeFileSync(
    extraPatch,
    [
      '- id: llm-pi-ai',
      '  name: "@deepseek-ai/dsh-llm-pi-ai"',
      '  config:',
      '    providers:',
      '      auto-test-proxy:',
      '        displayName: Auto Test Proxy',
      '        apiKeyEnv: OPENAI_API_KEY',
      '        api: openai-completions',
      `        baseURL: ${JSON.stringify(mockBaseUrl)}`,
      '        models:',
      '          - id: gemini-4-hydrogen',
      '            name: Gemini 4 Hydrogen',
      '            contextWindow: 1048576',
      '            maxTokens: 65536',
      '            input: [text, image]',
      '          - id: gpt-6.1-sol',
      '            name: GPT-6.1 Sol',
      '            contextWindow: 1050000',
      '            maxTokens: 128000',
      '            input: [text, image]',
      '          - id: claude-sonnet-4.6',
      '            name: Claude Sonnet 4.6',
      '            contextWindow: 200000',
      '            maxTokens: 16384',
      '            input: [text]',
      '- id: agent-default-model',
      '  name: "@deepseek-ai/dsh-agent-default-model"',
      '  config:',
      '    provider: auto-test-proxy',
      '    model: gemini-4-hydrogen',
    ].join('\n'),
  )

  const port = 22000 + Math.floor(Math.random() * 4000)
  booted = await runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: 'web',
    patchFiles: [extraPatch],
    args: ['--port', String(port), '--no-open'],
  })

  const { ctx } = booted
  const pluginManager = ctx.get('pluginManager')
  assert.ok(pluginManager, 'pluginManager must be mounted')

  if (AGY_BUNDLE_DIR && existsSync(join(AGY_BUNDLE_DIR, 'package.json'))) {
    const res = await pluginManager.installBundle(AGY_BUNDLE_DIR)
    assert.equal(res.application, 'applied')
  }
  if (CODEX_BUNDLE_DIR && existsSync(join(CODEX_BUNDLE_DIR, 'package.json'))) {
    const res = await pluginManager.installBundle(CODEX_BUNDLE_DIR)
    assert.equal(res.application, 'applied')
  }

  const autoInstall = await pluginManager.installBundle(WORKSPACE_ROOT)
  assert.equal(
    autoInstall.application,
    'applied',
    `Expected @local/dsh-auto-mode to apply cleanly, got: ${JSON.stringify(autoInstall)}`,
  )

  // 1. Verify bundle, preset roster, YAML document, clientModules, and metadata
  const agentPresets = ctx.get('agentPresets')
  const roster = await agentPresets.remoteExportList()
  const autoEntry = roster.presets.find((p) => p.id === 'auto')
  assert.ok(autoEntry, 'Auto preset must appear in remoteExportList()')
  assert.equal(autoEntry.name, 'Auto')
  assert.equal(autoEntry.broken, undefined, `Auto preset must be healthy, got: ${autoEntry.broken}`)

  const doc = await agentPresets.readDocument('auto')
  assert.ok(doc.content.includes('@local/dsh-auto-mode/preset'))

  const clientModules = ctx.get('clientModules')
  assert.ok(
    clientModules.graph().entries.some((e) => e.id === '@local/dsh-auto-mode'),
    'Expected @local/dsh-auto-mode in clientModules graph',
  )

  const inventory = ctx.get('pluginInventory')
  if (inventory && typeof inventory.snapshot === 'function') {
    const snap = await inventory.snapshot()
    const invAuto = snap.bundles.find((b) => b.packageName === '@local/dsh-auto-mode')
    assert.ok(invAuto, 'Expected @local/dsh-auto-mode in pluginInventory')
    assert.deepEqual(invAuto.diagnostics ?? [], [], `Expected zero bundle diagnostics, got: ${JSON.stringify(invAuto.diagnostics)}`)
  }

  const enMeta = JSON.parse(readFileSync(join(WORKSPACE_ROOT, 'locale', 'en.json'), 'utf8'))
  const zhMeta = JSON.parse(readFileSync(join(WORKSPACE_ROOT, 'locale', 'zh.json'), 'utf8'))
  assert.ok(enMeta.meta.title && enMeta.meta.description)
  assert.ok(zhMeta.meta.title && zhMeta.meta.description)
  const iconSize = statSync(join(WORKSPACE_ROOT, 'icon.svg')).size
  assert.ok(iconSize > 100 && iconSize < 256 * 1024)

  // Verify preset-auto itself leaks zero services
  const compositions = agentPresets.inspectCompositions()
  for (const comp of compositions) {
    assert.deepEqual(comp.leakedServices, [], `Leaked services in ${comp.id}`)
  }

  // 2. Verify session creation + model-driven auto preset switching
  const workspaceRegistry = ctx.get('workspaceRegistry')
  const sessionController = ctx.get('sessionController')
  const commandsSvc = ctx.get('commands')
  const ws = await workspaceRegistry.create(tempWorkspace, 'Auto Test Workspace')

  const created = await sessionController.create({
    workspaceId: ws.id,
    agentPreset: 'auto',
  })
  const sid = created.sessionId
  assert.equal(created.agentPreset, 'agy', 'Gemini default model should select Antigravity (agy)')

  const agent = ctx.agents.get(sid)
  assert.ok(agent, 'Live agent must exist')
  const signal = new AbortController().signal

  const checkToolNames = async (modelId) => {
    const toolSet = await ctx.tools.resolve({
      agent,
      modelSelection: { provider: 'auto-test-proxy', model: modelId },
      signal,
    })
    try {
      return [...toolSet.view(agent).keys()]
    } finally {
      toolSet.dispose()
    }
  }

  // Gemini -> Antigravity tools & /agy-mode command
  let tools = await checkToolNames('gemini-4-hydrogen')
  assert.ok(tools.includes('read_file') && tools.includes('run_command'), `Expected agy tools, got: ${tools}`)
  assert.ok(commandsSvc.list(agent).some((c) => c.name === 'agy-mode'))

  // Switch model to GPT -> Codex preset, Codex tools, /ultra command
  await sessionController.selectModel({
    sessionId: sid,
    provider: 'auto-test-proxy',
    model: 'gpt-6.1-sol',
  })
  assert.equal(agentPresets.presetForSession(agent.session), 'codex')
  tools = await checkToolNames('gpt-6.1-sol')
  assert.ok(tools.includes('exec') && tools.includes('wait'), `Expected codex tools, got: ${tools}`)
  assert.ok(!tools.includes('read_file'), 'Antigravity tools must be gone after switching to Codex')
  assert.ok(commandsSvc.list(agent).some((c) => c.name === 'ultra'))
  assert.ok(!commandsSvc.list(agent).some((c) => c.name === 'agy-mode'))

  // Switch model to Claude -> Standard preset
  await sessionController.selectModel({
    sessionId: sid,
    provider: 'auto-test-proxy',
    model: 'claude-sonnet-4.6',
  })
  assert.equal(agentPresets.presetForSession(agent.session), 'standard')
  tools = await checkToolNames('claude-sonnet-4.6')
  assert.ok(tools.includes('bash') && tools.includes('read'), `Expected standard tools, got: ${tools}`)

  // Switch back to Gemini -> Antigravity preset
  await sessionController.selectModel({
    sessionId: sid,
    provider: 'auto-test-proxy',
    model: 'gemini-4-hydrogen',
  })
  assert.equal(agentPresets.presetForSession(agent.session), 'agy')

  // Explicit manual preset selection exits Auto mode
  await agentPresets.select(agent, 'codex')
  assert.equal(agentPresets.presetForSession(agent.session), 'codex')
  await sessionController.selectModel({
    sessionId: sid,
    provider: 'auto-test-proxy',
    model: 'gemini-4-hydrogen',
  })
  assert.equal(
    agentPresets.presetForSession(agent.session),
    'codex',
    'Manual preset must NOT be overridden when Auto mode is inactive',
  )

  // Re-enter Auto mode via agentPresets.select(agent, 'auto')
  await agentPresets.select(agent, 'auto')
  assert.equal(agentPresets.presetForSession(agent.session), 'agy')

  // Verify /api/local/auto-mode/state rejects unauthenticated requests & works with valid session cookie
  const webOrigin = ctx.get('webServer').getOrigin()
  const unauthResp = await globalThis.fetch(`${webOrigin}/api/local/auto-mode/state`)
  assert.equal(unauthResp.status, 401, 'Unauthenticated request must be rejected with 401')

  const launchUrl = ctx.connection.authenticatedUrl(`${webOrigin}/`)
  const authExchange = await globalThis.fetch(launchUrl, { redirect: 'manual' })
  const rawSetCookie = authExchange.headers.get('set-cookie')
  assert.ok(rawSetCookie, 'Root token URL must mint an authenticated session cookie')
  const sessionCookie = rawSetCookie.split(';')[0]

  const stateResp = await globalThis.fetch(`${webOrigin}/api/local/auto-mode/state`, {
    method: 'GET',
    headers: { cookie: sessionCookie },
  })
  assert.equal(stateResp.status, 200)
  const statePayload = await stateResp.json()
  assert.equal(statePayload.ok, true)
  assert.deepEqual(statePayload.sessions[sid], { auto: true, resolvedPreset: 'agy' })

  // Start Turn 1 -> locks preset and clears Auto blank state
  await sessionController.prompt(
    {
      sessionId: sid,
      content: [{ type: 'text', text: 'hello' }],
      requestId: 'req-auto-1',
    },
    signal,
  )
  await agent.whenIdle()

  const stateRespAfterTurn = await globalThis.fetch(`${webOrigin}/api/local/auto-mode/state`, {
    method: 'GET',
    headers: { cookie: sessionCookie },
  })
  const stateAfterTurn = await stateRespAfterTurn.json()
  assert.equal(stateAfterTurn.sessions[sid], undefined, 'Started session must exit blank Auto tracking')

  await sessionController.selectModel({
    sessionId: sid,
    provider: 'auto-test-proxy',
    model: 'gpt-6.1-sol',
  })
  assert.equal(
    agentPresets.presetForSession(agent.session),
    'agy',
    'Locked session after Turn 1 must keep its preset when changing models mid-chat',
  )

  console.log('E2E isolated Web profile verification passed!')
} catch (err) {
  console.error('Verification error:', err)
  process.exitCode = 1
} finally {
  if (booted !== undefined) {
    await booted.ctx.fiber.dispose().catch(() => {})
  }
  if (mockServer !== undefined) {
    await new Promise((r) => mockServer.close(r))
  }
  rmSync(tempRoot, { recursive: true, force: true })
}
process.exit(process.exitCode ?? 0)
