import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexSessionResolver, sameDirectory, sessionMetadata } from '../src/sessions.mjs';
import { collectStatus, collectAgentUsages } from '../src/status.mjs';

const ID = '019a4d90-0000-7000-8000-000000000001';
const OTHER = '019a4d90-0000-7000-8000-000000000002';
const THIRD = '019a4d90-0000-7000-8000-000000000003';
const usage = total => ({ type: 'event_msg', payload: { type: 'token_count', info: {
  total_token_usage: { input_tokens: total, output_tokens: 10, cached_input_tokens: 20 },
  last_token_usage: { total_tokens: total }, model_context_window: 200000,
} } });
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'tokenbar-sessions-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const cwd = join(home, 'project');
  const stateDir = join(home, 'cache');
  const env = { CODEX_HOME: home };
  async function session(id = ID, options = {}) {
    const folder = join(home, options.archived ? 'archived_sessions' : 'sessions', '2026', '11', '12');
    await mkdir(folder, { recursive: true });
    const file = join(folder, `rollout-time-${id}.jsonl`);
    const metadata = { id: options.metadataId ?? id, cwd: options.cwd ?? cwd };
    await writeFile(file, JSON.stringify({ type: 'session_meta', payload: metadata }) + '\n'
      + (options.empty ? '' : JSON.stringify(usage(options.total ?? 1000)) + '\n'));
    return file;
  }
  async function index(rows = [{ id: ID, thread_name: 'Task' }]) {
    await writeFile(join(home, 'session_index.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  }
  function agent(overrides = {}) {
    return { agent: 'codex', pane_id: 'w1:p1', focused: true, cwd,
      terminal_title_stripped: 'Task | project', ...overrides };
  }
  const options = agents => ({ env, stateDir, agents });
  return { home, cwd, stateDir, env, session, index, agent, options };
}

for (const [left, right, expected] of [
  ['C:\\Users\\A\\project\\', 'c:/users/a/project', true],
  ['\\\\server\\share\\project', '\\\\SERVER\\SHARE\\project\\', true],
  ['/tmp/Case', '/tmp/case', false],
  ['/tmp/a/', '/tmp/a', true],
  ['/tmp/a', '/tmp/ab', false],
  [undefined, '/tmp', false], ['', '', false],
]) test(`directory equality: ${String(left)} and ${String(right)}`, () => assert.equal(sameDirectory(left, right), expected));

test('new unreported session acquires tokens while its first turn is still running', async t => {
  const f = await fixture(t);
  const file = await f.session(ID, { empty: true }); await f.index();
  const options = f.options([f.agent({ agent_status: 'working' })]);
  const before = await collectStatus(options);
  assert.equal(before.reason, 'no-usage-events'); assert.equal(before.sessionId, ID);
  await appendFile(file, JSON.stringify(usage(4321)) + '\n');
  const during = await collectStatus(options);
  assert.equal(during.usage.total, 4311); assert.equal(during.reason, null);
  assert.equal(during.sessionSource, 'title-cwd');
});

test('late install recovers all live panes, including resumed archived sessions, without hooks or a restart', async t => {
  const f = await fixture(t);
  await f.session(ID, { total: 1000 });
  await f.session(OTHER, { cwd: join(f.home, 'other'), total: 9000, archived: true });
  await f.index([{ id: ID, thread_name: 'Task' }, { id: OTHER, thread_name: 'Other task' }]);
  const agents = [f.agent(), f.agent({ pane_id: 'w2:p1', cwd: join(f.home, 'other'),
    terminal_title_stripped: 'Other task | other', focused: false })];
  const entries = await collectAgentUsages(f.options(agents));
  assert.deepEqual(entries.map(entry => entry.usage.total), [990, 8990]);
  assert.deepEqual(entries.map(entry => entry.sessionId), [ID, OTHER]);
});

test('a misreported shared-daemon session from another cwd is replaced by exact title and cwd', async t => {
  const f = await fixture(t); await f.session(); await f.session(OTHER, { cwd: join(f.home, 'other') });
  await f.index([{ id: ID, thread_name: 'Task' }, { id: OTHER, thread_name: 'Other' }]);
  const result = await collectStatus(f.options([f.agent({ agent_session: { agent: 'codex', kind: 'id', value: OTHER } })]));
  assert.equal(result.sessionId, ID); assert.equal(result.sessionSource, 'title-cwd');
});

test('a stale same-directory mapping cannot borrow another named task usage', async t => {
  const f = await fixture(t); await f.session(); await f.session(OTHER, { total: 9000 });
  await f.index([{ id: ID, thread_name: 'Task' }, { id: OTHER, thread_name: 'Previous task' }]);
  const result = await collectStatus(f.options([f.agent({ agent_session: { agent: 'codex', kind: 'id', value: OTHER } })]));
  assert.equal(result.sessionId, ID); assert.equal(result.usage.total, 990);
});

test('same directory alone never chooses the newest or only transcript', async t => {
  const f = await fixture(t); await f.session(); await f.index([{ id: ID, thread_name: 'Not this task' }]);
  const result = await collectStatus(f.options([f.agent()]));
  assert.equal(result.usage, null); assert.equal(result.reason, 'no-agent-session');
});

test('a title match in another cwd is not session identity', async t => {
  const f = await fixture(t); await f.session(ID, { cwd: join(f.home, 'other') }); await f.index();
  assert.equal((await collectStatus(f.options([f.agent()]))).reason, 'no-agent-session');
});

test('same title and cwd for multiple sessions is explicitly ambiguous, never newest-wins', async t => {
  const f = await fixture(t); await f.session(); await f.session(OTHER);
  await f.index([{ id: ID, thread_name: 'Task' }, { id: OTHER, thread_name: 'Task' }]);
  const result = await collectStatus(f.options([f.agent()]));
  assert.equal(result.usage, null); assert.equal(result.reason, 'ambiguous-agent-session');
});

test('an authoritative Herdr id disambiguates repeated titles', async t => {
  const f = await fixture(t); await f.session(); await f.session(OTHER);
  await f.index([{ id: ID, thread_name: 'Task' }, { id: OTHER, thread_name: 'Task' }]);
  const result = await collectStatus(f.options([f.agent({ agent_session: { agent: 'codex', kind: 'id', value: OTHER } })]));
  assert.equal(result.sessionId, OTHER); assert.equal(result.sessionSource, 'herdr');
});

test('missing title index and a manual terminal rename do not invalidate a valid reported identity', async t => {
  const f = await fixture(t); await f.session();
  const a = f.agent({ terminal_title_stripped: 'Manually renamed', agent_session: { agent: 'codex', kind: 'id', value: ID } });
  assert.equal((await collectStatus(f.options([a]))).sessionId, ID);
  await f.index();
  assert.equal((await collectStatus(f.options([a]))).sessionId, ID);
});

test('wrong-cwd explicit identity without recovery is unavailable rather than another pane usage', async t => {
  const f = await fixture(t); await f.session(ID, { cwd: join(f.home, 'other') });
  await f.index([{ id: ID, thread_name: 'A different task' }]);
  const result = await collectStatus(f.options([f.agent({ agent_session: { agent: 'codex', kind: 'id', value: ID } })]));
  assert.equal(result.reason, 'session-cwd-mismatch'); assert.equal(result.usage, null);
});

test('latest title index entry wins on rename; corrupt and partial records are ignored', async t => {
  const f = await fixture(t); await f.session();
  await f.index([{ id: ID, thread_name: 'Old task' }, { id: ID, thread_name: 'Task' }]);
  await appendFile(join(f.home, 'session_index.jsonl'), 'not JSON\n{"id":');
  assert.equal((await collectStatus(f.options([f.agent()]))).sessionId, ID);
});

test('ANSI/braille status, non-ASCII and a pipe inside a title match exact title rather than a prefix', async t => {
  const f = await fixture(t); await f.session();
  await f.index([{ id: ID, thread_name: '\u4fee\u590d A | B' }]);
  const result = await collectStatus(f.options([f.agent({ terminal_title_stripped: undefined,
    terminal_title: '\x1b[32m\u280b \u4fee\u590d A | B | project\x1b[0m' })]));
  assert.equal(result.sessionId, ID);
  const prefix = await collectStatus(f.options([f.agent({ terminal_title_stripped: '\u4fee\u590d A | project' })]));
  assert.equal(prefix.usage, null);
});

test('header ID mismatch is not accepted merely because the filename matches', async t => {
  const f = await fixture(t); await f.session(ID, { metadataId: OTHER }); await f.index();
  assert.equal((await collectStatus(f.options([f.agent()]))).usage, null);
});

test('Herdr path identities resolve only within Codex session roots', async t => {
  const f = await fixture(t); const file = await f.session();
  const agent = f.agent({ agent_session: { agent: 'codex', kind: 'path', value: file } });
  assert.equal((await collectStatus(f.options([agent]))).sessionId, ID);
  const external = join(f.home, `external-${ID}.jsonl`);
  await writeFile(external, JSON.stringify({ type: 'session_meta', payload: { id: ID, cwd: f.cwd } }) + '\n');
  assert.equal((await collectStatus(f.options([{ ...agent, agent_session: { ...agent.agent_session, value: external } }]))).usage, null);
});

test('explicit terminal pane does not borrow focused agent or inherited CODEX_THREAD_ID', async t => {
  const f = await fixture(t); await f.session(); await f.index();
  const result = await collectStatus({ ...f.options([f.agent()]), paneId: 'w1:p2',
    env: { ...f.env, CODEX_THREAD_ID: ID, HERDR_PANE_ID: 'w1:p1' } });
  assert.equal(result.usage, null); assert.equal(result.paneId, 'w1:p2');
});

test('per-pane errors do not hide healthy panes, and unavailable reasons stay diagnostic', async t => {
  const f = await fixture(t); await f.session(); await f.index();
  const a = f.agent(); const other = f.agent({ pane_id: 'w2:p1', terminal_title_stripped: 'No match',
    agent_session: { agent: 'claude', kind: 'id', value: '../bad' }, agent: 'claude' });
  const entries = await collectAgentUsages(f.options([a, other, f.agent({ agent: 'unsupported' })]));
  assert.equal(entries[0].usage.total, 990);
  assert.match(entries[1].reason, /^usage-read-error:/);
  assert.equal(entries[2].reason, 'unsupported-provider');
});

test('pane occupant switch is re-resolved on the next poll, without stale pane cache', async t => {
  const f = await fixture(t); await f.session(); await f.session(OTHER, { total: 5000 });
  await f.index([{ id: ID, thread_name: 'Task' }, { id: OTHER, thread_name: 'Next task' }]);
  assert.equal((await collectStatus(f.options([f.agent()]))).usage.total, 990);
  assert.equal((await collectStatus(f.options([f.agent({ terminal_title_stripped: 'Next task | project' })]))).usage.total, 4990);
});

test('newly created index is picked up after an earlier missing-index poll', async t => {
  const f = await fixture(t); await f.session();
  assert.equal((await collectStatus(f.options([f.agent()]))).usage, null);
  await f.index();
  assert.equal((await collectStatus(f.options([f.agent()]))).sessionId, ID);
});

test('very large or malformed session headers fail closed and never parse conversation text as metadata', async t => {
  const f = await fixture(t); const file = join(f.home, 'header.jsonl');
  await writeFile(file, JSON.stringify({ type: 'session_meta', payload: { id: ID, text: 'x'.repeat(1024 * 1024) } }));
  assert.equal(await sessionMetadata(file), null);
  await writeFile(file, JSON.stringify({ type: 'response_item', payload: { id: ID } }));
  assert.equal(await sessionMetadata(file), null);
});

test('a missing transcript id has a distinct diagnostic from a missing Herdr session', async t => {
  const f = await fixture(t);
  const result = await codexSessionResolver(f.home)(f.agent({ agent_session: { agent: 'codex', kind: 'id', value: THIRD } }));
  assert.equal(result.reason, 'session-file-not-found');
});


test('a legitimate worktree/cwd move alone does not discard a valid reported thread', async t => {
  const f = await fixture(t); await f.session(ID, { cwd: join(f.home, 'original-project') });
  await f.index();
  const result = await collectStatus(f.options([f.agent({ agent_session: { agent: 'codex', kind: 'id', value: ID } })]));
  assert.equal(result.sessionId, ID); assert.equal(result.sessionSource, 'herdr'); assert.equal(result.usage.total, 990);
});

test('null JSON is not session metadata and does not crash identity recovery', async t => {
  const f = await fixture(t); const file = join(f.home, 'null-header.jsonl');
  await writeFile(file, 'null\n'); assert.equal(await sessionMetadata(file), null);
});
