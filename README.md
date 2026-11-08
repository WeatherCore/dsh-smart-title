# dsh-smart-title

Smart session titler for DeepSeek Harness (DSH). Fork of ideas from `dsh-turn-title`, with the failure modes fixed.

## What it does

- **Auto-title after the first FULL turn** — waits until the first user message **and** the assistant's complete response are done (turn 1 `completed`), then summarizes the exchange into a session title. Titles are more accurate than prompt-only titlers because they include what the assistant actually did.
- **"✎ Update Title" button** in the chat header (`conversation.session.header.actions`):
  - **Click** — regenerate the title with AI over recent context.
  - **Shift+Click / Alt+Click** — edit the title manually via a prompt box.
- **Language follows DSH UI locale** (en/zh/pt/ja built in).
- **Native theme fit** — uses `--dsw-alias-*` CSS variables, works in dark and light mode.

## Why not dsh-turn-title (the fixes)

| Problem in `dsh-turn-title` | `dsh-smart-title` |
|---|---|
| `maxTokens: 50` hardcoded — thinking models (e.g. GLM-5.3-Flash) burn all 50 tokens on reasoning and the visible title is empty | **No maxTokens cap** — a title costs little; the model can think first |
| `reasoningEffort` copied verbatim from the session header — uncontrolled | Picks the model's **lowest** reasoning effort when the model exposes one |
| Empty output returns `title: null` silently | Throws with a diagnostic (route + effort), endpoint returns the real error, host logs a warning |
| Reasoning blocks can pollute extraction | Only `text` blocks are read for message text |

## Install (local, linked)

In the DSH profile's `package.json` (`~/.dsh/profiles/<name>/`):

1. Add `"dsh-smart-title": "file:D:/1/dsh-smart-title"` to `dependencies`.
2. Add `"dsh-smart-title"` to `dsh.profile.bundles`.
3. Run `pnpm install` in the profile directory and restart DSH.

The bundled `cordis.patch.yml` disables the built-in early titler (`session-title-llm`) so the full-turn titler owns the title.

## API

`POST /api/session-title/update`

```json
{ "sessionId": "session-..." }                    // regenerate with AI
{ "sessionId": "session-...", "title": "新标题" }  // manual rename
```

## License

MIT
