# dsh-auto-mode

English | [简体中文](./README.zh.md)

Adds an **`Auto`** agent preset mode (`id: auto`) to [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) that automatically routes to the matching preset based on the selected model.

## Features

- **Automatic Model-to-Preset Routing**:
  - **Gemini models** (`gemini-*`, `google/gemini-*`, etc.) → **Antigravity mode** (`agy`, provided by [`dsh-agy-mode`](https://github.com/TideDra/dsh-agy-mode))
  - **GPT models** (`gpt-*`, `chatgpt-*`, `openai/gpt-*`, etc.) → **Codex mode** (`codex`, provided by [`dsh-codex-mode`](https://github.com/TideDra/dsh-codex-mode))
  - **Other models** (DeepSeek, Claude, etc.) → **Standard mode** (`standard`, configurable via `fallbackPreset`)
- **Live Switching Before Turn 1**: While a session is blank (before sending the first message), switching models in the composer or via `/model` automatically switches the active preset, recomposes tools and system prompts, and updates mode-specific controls (`AGY Auto/Plan` or `⚡ Ultra`).
- **Session Lock After Turn 1**: Once Turn 1 starts, the matched preset locks into the session log so tool history and prompt caching remain consistent across turns and restarts.
- **Persistent Blank State & Hero Indicator**: Keeps `Auto` selected in the New Session preset picker (and displays an `Auto → <Matched Preset>` badge on the Hero row) across reloads while the session remains blank; gracefully falls back if a target preset is disabled or missing.
- **Cross-Preset Subagent Auto-Routing (`routeSubagents`)**: When a `spawn` subagent (such as an `AgentTeams` member) specifies a cross-family model without an explicit `agentPreset` and the provider supports independent preset selection (`capabilities.agentPreset && !inheritsParentContext`), automatically mounts the matching preset (`gpt-*` → `codex`, `gemini-*` → `agy`, others → `standard`) instead of inheriting the parent's preset. `fork` subagents, same-preset children, and explicit `agentPreset` values remain untouched.

## Installation

Install directly from GitHub into your DSH profile (e.g. `web`):

```sh
dsh plugin --profile web add https://github.com/TideDra/dsh-auto-mode.git -w
```

Or install from a local clone:

```sh
git clone https://github.com/TideDra/dsh-auto-mode.git
dsh plugin --profile web add /path/to/dsh-auto-mode -w
```

> Make sure [`dsh-agy-mode`](https://github.com/TideDra/dsh-agy-mode) (`agy`) and [`dsh-codex-mode`](https://github.com/TideDra/dsh-codex-mode) (`codex`) are installed in the same profile so `Auto` can route to them (if either is absent, `Auto` falls back to `standard`).

## Usage

1. Select **`Auto`** in the New Session preset dropdown, or set **`Auto`** as your **New task default** in **Settings → Agent presets**.
2. Switch models in the composer before sending the first message and observe `Auto` switch presets automatically (`Auto → Antigravity` / `Auto → Codex` / `Auto → Standard mode`).
3. Manually picking another preset exits `Auto` mode for that blank session; sending the first message locks the resolved preset for that conversation.

## Configuration

Configured in `cordis.patch.yml` under the `auto-mode` entry:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `autoPresetId` | `string` | `'auto'` | Preset ID exposed for Auto mode |
| `geminiPreset` | `string` | `'agy'` | Target preset ID for Gemini models |
| `gptPreset` | `string` | `'codex'` | Target preset ID for GPT models |
| `fallbackPreset` | `string` | `'standard'` | Fallback preset ID for non-Gemini / non-GPT models |
| `routeSubagents` | `boolean` | `true` | Automatically route cross-preset `spawn` subagents (e.g. `AgentTeams` members) to their matching model preset |

## Verification

```sh
npm test
npm run test:e2e
```

## License

[MIT](./LICENSE)
