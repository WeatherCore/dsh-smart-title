/**
 * dsh-smart-title: Smart session titler for DeepSeek Harness.
 *
 * Auto-generates the session title after the first full turn
 * (first user message + complete assistant response) and offers an
 * "Update Title" button in the chat header.
 *
 * Differences from dsh-turn-title (the upstream this replaces):
 * - No maxTokens cap: thinking models may spend tokens reasoning before
 *   writing the title, and a tiny cap starves the visible output.
 * - Reasoning effort pushed to the model's lowest supported level when the
 *   model exposes one, so titles stay cheap and quick.
 * - Reasoning blocks are skipped; the title comes from text blocks only.
 * - Clear failure surfacing: endpoint returns the real error text, and the
 *   host logs a warning instead of failing silently.
 */

export const name = 'dsh-smart-title';
export const inject = ['sessionTitle', 'llm', 'sessions', 'webServer', 'agents'];

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

/** Build system and user prompt for title generation with language constraint. */
export function buildTitlePrompt(textInput, locale) {
  const langName = resolveLanguageName(locale);
  const langRule = langName
    ? `The title MUST be written in ${langName}.`
    : `Use the primary language of the conversation.`;

  return {
    system:
      'You are a session title generator. Output ONLY a concise plain text title (3-6 words, or 8-16 Chinese characters for Chinese) on a single line. Do not use quotes, Markdown, or ending punctuation. ' +
      langRule,
    userPrompt: `Create a concise, descriptive title for the following exchange.\n${langRule}\nReturn ONLY the plain text title on one line, without quotes, explanations, Markdown, or ending punctuation:\n\n${textInput}`,
  };
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

/** Extract text content from message content blocks, skipping reasoning. */
export function messageText(msg) {
  if (!msg || !Array.isArray(msg.content)) return '';
  return msg.content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join(' ')
    .trim();
}

/** Extract the first user message and first assistant response. */
export function extractFirstExchange(messages) {
  if (!Array.isArray(messages)) return null;
  const userMsg = messages.find((m) => m && m.role === 'user');
  const assistantMsg = messages.find((m) => m && m.role === 'assistant');
  if (!userMsg || !assistantMsg) return null;

  const userText = messageText(userMsg).slice(0, 1000);
  const assistantText = messageText(assistantMsg).slice(0, 1000);
  if (!userText && !assistantText) return null;
  return { userText, assistantText };
}

/** Extract conversation summary for manual/re-triggered title update. */
export function extractConversationSummary(messages) {
  if (!Array.isArray(messages)) return null;
  const userMessages = messages.filter((m) => m && m.role === 'user');
  const assistantMessages = messages.filter((m) => m && m.role === 'assistant');
  if (userMessages.length === 0) return null;

  const firstUser = messageText(userMessages[0]).slice(0, 800);
  const lastUser = messageText(userMessages[userMessages.length - 1]).slice(0, 800);
  const lastAssistant =
    assistantMessages.length > 0
      ? messageText(assistantMessages[assistantMessages.length - 1]).slice(0, 800)
      : '';

  if (userMessages.length <= 1) {
    return `User: ${firstUser}\nAssistant: ${lastAssistant}`;
  }
  return `Initial User Request: ${firstUser}\nLatest User Request: ${lastUser}\nLatest Assistant Response: ${lastAssistant}`;
}

/** Clean raw LLM response into a short, normalized title. */
export function cleanTitle(raw) {
  if (typeof raw !== 'string') return '';
  const firstLine =
    raw
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s.length > 0) || '';
  // Strip Markdown markers, surrounding tags/quotes, and trailing periods
  return firstLine
    .replace(/^<[^>]+>/g, '')
    .replace(/<[^>]+>$/g, '')
    .replace(/^[\s"'`*#\-:]+/u, '')
    .replace(/[\s"'`*.]+$/u, '')
    .trim();
}

/**
 * Resolve the LLM route for title generation: follow the session's current
 * request header, falling back to the default agent selection.
 */
export function resolveRoute(ctx, session) {
  const header = session?.requestHeader?.();
  if (header?.config?.provider && header?.config?.model) {
    return {
      provider: header.config.provider,
      model: header.config.model,
    };
  }
  const defaultModel = ctx?.get?.('agentDefaultModel')?.currentSelection?.();
  if (defaultModel?.provider && defaultModel?.model) {
    return { provider: defaultModel.provider, model: defaultModel.model };
  }
  return null;
}

/**
 * Pick the lowest reasoning effort the route's model exposes, so a thinking
 * model does not burn its budget before writing the title. Async: asks the
 * LLM service for model metadata. Returns undefined when the model exposes
 * no reasoning metadata (passing an unsupported effort would hard-fail).
 */
export async function selectLowestReasoningEffort(ctx, route) {
  try {
    const llm = ctx?.llm ?? ctx?.get?.('llm');
    if (!llm?.resolveModelInfo) return undefined;
    const info = await llm.resolveModelInfo(route.provider, route.model);
    const efforts = info?.reasoning?.efforts;
    if (Array.isArray(efforts) && efforts.length > 0) {
      return efforts[0]?.id;
    }
  } catch {}
  return undefined;
}

/** Generate title via LLM stream and commit to session title service. */
export async function generateTitle(ctx, session, textInput, locale) {
  const route = resolveRoute(ctx, session);
  if (!route) throw new Error('No LLM route available (no session header or default model)');

  const prompt = buildTitlePrompt(textInput, locale);
  const reasoningEffort = await selectLowestReasoningEffort(ctx, route);

  const stream = ctx.llm.stream({
    ...route,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: prompt.userPrompt,
          },
        ],
      },
    ],
    system: prompt.system,
    // No maxTokens cap: a thinking model may spend budget reasoning first;
    // capping it starves the visible title and yields an empty stream.
    temperature: 0.3,
    sessionId: session.id,
    purpose: 'session-title',
  });

  let raw = '';
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') {
      raw += chunk.text;
    }
  }

  const title = cleanTitle(raw);
  if (!title) {
    throw new Error(
      `Title model produced no text (route ${route.provider}/${route.model}` +
        (reasoningEffort ? `, effort ${reasoningEffort}` : '') +
        ')'
    );
  }
  ctx.sessionTitle.rename(session, title);
  return title;
}

