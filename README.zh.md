# dsh-smart-title

DeepSeek Harness (DSH) 智能会话标题插件。基于 `dsh-turn-title` 的思路，修复了其失败模式。

## 功能

- **第一轮完整对话后自动起标题**——等首条用户提问**和助手完整回复**都结束后（turn 1 `completed`），把这段对话总结成会话标题。比“只看首条提问”的内置插件更准确，因为标题包含了助手实际做了什么。
- **聊天顶部“✎ 更新标题”按钮**（`conversation.session.header.actions` 槽位）：
  - **单击**——用 AI 结合最近上下文重新生成标题。
  - **Shift+单击 / Alt+单击**——弹出输入框手动改名。
- **语言跟随 DSH 界面语言**（内置 en/zh/pt/ja）。
- **原生主题融合**——使用 `--dsw-alias-*` CSS 变量，深浅色模式都适配。

## 为什么不是 dsh-turn-title（修复点）

| `dsh-turn-title` 的问题 | `dsh-smart-title` 的做法 |
|---|---|
| 写死 `maxTokens: 50`——思考型模型（如 GLM-5.3-Flash）把 50 个 token 全烧在思考上，正文 0 字 | **不设 maxTokens 上限**——起标题消耗极小，让模型先想清楚再写 |
| `reasoningEffort` 原样照抄会话头——不可控 | 模型暴露推理档位时选**最低档** |
| 空输出静默返回 `title: null` | 抛出带诊断信息（路由+推理档）的错误；端点返回真实错误；host 记 warning |
| reasoning 块可能污染文本提取 | 只读 `text` 块 |

## 安装（本地链接）

在 DSH profile 的 `package.json`（`~/.dsh/profiles/<name>/`）：

1. `dependencies` 加 `"dsh-smart-title": "file:D:/1/dsh-smart-title"`。
2. `dsh.profile.bundles` 加 `"dsh-smart-title"`。
3. profile 目录跑 `pnpm install`，重启 DSH。

插件自带的 `cordis.patch.yml` 会停用内置的早期起标题插件（`session-title-llm`），让“完整一轮”标题接管。

## API

`POST /api/session-title/update`

```json
{ "sessionId": "session-..." }                    // AI 重新生成
{ "sessionId": "session-...", "title": "新标题" }  // 手动改名
```

## 许可

MIT
