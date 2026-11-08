/**
 * dsh-smart-title: Smart session titler for DeepSeek Harness.
 *
 * Registers a provider with the official `sessionTitle` service. The service
 * schedules one generation after the first human message; `generate()` then
 * waits for the first FULL turn to end (any end reason: completed, aborted,
 * error, blocked, max-tokens — `turn/end` is always appended in the agent
 * loop's `finally`) before summarizing the exchange into a title.
 *
 * Design notes (agreed 2026-11-08):
 * - Reasoning effort is copied verbatim from the session's current request
 *   header — the title request uses exactly what the conversation window
 *   uses. No effort is picked or lowered here.
 * - LLM execution reuses @deepseek-ai/dsh-session-title-llm: 60s deadline,
 *   4 KiB input bound, `session/title-llm-request` audit event, stream
 *   assembly, and finish-reason validation all come from the shared library.
 * - On failure a short localized placeholder title is committed instead of
 *   failing silently; clicking the header ✎ button (refresh) retries it.
 * - User-renamed (pinned) titles are never touched by the automatic path —
 *   the service enforces the pin; the ✎ button is the explicit override.
 * - Sessions titled by the scheduler (scheduled-task deliveries rename via
 *   `rename()` and pin) and subagent/seeded sessions are excluded by the
 *   service itself, matching the agreed coverage.
 */

import { executeSessionTitleLlm } from "@deepseek-ai/dsh-session-title-llm";

export const name = "dsh-smart-title";
export const inject = ["sessionTitle", "llm", "sessions", "webServer", "agents"];

/** Provider identity recorded with every title event and audit record. */
const PROVIDER_ID = "dsh-smart-title";
/** The provider titles the first full conversation turn. */
const TITLE_TURN = 1;
/**
 * Sessions with an explicit ✎-button refresh in flight. The service's
 * refresh() cannot pass caller intent through, so the endpoint marks the
 * session and generate() consumes the marker: an explicit regeneration
 * summarizes the conversation as it stands instead of waiting for turn 1
 * to end (agreed Q6-⑤).
 */
const refreshWanted = new WeakSet();
/** Shared execution policy for the auxiliary title request. */
const EXECUTION = Object.freeze({
  maxInputBytes: 4096,
  maxOutputTokens: 4096,
  timeoutMs: 60000,
});

/** Human-readable language names for the title-language constraint. */
export const LANGUAGE_NAMES = {
  en: 'English',
  zh: 'Chinese (中文)',
  'zh-CN': 'Simplified Chinese (简体中文)',
  'zh-TW': 'Traditional Chinese (繁體中文)',
  pt: 'Portuguese (Português)',
  'pt-BR': 'Portuguese (Português do Brasil)',
  es: 'Spanish (Español)',
  fr: 'French (Français)',
  de: 'German (Deutsch)',
  ja: 'Japanese (日本語)',
  ko: 'Korean (한국어)',
  ru: 'Russian (Русский)',
  it: 'Italian (Italiano)',
};

/** Resolve human-readable language name from a locale tag. */
export function resolveLanguageName(code) {
  if (!code || typeof code !== 'string') return null;
  const trimmed = code.trim();
  if (LANGUAGE_NAMES[trimmed]) return LANGUAGE_NAMES[trimmed];
  const prefix = trimmed.split('-')[0].toLowerCase();
  return LANGUAGE_NAMES[prefix] || trimmed;
}

/** Retrieve stored locale preference from DSH settings if available. */
export function getStoredLocale(ctx) {
  try {
    const descriptors = ctx?.get?.('settings')?.describe?.();
    const loc = descriptors?.find(
      (d) => d && (d.ns === 'locale' || d.ns === 'include:locale')
    );
    if (loc?.value && typeof loc.value === 'object' && loc.value.preference) {
      return loc.value.preference;
    }
  } catch {}
  return undefined;
}

/** Localized placeholder committed when automatic title generation fails. */
const PLACEHOLDERS = {
  en: '⚠ Title failed · click ✎ to retry',
  zh: '⚠ 标题未生成 · 点✎重试',
  ja: '⚠ タイトル未生成 · ✎で再試行',
  pt: '⚠ Falha no título · clique ✎ para tentar',
};

/** Pick the failure placeholder for a locale tag (defaults to English). */
export function placeholderFor(locale) {
  const key =
    typeof locale === 'string' ? locale.trim().split('-')[0].toLowerCase() : '';
  return PLACEHOLDERS[key] ?? PLACEHOLDERS.en;
}

/**
 * System prompt for the title request: action+object style, concrete anchors,
 * bounded length, language following the DSH UI locale.
 */
