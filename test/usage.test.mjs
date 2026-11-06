import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, appendFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexUsage, claudeUsage, latestCodexUsage, loadCodexUsage, locateCodexSession } from '../src/usage.mjs';
import { formatAgentTokenRow, formatAgentTokens, formatTokens, formatStatus, selectAgent, recordClaude } from '../src/status.mjs';

const sessionId = '019a4d90-0000-7000-8000-000000000001';
function event(overrides = {}) {
  return { type: 'event_msg', timestamp: '2026-11-05T00:00:00Z', payload: { type: 'token_count', info: {
    total_token_usage: { input_tokens: 90000, output_tokens: 10000, total_tokens: 100000, cached_input_tokens: 80000, reasoning_output_tokens: 5000 },
    last_token_usage: { input_tokens: 36000, output_tokens: 4000, total_tokens: 40000, cached_input_tokens: 20000, reasoning_output_tokens: 3000 },
    model_context_window: 200000, ...overrides,
  } } };
}
async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), 'tokenbar-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('Codex usage excludes cached input while context includes it and reasoning is not added twice', () => {
  const usage = codexUsage(event());
  assert.equal(usage.total, 20000);
  assert.equal(usage.input, 10000);
  assert.equal(usage.cachedInput, 80000);
  assert.equal(usage.output, 10000);
  assert.equal(usage.totalIncludingCached, 100000);
  assert.equal(usage.contextUsed, 40000);
  assert.equal(usage.percent, 20);
  assert.equal(formatStatus(usage), 'Tokens 20k | Context 40k/200k 20%');
});

test('the reported screenshot sample matches Codex /status 117K instead of 1.5M', () => {
  const usage = codexUsage(event({ total_token_usage: {
    input_tokens: 1425644, cached_input_tokens: 1338880, output_tokens: 30571,
    total_tokens: 1456215,
  } }));
  assert.equal(usage.input, 86764);
  assert.equal(usage.output, 30571);
  assert.equal(usage.total, 117335);
  assert.equal(usage.totalIncludingCached, 1456215);
  assert.match(formatStatus(usage), /^Tokens 117\.3k \|/);
});

test('Codex handles uncached, fully cached and older records with no cached-input field', () => {
  for (const [counters, expected] of [
    [{ input_tokens: 100, cached_input_tokens: 0, output_tokens: 20 }, 120],
    [{ input_tokens: 100, cached_input_tokens: 100, output_tokens: 20 }, 20],
    [{ input_tokens: 100, output_tokens: 20 }, 120],
    [{ total_tokens: 120, cached_input_tokens: 100 }, 20],
  ]) assert.equal(codexUsage(event({ total_token_usage: counters })).total, expected);
});

test('missing limits stay unavailable and rate-limit-only records do not replace usage', () => {
  assert.equal(codexUsage({ type: 'event_msg', payload: { type: 'token_count', info: null } }), null);
  const usage = codexUsage(event({ model_context_window: null, last_token_usage: null }));
  assert.equal(formatStatus(usage), 'Tokens 20k | Context --/--');
  assert.equal(formatStatus(null), 'Tokens -- | Context --/--');
});

test('legacy agent rows retain context counts and a bounded progress bar', () => {
  assert.equal(formatAgentTokenRow({ total: 12345, contextUsed: 50000, contextWindow: 200000, percent: 25 }),
    'T 12.3k C 50k/200k 25% ██░░░░');
  assert.equal(formatAgentTokenRow({ total: 12345, percent: 150 }), 'T 12.3k C --/-- 100% ██████');
  assert.equal(formatAgentTokenRow(null), 'T -- C --/-- -- ░░░░░░');
});

test('sidebar counts use k and the bar shows remaining context separately', () => {
  const tokens = formatAgentTokens({ total: 117335, contextUsed: 98936, contextWindow: 828400 });
  assert.equal(tokens.tokenbar_total, 'Tokens 117.3k');
  assert.equal(tokens.tokenbar_context, 'Ctx 98.9k/828.4k');
  assert.equal(tokens.tokenbar_healthy, '█░░░░░ 12% · 729.5k left');
  assert.equal(tokens.tokenbar_warning, null);
  assert.equal(tokens.tokenbar_critical, null);
  assert.equal(tokens.tokenbar_unknown, null);
  for (const [value, expected] of [[0, '0k'], [100, '0.1k'], [1000, '1k'], [12345, '12.3k'],
    [1000000, '1,000k'], [1456215, '1,456.2k']]) assert.equal(formatTokens(value), expected);
  for (const value of [null, undefined, -1, NaN, Infinity, '123']) assert.equal(formatTokens(value), '--');
});

test('bar is green below 50%, yellow through 80%, red above 80%, and clears inactive states', () => {
  for (const [percent, level] of [[0, 'healthy'], [49.9, 'healthy'], [50, 'warning'], [65, 'warning'],
    [80, 'warning'], [80.1, 'critical'], [100, 'critical'], [150, 'critical']]) {
    const tokens = formatAgentTokens({ contextUsed: percent * 2000, contextWindow: 200000, percent });
    const active = Object.entries(tokens).filter(([key, value]) => /^tokenbar_(healthy|warning|critical|unknown)$/.test(key) && value !== null);
    assert.deepEqual(active.map(([key]) => key), [`tokenbar_${level}`]);
    assert.match(active[0][1], new RegExp(`${Math.round(Math.min(percent, 100))}%`));
    if (percent >= 100) assert.match(active[0][1], /0k left$/);
  }
});

