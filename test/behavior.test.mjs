// Behavioral tests for dsh-smart-title pure functions.
// Reads the REAL source file, strips the host-only import, imports, asserts.
import assert from 'node:assert';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = join(here, '..', 'index.js');
let src = readFileSync(sourcePath, 'utf8');
src = src.replace(
  'import { executeSessionTitleLlm } from "@deepseek-ai/dsh-session-title-llm";',
  '// (host-only import stripped for isolated test)'
);
const dir = mkdtempSync(join(tmpdir(), 'dsh-st-'));
const modulePath = join(dir, 'module.mjs');
writeFileSync(modulePath, src, 'utf8');
const {
  cleanTitle, clampUtf8, placeholderFor, buildSystemPrompt, findTurnEnd,
  ensureTurnEnded, firstTitleLine, messageText, buildTitleInput,
} = await import(pathToFileURL(modulePath).href);

// 1. cleanTitle: markdown/tags/quotes/periods/first-line
assert.equal(cleanTitle('**修 smart-title 空标题 bug**'), '修 smart-title 空标题 bug');
assert.equal(cleanTitle('"Fix login redirect".'), 'Fix login redirect');
assert.equal(cleanTitle('<title>Hello</title>'), 'Hello');
assert.equal(cleanTitle('第一行\n\n第二行'), '第一行');
assert.equal(cleanTitle('*Refactor session titling*'), 'Refactor session titling');
assert.equal(cleanTitle(''), '');
assert.equal(cleanTitle(null), '');

// 2. clampUtf8: byte-exact, never splits a code point
assert.equal(clampUtf8('abc', 2), 'ab'); // fills the 2-byte budget exactly
assert.ok(Buffer.byteLength(clampUtf8('中文标题很长很长', 9), 'utf8') <= 9);
assert.equal(clampUtf8('中文标题很长很长', 9), '中文标'); // 3 CJK = 9 bytes
assert.equal(clampUtf8('hello', 100), 'hello');
assert.equal(clampUtf8(undefined, 10), '');

// 3. placeholderFor: locale prefix matching + fallback
assert.equal(placeholderFor('zh-CN'), '⚠ 标题未生成 · 点✎重试');
assert.equal(placeholderFor('zh'), '⚠ 标题未生成 · 点✎重试');
assert.equal(placeholderFor('ja-JP'), '⚠ タイトル未生成 · ✎で再試行');
assert.equal(placeholderFor('de-DE'), '⚠ Title failed · click ✎ to retry');
assert.equal(placeholderFor(undefined), '⚠ Title failed · click ✎ to retry');

// 4. placeholders fit the service title budget (80 bytes)
for (const p of [
  '⚠ 标题未生成 · 点✎重试',
  '⚠ Title failed · click ✎ to retry',
  '⚠ タイトル未生成 · ✎で再試行',
  '⚠ Falha no título · clique ✎ para tentar',
]) assert.ok(Buffer.byteLength(p, 'utf8') <= 80, `placeholder too long: ${p}`);

// 5. buildSystemPrompt: language + length rules present
assert.ok(buildSystemPrompt('zh-CN').includes('Simplified Chinese'));
assert.ok(buildSystemPrompt(undefined).includes('primary language'));
assert.ok(buildSystemPrompt('zh-CN').includes('20 CJK characters'));
assert.ok(buildSystemPrompt('en').includes('10 words'));

// 6. findTurnEnd: latest matching turn, any reason
const evts = [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } },
  { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
];
assert.equal(findTurnEnd(evts, 1)?.data.reason.kind, 'aborted');
assert.equal(findTurnEnd(evts, 3), undefined);
assert.equal(findTurnEnd(undefined, 1), undefined);

// 7. ensureTurnEnded: snapshot / subscribe / race / abort
{
  const done = { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } };
  const s1 = { snapshotEvents: () => [done] };
  assert.equal(await ensureTurnEnded({}, s1, 1, undefined), done.data.reason);

  let listener = null;
  const s2 = { snapshotEvents: () => [] };
  const ctx2 = { on: (_e, fn) => { listener = fn; return () => { listener = null; }; } };
  const p = ensureTurnEnded(ctx2, s2, 1, undefined);
  listener(s2, done); // turn ends after subscribe
  assert.equal(await p, done.data.reason);
  assert.equal(listener, null, 'listener disposed after resolve');

  // race: turn ends between snapshot and subscribe -> re-check resolves
  let snapshotCount = 0;
  const s3 = { snapshotEvents: () => { snapshotCount++; return snapshotCount >= 2 ? [done] : []; } };
  const ctx3 = { on: (_e, fn) => { listener = fn; return () => { listener = null; }; } };
  assert.equal(await ensureTurnEnded(ctx3, s3, 1, undefined), done.data.reason);

  // abort rejects with the signal reason
  const ac = new AbortController();
  const s4 = { snapshotEvents: () => [] };
  const ctx4 = { on: (_e, fn) => { listener = fn; return () => { listener = null; }; } };
  const p4 = ensureTurnEnded(ctx4, s4, 1, ac.signal);
  ac.abort(new Error('superseded'));
  await assert.rejects(p4, /superseded/);
}

// 8. firstTitleLine: whole-line emphasis unwrapped, inline kept
assert.equal(firstTitleLine('**Title here**'), 'Title here');
assert.equal(firstTitleLine('*Title* with text'), '*Title* with text');

// 9. messageText skips reasoning blocks
assert.equal(
  messageText({ content: [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text: 'visible' }] }),
  'visible'
);
assert.equal(messageText(null), '');

// 10. buildTitleInput: last assistant chosen, both shapes within 4KiB
const session = { deriveMessages: () => [
  { role: 'assistant', content: [{ type: 'text', text: '让我看看' }] },
  { role: 'user', content: [{ type: 'text', text: 'LATEST-USER' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'FINAL-DONE' }] },
] };
const one = buildTitleInput(session, { messages: [{ text: '请求A', seq: 5 }] });
assert.ok(one.includes('请求A') && one.includes('FINAL-DONE') && !one.includes('让我看看'));
assert.ok(Buffer.byteLength(one, 'utf8') <= 4096, 'first-turn input within 4KiB');
const many = buildTitleInput(session, { messages: [{ text: 'FIRST', seq: 5 }, { text: 'LAST', seq: 9 }] });
assert.ok(many.includes('FIRST') && many.includes('LAST') && many.includes('FINAL-DONE'));
assert.ok(Buffer.byteLength(many, 'utf8') <= 4096, 'refresh input within 4KiB');

// 11. EXECUTION bounds match the agreed defaults (re-declared here independently)
assert.deepEqual(
  Object.fromEntries(
    readFileSync(sourcePath, 'utf8').match(/const EXECUTION = Object\.freeze\(\{[\s\S]*?\}\);/)[0]
      .match(/(\w+): (\d+)/g).map((s) => s.split(': '))
  ),
  { maxInputBytes: '4096', maxOutputTokens: '4096', timeoutMs: '60000' }
);

console.log('ALL 11 BEHAVIORAL GROUPS PASSED');
