import { importDshPackage } from './dsh-deps.js'

const { default: z } = await importDshPackage('@deepseek-ai/schemastery')

export const name = 'auto-mode-router'

export const Config = z.object({
  geminiPreset: z.string().default('agy'),
  gptPreset: z.string().default('codex'),
  fallbackPreset: z.string().default('standard'),
})

/**
 * Declarative marker inside `preset-auto` so Settings "View configuration" shows
 * the active model-to-preset routing rules while leaking zero root-realm services.
 */
export function apply() {}
