export const DEFAULT_AUTO_PRESET_ID = 'auto'
export const DEFAULT_GEMINI_PRESET = 'agy'
export const DEFAULT_GPT_PRESET = 'codex'
export const DEFAULT_FALLBACK_PRESET = 'standard'

const GEMINI_MODEL_RE = /(?:^|[^a-z0-9])gemini/i
const GPT_MODEL_RE = /(?:^|[^a-z0-9])(?:chat)?gpt/i

function normalizePresetId(value, fallback) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : fallback
}

/**
 * Normalize plugin configuration while guarding against self-referential loops.
 * @param {Record<string, unknown>} [raw]
 */
export function resolveAutoConfig(raw = {}) {
  const autoPresetId = normalizePresetId(raw?.autoPresetId, DEFAULT_AUTO_PRESET_ID)
  const sanitizeTarget = (value, defaultTarget) => {
    const candidate = normalizePresetId(value, defaultTarget)
    if (candidate === autoPresetId) {
      return defaultTarget === autoPresetId ? DEFAULT_FALLBACK_PRESET : defaultTarget
    }
    return candidate
  }
  return Object.freeze({
    autoPresetId,
    geminiPreset: sanitizeTarget(raw?.geminiPreset, DEFAULT_GEMINI_PRESET),
    gptPreset: sanitizeTarget(raw?.gptPreset, DEFAULT_GPT_PRESET),
    fallbackPreset: sanitizeTarget(raw?.fallbackPreset, DEFAULT_FALLBACK_PRESET),
    routeSubagents: raw?.routeSubagents !== false,
  })
}

/**
 * Classify a model selection into `'gemini' | 'gpt' | 'other'`.
 * @param {{ provider?: unknown; model?: unknown } | string | null | undefined} selection
 * @returns {'gemini' | 'gpt' | 'other'}
 */
export function classifyModelFamily(selection) {
  const model =
    typeof selection === 'string'
      ? selection
      : typeof selection?.model === 'string'
        ? selection.model
        : ''
  const trimmed = model.trim()
  if (trimmed.length === 0) return 'other'
  if (GEMINI_MODEL_RE.test(trimmed)) return 'gemini'
  if (GPT_MODEL_RE.test(trimmed)) return 'gpt'
  return 'other'
}

/**
 * Compute the desired concrete preset ID for a model selection.
 * @param {{ provider?: unknown; model?: unknown } | string | null | undefined} selection
 * @param {ReturnType<typeof resolveAutoConfig>} [config]
 */
export function desiredPresetForModel(selection, config = resolveAutoConfig()) {
  const family = classifyModelFamily(selection)
  switch (family) {
    case 'gemini':
      return config.geminiPreset
    case 'gpt':
      return config.gptPreset
    default:
      return config.fallbackPreset
  }
}

/**
 * Pick the first healthy, available preset from candidate preferences, avoiding `autoPresetId`.
 * @param {{
 *   selection: { provider?: unknown; model?: unknown } | string | null | undefined;
 *   config: ReturnType<typeof resolveAutoConfig>;
 *   resolvePreset: (id: string) => Promise<{ id: string; broken?: string } | undefined>;
 *   listPresets: () => Promise<Array<{ id: string; broken?: string }>>;
 * }} params
 */
export async function resolveHealthyTarget({ selection, config, resolvePreset, listPresets }) {
  const preferred = desiredPresetForModel(selection, config)
  const candidates = []
  for (const id of [preferred, config.fallbackPreset, DEFAULT_FALLBACK_PRESET]) {
    if (id && id !== config.autoPresetId && !candidates.includes(id)) {
      candidates.push(id)
    }
  }

  for (const id of candidates) {
    try {
      const resolved = await resolvePreset(id)
      if (resolved !== undefined && resolved.broken === undefined && resolved.id !== config.autoPresetId) {
        return resolved.id
      }
    } catch {
      // Try next candidate
    }
  }

  const all = await listPresets()
  const healthy = all.find((row) => row.id !== config.autoPresetId && row.broken === undefined)
  if (healthy !== undefined) {
    return healthy.id
  }

  throw new Error(
    `Auto preset could not resolve a healthy target preset (tried: ${candidates.join(', ')})`,
  )
}
