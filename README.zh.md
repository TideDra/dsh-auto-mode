# dsh-auto-mode

[English](./README.md) | 简体中文

为 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 添加名为 **`Auto`** 的预设模式（`id: auto`），根据所选模型自动选择对应的 Agent 预设模式。

## 功能特性

- **按模型自动匹配预设**：
  - **Gemini 模型**（`gemini-*`、`google/gemini-*` 等）→ 自动匹配 **Antigravity mode**（`agy`，来自 [`dsh-agy-mode`](https://github.com/TideDra/dsh-agy-mode)）
  - **GPT 模型**（`gpt-*`、`chatgpt-*`、`openai/gpt-*` 等）→ 自动匹配 **Codex mode**（`codex`，来自 [`dsh-codex-mode`](https://github.com/TideDra/dsh-codex-mode)）
  - **其他模型**（DeepSeek、Claude 等）→ 默认回退到 **标准模式**（`standard`，可通过 `fallbackPreset` 配置）
- **首轮消息前动态联动**：在新建/空白会话（发送第一条消息前）通过模型选择器或 `/model` 切换模型时，自动重挂载对应预设的工具集、系统提示词以及专属开关（如 `AGY Auto/Plan` 或 `⚡ Ultra`）。
- **首轮开始后自动锁定**：第一轮对话开始后自动锁定该会话的最终预设模式，确保工具历史与 Prompt Cache 语义一致。
- **空白期持久化与状态提示**：新建会话栏保持选中 **`Auto`**，并在右侧展示实时匹配标签（`自动 → Antigravity` / `自动 → Codex` / `自动 → 标准模式`），页面刷新或 Host 重启仍可保留空白会话的 Auto 状态；目标预设缺失时安全回退。
- **跨预设子代理自动路由（`routeSubagents`）**：当支持独立预设的 `spawn` 子代理（例如 `AgentTeams` 异构模型成员）显式指定了跨家族模型且未手写 `agentPreset` 时，自动为其挂载匹配的预设（`gpt-*` → `codex`、`gemini-*` → `agy`、其他 → `standard`），避免 GPT 子代理继续继承父会话的 `Antigravity` 预设；`fork` 子代理、与父会话同预设的子代理以及显式指定过 `agentPreset` 的调用不受影响。

## 安装

可直接通过 GitHub 仓库安装到 DSH Profile（如 `web`）：

```sh
dsh plugin --profile web add https://github.com/TideDra/dsh-auto-mode.git -w
```

或克隆到本地后安装：

```sh
git clone https://github.com/TideDra/dsh-auto-mode.git
dsh plugin --profile web add /path/to/dsh-auto-mode -w
```

> 请确保同一 Profile 中已安装 [`dsh-agy-mode`](https://github.com/TideDra/dsh-agy-mode)（`agy`）与 [`dsh-codex-mode`](https://github.com/TideDra/dsh-codex-mode)（`codex`）；若某一目标预设未安装或不可用，`Auto` 会自动回退到 `standard`。

## 使用方式

1. 在新建会话的预设下拉框中选择 **`Auto`**，或在 **「设置 → Agent 预设」** 中将 **`Auto`** 设为新任务默认预设。
2. 在发送首条消息前切换模型，`Auto` 会自动切换至对应的预设模式（右侧状态提示同步更新）。
3. 手动选择其他具体预设会退出该空白会话的 `Auto` 模式；发送首条消息后该会话将锁定最终匹配的预设。

## 配置项

可在 `cordis.patch.yml` 的 `auto-mode` 条目下配置：

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `autoPresetId` | `string` | `'auto'` | Auto 模式注册的预设 ID |
| `geminiPreset` | `string` | `'agy'` | Gemini 模型对应的预设 ID |
| `gptPreset` | `string` | `'codex'` | GPT 模型对应的预设 ID |
| `fallbackPreset` | `string` | `'standard'` | 非 Gemini / GPT 模型的回退预设 ID |
| `routeSubagents` | `boolean` | `true` | 是否对支持独立预设的 `spawn` 子代理（如 `AgentTeams` 成员）按目标模型自动路由预设 |

## 测试验证

```sh
npm test
npm run test:e2e
```

## 许可证

[MIT](./LICENSE)