export function buildSystemPrompt(locale) {
  const langName = resolveLanguageName(locale);
  const langRule = langName
    ? `The title MUST be written in ${langName}.`
    : `Write the title in the primary language of the conversation.`;
  return [
    'You generate session titles for an AI coding assistant.',
    'Name the ACTION and OBJECT of the exchange — what was actually being done — never a generic topic label.',
    'Prefer a verb phrase, for example: "Fix login redirect", "Implement title provider", "修 smart-title 空标题 bug".',
    'When the exchange mentions a concrete project, module, or file name, include it in the title.',
    langRule,
    'Length: at most 10 words in non-CJK languages, or at most 20 CJK characters.',
    'Output ONLY the title on one line: plain text, no quotes, no Markdown, no ending punctuation, no explanation.',
  ].join('\n');
}

/** UTF-8-safe clamp: longest leading text within a byte budget. */
export function clampUtf8(text, maxBytes) {
  const value = typeof text === 'string' ? text : '';
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let output = '';
  let used = 0;
  for (const character of value) {
    const bytes = Buffer.byteLength(character, 'utf8');
    if (used + bytes > maxBytes) break;
    output += character;
    used += bytes;
  }
  return output;
}

/** Extract text content from message content blocks, skipping reasoning. */
export function messageText(msg) {
  if (!msg || !Array.isArray(msg.content)) return '';
  return msg.content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join(' ')
    .trim();
}

/**
 * Build the bounded title input. First-turn path: first user message plus the
 * first assistant response. Refresh path (✎ button): initial request, latest
 * request, latest response. Assistant texts come from derived messages; human
 * texts come from the service-provided eligible-message snapshot.
 */
export function buildTitleInput(session, request) {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  const firstUser = messages[0]?.text ?? '';
  const lastUser = messages[messages.length - 1]?.text ?? '';
  const derived = session?.deriveMessages?.() ?? [];
  const assistants = derived.filter((m) => m && m.role === 'assistant');
  // The LAST assistant message: multi-step first turns produce several
  // assistant messages; the final one summarizes what was actually done.
  const lastAssistant =
    assistants.length > 0
      ? messageText(assistants[assistants.length - 1])
      : '';

  if (messages.length <= 1) {
    return `User: ${clampUtf8(firstUser, 1400)}\nAssistant: ${clampUtf8(lastAssistant, 2500)}`;
  }
  return `Initial request: ${clampUtf8(firstUser, 1000)}\nLatest request: ${clampUtf8(lastUser, 700)}\nLatest response: ${clampUtf8(lastAssistant, 2100)}`;
}

/** Find the latest `turn/end` event for one turn number in an event list. */
export function findTurnEnd(events, turn) {
  const list = Array.isArray(events) ? events : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const event = list[i];
    if (event?.type === 'turn/end' && event.data?.turn === turn) return event;
  }
  return undefined;
}

function abortError(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error('title generation cancelled');
}

/**
 * Resolve once the given turn has ended, with any end reason. Checks the
 * snapshot first, then subscribes; re-checks after subscribing so a turn that
 * ends between the two steps cannot be missed. Rejects when the caller's
 * signal aborts (superseded rename, session disposal, plugin unload).
 */
export function ensureTurnEnded(ctx, session, turn, signal) {
  const existing = findTurnEnd(session?.snapshotEvents?.() ?? [], turn);
  if (existing) return Promise.resolve(existing.data?.reason);
  if (signal?.aborted) return Promise.reject(abortError(signal));

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      settle(value);
    };
    const disposer = ctx.on('session/event', (eventSession, event) => {
      if (eventSession !== session) return;
      if (event.type !== 'turn/end' || event.data?.turn !== turn) return;
      finish(resolve, event.data?.reason);
    });
    const onAbort = () => finish(reject, abortError(signal));
    signal?.addEventListener('abort', onAbort, { once: true });
    function cleanup() {
      signal?.removeEventListener?.('abort', onAbort);
      try {
        disposer?.();
      } catch {}
    }
    // Re-check: the turn may have ended between the snapshot and the subscribe.
    const raced = findTurnEnd(session?.snapshotEvents?.() ?? [], turn);
    if (raced) finish(resolve, raced.data?.reason);
  });
}