export function apply(ctx) {
  // 1. Auto-title after turn 1 completes (first message + full response)
  ctx.on('session/event', async (session, event) => {
    if (
      event.type === 'turn/end' &&
      event.data?.turn === 1 &&
      event.data?.reason?.kind === 'completed'
    ) {
      const current = ctx.sessionTitle.get(session);
      // Only auto-generate if no title or title is still deterministic fallback
      if (!current || current.source?.kind === 'fallback') {
        const messages = session.deriveMessages?.() || [];
        const exchange = extractFirstExchange(messages);
        if (exchange) {
          try {
            const locale = getStoredLocale(ctx);
            await generateTitle(
              ctx,
              session,
              `User: ${exchange.userText}\nAssistant: ${exchange.assistantText}`,
              locale
            );
          } catch (err) {
            ctx.logger?.warn?.('[dsh-smart-title] auto-title failed:', err?.message || err);
          }
        }
      }
    }
  });

  // 2. HTTP endpoint for chat-area button updates
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

            const locale = data.locale || getStoredLocale(ctx);
            let title = data.title;
            if (typeof title === 'string' && title.trim()) {
              title = cleanTitle(title);
              ctx.sessionTitle.rename(session, title);
            } else {
              const messages = session.deriveMessages?.() || [];
              const textInput = extractConversationSummary(messages);
              if (!textInput) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(
                  JSON.stringify({ error: 'No conversation messages to summarize' })
                );
                return;
              }
              title = await generateTitle(ctx, session, textInput, locale);
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, title }));
          } catch (err) {
            ctx.logger?.warn?.('[dsh-smart-title] endpoint error:', err?.message || err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err?.message || String(err) }));
          }
        },
      }),
    'dsh-smart-title: POST /api/session-title/update'
  );
}