test('missing or invalid usage stays neutral instead of implying available context', () => {
  for (const usage of [null, {}, { percent: -1 }, { percent: NaN }, { percent: Infinity }, { contextUsed: 0, contextWindow: 0 }]) {
    const tokens = formatAgentTokens(usage);
    assert.equal(tokens.tokenbar_unknown, '░░░░░░ -- · -- left');
    assert.equal(tokens.tokenbar_healthy, null);
    assert.equal(tokens.tokenbar_warning, null);
    assert.equal(tokens.tokenbar_critical, null);
  }
  assert.equal(formatAgentTokens(null).tokenbar_total, 'Tokens --');
  assert.equal(formatAgentTokens(null).tokenbar_context, 'Ctx --/--');
});

test('reverse reader skips partial records, null usage and unrelated token_count text', async t => {
  const dir = await temporary(t);
  const file = join(dir, 'session.jsonl');
  await writeFile(file, [JSON.stringify(event()), JSON.stringify({ type: 'response_item', text: '"token_count"' }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null } }), '{"type":"event_msg"'].join('\n'));
  assert.equal((await latestCodexUsage(file)).contextUsed, 40000);
});

test('reverse reader crosses multi-megabyte tool records with bounded carry', async t => {
  const dir = await temporary(t);
  const file = join(dir, 'session.jsonl');
  const giant = JSON.stringify({ type: 'response_item', text: '工具輸出'.repeat(200000) });
  await writeFile(file, `${JSON.stringify(event())}\n${giant}\n`);
  assert.equal((await latestCodexUsage(file)).total, 20000);
});

test('reverse reader handles the first record and chooses the newest complete usage', async t => {
  const dir = await temporary(t);
  const file = join(dir, 'session.jsonl');
  await writeFile(file, JSON.stringify(event()));
  assert.equal((await latestCodexUsage(file)).total, 20000);
  await appendFile(file, `\n${JSON.stringify(event({ last_token_usage: { total_tokens: 12000 } }))}\n`);
  assert.equal((await latestCodexUsage(file)).contextUsed, 12000);
});

test('session resolution matches exact IDs and cached usage follows growing/truncated files', async t => {
  const dir = await temporary(t);
  const sessions = join(dir, 'sessions', '2026', '11', '05');
  await mkdir(sessions, { recursive: true });
  const file = join(sessions, `rollout-timestamp-${sessionId}.jsonl`);
  await writeFile(file, `${JSON.stringify(event())}\n`);
  const state = join(dir, 'state');
  assert.equal(await locateCodexSession(dir, sessionId), file);
  assert.equal(await locateCodexSession(dir, '019a4d90-0000-7000-8000-000000000099'), null);
  assert.equal(await locateCodexSession(dir, '../session'), null);
  assert.equal((await loadCodexUsage(dir, sessionId, state)).contextUsed, 40000);
  assert.equal((await loadCodexUsage(dir, sessionId, state)).total, 20000);
  await appendFile(file, `${JSON.stringify(event({ last_token_usage: { total_tokens: 8000 } }))}\n`);
  assert.equal((await loadCodexUsage(dir, sessionId, state)).contextUsed, 8000);
  await writeFile(file, '');
  assert.equal(await loadCodexUsage(dir, sessionId, state), null);
});

test('old cached totals are recomputed even when an idle session file has not changed', async t => {
  const dir = await temporary(t);
  const sessions = join(dir, 'sessions');
  await mkdir(sessions);
  const file = join(sessions, `${sessionId}.jsonl`);
  await writeFile(file, `${JSON.stringify(event())}\n`);
  const state = join(dir, 'state');
  await loadCodexUsage(dir, sessionId, state);
  const cacheFile = join(state, (await readdir(state))[0]);
  const cache = JSON.parse(await readFile(cacheFile, 'utf8'));
  delete cache.version;
  cache.usage = { provider: 'codex', total: 100000 };
  await writeFile(cacheFile, JSON.stringify(cache));
  assert.equal((await loadCodexUsage(dir, sessionId, state)).total, 20000);
  assert.equal(JSON.parse(await readFile(cacheFile, 'utf8')).version, 2);
});

test('an explicit terminal pane never borrows another focused agent', () => {
  const agents = [{ pane_id: 'w1:p1', focused: true }, { pane_id: 'w1:p2', focused: false }];
  assert.equal(selectAgent(agents, 'w1:p3'), undefined);
  assert.equal(selectAgent(agents, 'w1:p2'), agents[1]);
  assert.equal(selectAgent(agents), agents[0]);
});

test('Claude uses provider limits and includes cache input in current context', async t => {
  const dir = await temporary(t);
  const payload = { session_id: 'claude-session', context_window: {
    total_input_tokens: 50000, total_output_tokens: 5000, context_window_size: 200000, used_percentage: 15,
    current_usage: { input_tokens: 10000, cache_creation_input_tokens: 5000, cache_read_input_tokens: 14000, output_tokens: 1000 },
  } };
  const parsed = claudeUsage(payload);
  assert.deepEqual(parsed, {
    provider: 'claude', total: 55000, contextUsed: 30000, contextWindow: 200000, percent: 15,
    updatedAt: parsed.updatedAt,
  });
  const usage = await recordClaude(payload, { HERDR_PANE_ID: 'w1:p1', HERDR_TOKENBAR_STATE_DIR: dir });
  assert.equal(usage.total, 55000);
  await assert.rejects(recordClaude({ ...payload, session_id: '../escape' }, { HERDR_PANE_ID: 'w1:p1', HERDR_TOKENBAR_STATE_DIR: dir }), /Invalid session/);
});