/** First non-empty line of model output, unwrapping whole-line emphasis. */
export function firstTitleLine(raw) {
  const line =
    String(raw ?? '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s.length > 0) ?? '';
  // Backreference: the closing marker must exactly equal the opening one, so
  // greedy backtracking cannot steal a closer asterisk into the inner group.
  const match = /^(?<marker>\*{1,3})(?<inner>\S(?:.*\S)?)\k<marker>$/u.exec(line);
  const { marker, inner } = match?.groups ?? {};
  return marker === undefined || inner === undefined || inner.includes(marker)
    ? line
    : inner;
}

/** Clean raw model output into a short, normalized title. */
export function cleanTitle(raw) {
  if (typeof raw !== 'string') return '';
  const line = firstTitleLine(raw);
  // Strip surrounding tags/quotes, markdown markers, and trailing periods.
  return line
    .replace(/^<[^>]+>/g, '')
    .replace(/<[^>]+>$/g, '')
    .replace(/^[\s"'`*#\-:]+/u, '')
    .replace(/[\s"'`*.]+$/u, '')
    .trim();
}

/** Find a live session by ID. */
export function findSession(ctx, sessionId) {
  let session = ctx.sessions?.get?.(sessionId);
  if (!session && ctx.agents?.get) {
    session = ctx.agents.get(sessionId)?.session;
  }
  if (!session && ctx.sessions?.list) {
    session = ctx.sessions.list().find((s) => s && s.id === sessionId);
  }
  if (!session && ctx.agents?.list) {
    session = ctx.agents.list().map((a) => a.session).find((s) => s && s.id === sessionId);
  }
  return session;
}

/** Reject terminal tool-call or max-token outcomes; join the text blocks. */
function extractResponseText(response) {
  const finish = response?.finish?.kind;
  if (finish === 'tool-calls') {
    throw new Error('title output must contain text only');
  }
  if (finish === 'max-tokens') {
    throw new Error('title output reached maxOutputTokens');
  }
  return (response?.blocks ?? [])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join(' ');
}

export function apply(ctx) {
  // 1. Title provider on the official session-title service. The service
  //    schedules the call after the first human message, enforces the
  //    user-rename pin, supersedes in-flight work, and records the title as
  //    a `provider`-sourced session/title event.
  ctx.sessionTitle.register({
    id: PROVIDER_ID,
    automatic: 'first-prompt',
    async generate(request) {
      const { session, signal } = request;
      try {
        if (signal?.aborted) throw abortError(signal);
        // Explicit ✎-button refresh: summarize the conversation as it stands.
        // Automatic path: wait for the first FULL turn to end (any end reason).
        if (refreshWanted.delete(session)) {
          // already current; nothing to wait for
        } else {
          await ensureTurnEnded(ctx, session, TITLE_TURN, signal);
        }
        const locale = getStoredLocale(ctx);
        const input = buildTitleInput(session, request);
        // Reasoning effort: exactly the conversation window's current choice
        // (verbatim header value; undefined means the adapter default, the
        // same default the main request resolved to).
        const sessionEffort = session.requestHeader?.()?.config?.reasoningEffort;
        const response = await executeSessionTitleLlm(
          ctx,
          EXECUTION,
          request,
          PROVIDER_ID,
          {
            system: buildSystemPrompt(locale),
            input,
            messageSeqs: request.messages.map((message) => message.seq),
            selectReasoningEffort: () => sessionEffort,
          }
        );
        const title = cleanTitle(extractResponseText(response));
        if (!title) throw new Error('title model produced no text');
        return {
          title,
          messageSeqs: request.messages.map((message) => message.seq),
          model: response.model,
        };
      } catch (err) {
        const first = request.messages[0];
        if (signal?.aborted || !first) throw err;
        ctx.logger?.warn?.(
          `[dsh-smart-title] title generation failed for session ${session.id}: ${err?.message || err}`
        );
        // Visible failure: a placeholder title the ✎ button can retry over.
        return {
          title: placeholderFor(getStoredLocale(ctx)),
          messageSeqs: [first.seq],
        };
      }
    },
  });

  // 2. HTTP endpoint for the chat-header button: manual rename (title given)
  //    or explicit AI regeneration via the service's refresh.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/api/session-title/update',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Method not allowed' }));
            return;
          }

          let body = '';
          for await (const chunk of req) {
            body += chunk;
          }

          try {
            const data = JSON.parse(body || '{}');
            const sessionId = data.sessionId;
            if (!sessionId) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'sessionId required' }));
              return;
            }

            const session = findSession(ctx, sessionId);
            if (!session) {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Session not found' }));
              return;
            }

            const title = data.title;
            if (typeof title === 'string' && title.trim()) {
              const cleaned = cleanTitle(title);
              const snapshot = ctx.sessionTitle.rename(session, cleaned);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, title: snapshot?.title ?? cleaned }));
            } else {
              // Explicit click authorizes regeneration over the whole
              // conversation as it stands; the service supersedes older
              // work itself.
              refreshWanted.add(session);
              try {
                const snapshot = await ctx.sessionTitle.refresh(session);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, title: snapshot?.title ?? null }));
              } finally {
                refreshWanted.delete(session);
              }
            }
          } catch (err) {
            ctx.logger?.warn?.(
              '[dsh-smart-title] endpoint error:',
              err?.message || err
            );
            const status = err?.name === 'SessionTitleInvalidError' ? 400 : 500;
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err?.message || String(err) }));
          }
        },
      }),
    'dsh-smart-title: POST /api/session-title/update'
  );
}
