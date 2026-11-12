import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'smol-toml';
import { codexUsage, latestCodexUsage, loadCodexUsage, locateCodexSession, writeJson } from '../src/usage.mjs';
import { parseStatusArgs, formatStatus } from '../src/status.mjs';
import { editStatusConfig } from '../src/config.mjs';

const ID = '019a4d90-0000-7000-8000-000000000001';
const command = 'node status.mjs --herdr-tokenbar';
const event = (info = {}) => ({ type: 'event_msg', timestamp: '2026-11-12T00:00:00Z', payload: { type: 'token_count', info: {
  total_token_usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 10 },
  last_token_usage: { total_tokens: 1000 }, model_context_window: 200000, ...info,
} } });
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'tokenbar-regression-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

for (const info of [{}, { model_context_window: 200000 }, { total_token_usage: {} }, { last_token_usage: {} }]) {
  test(`counter-free token_count cannot erase valid older usage: ${JSON.stringify(info)}`, () => {
    const result = codexUsage({ type: 'event_msg', payload: { type: 'token_count', info } });
    assert.equal(result, null);
  });
}

test('empty new token_count records are skipped by the reverse reader', async t => {
  const dir = await temporary(t), file = join(dir, 'usage.jsonl');
  await writeFile(file, JSON.stringify(event()) + '\n' + JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: {} } }) + '\n');
  assert.equal((await latestCodexUsage(file)).total, 210);
});

for (const limit of [0, -1, NaN, Infinity, '200000', null]) {
  test(`invalid or unknown context limit stays unknown: ${String(limit)}`, () => {
    const sample = codexUsage(event({ model_context_window: limit }));
    assert.equal(sample.contextWindow, null); assert.equal(sample.percent, null);
    assert.match(formatStatus(sample), /Context 1k\/--$/);
  });
}

test('zero counters are genuine data and are not mistaken for no sample', () => {
  const value = codexUsage(event({ total_token_usage: { input_tokens: 0, output_tokens: 0 }, last_token_usage: { total_tokens: 0 } }));
  assert.equal(value.total, 0); assert.equal(value.contextUsed, 0); assert.equal(value.percent, 0);
});

test('a UTF-8 token event split across a 64-KiB block remains valid', async t => {
  const dir = await temporary(t), file = join(dir, 'utf8.jsonl');
  const sample = event(); sample.timestamp = '\u4fee\u590d';
  const record = JSON.stringify(sample);
  const tail = JSON.stringify({ type: 'response_item', text: 'x'.repeat(65530) });
  await writeFile(file, record + '\n' + tail + '\n');
  assert.equal((await latestCodexUsage(file)).updatedAt, '\u4fee\u590d');
});

test('a huge final unterminated tool line cannot hide older valid counters', async t => {
  const dir = await temporary(t), file = join(dir, 'huge.jsonl');
  await writeFile(file, JSON.stringify(event()) + '\n{"type":"response_item","text":"' + 'x'.repeat(4 * 1024 * 1024));
  assert.equal((await latestCodexUsage(file)).total, 210);
});

test('literal token_count text in tool output and malformed tail records cannot forge usage', async t => {
  const dir = await temporary(t), file = join(dir, 'output.jsonl');
  await writeFile(file, [JSON.stringify(event()), JSON.stringify({ type: 'response_item', text: JSON.stringify(event({ model_context_window: 1 })) }), '{"type":"event_msg","payload":'].join('\n'));
  assert.equal((await latestCodexUsage(file)).contextWindow, 200000);
});

test('empty transcript and a transcript with only an incomplete usage event have no usage', async t => {
  const dir = await temporary(t), file = join(dir, 'empty.jsonl');
  await writeFile(file, ''); assert.equal(await latestCodexUsage(file), null);
  await writeFile(file, JSON.stringify(event()).slice(0, -8)); assert.equal(await latestCodexUsage(file), null);
});

test('malformed cached path types do not permanently suppress a valid session', async t => {
  const dir = await temporary(t), sessions = join(dir, 'sessions'), state = join(dir, 'state');
  await mkdir(sessions); await writeFile(join(sessions, `${ID}.jsonl`), JSON.stringify(event()) + '\n');
  await loadCodexUsage(dir, ID, state);
  const cache = join(state, (await readdir(state))[0]);
  const data = JSON.parse(await readFile(cache)); data.file = { bad: true };
  await writeFile(cache, JSON.stringify(data));
  assert.equal((await loadCodexUsage(dir, ID, state)).total, 210);
});

test('a poisoned cached path outside Codex session roots is ignored', async t => {
  const dir = await temporary(t), sessions = join(dir, 'sessions'), outside = join(dir, 'outside');
  await mkdir(sessions); await mkdir(outside);
  const correct = join(sessions, `${ID}.jsonl`), poison = join(outside, `${ID}.jsonl`);
  await writeFile(correct, JSON.stringify(event()) + '\n');
  await writeFile(poison, JSON.stringify(event({ model_context_window: 1 })) + '\n');
  assert.equal(await locateCodexSession(dir, ID, poison), correct);
});

test('read-only/unusable cache cannot suppress valid provider usage', async t => {
  const dir = await temporary(t), sessions = join(dir, 'sessions'), state = join(dir, 'not-a-directory');
  await mkdir(sessions); await writeFile(join(sessions, `${ID}.jsonl`), JSON.stringify(event()) + '\n');
  await writeFile(state, 'not a directory');
  assert.equal((await loadCodexUsage(dir, ID, state)).total, 210);
});

test('cache replacement is atomic under concurrent polling and leaves no temporary files', async t => {
  const dir = await temporary(t), file = join(dir, 'state.json');
  await Promise.all(Array.from({ length: 12 }, (_, value) => writeJson(file, { value })));
  assert.equal(Number.isInteger(JSON.parse(await readFile(file)).value), true);
  assert.deepEqual(await readdir(dir), ['state.json']);
});

test('enable/disable removes only owned tokens from mixed identity rows and retains styles/empty rows', () => {
  const original = '[ui]\n[ui.sidebar.agents]\nrows = [["agent", "$tokenbar", {token="workspace",bold=true}], []]\n'
    + '[ui.sidebar.agents.rows_by_agent]\ncodex=[["state_icon", {token="$tokenbar_total",fg="red"}]]\n';
  const enabled = editStatusConfig(original, command, true);
  const cfg = parse(enabled).ui.sidebar.agents;
  assert.deepEqual(JSON.parse(JSON.stringify(cfg.rows.slice(0, 2))), [['agent', { token: 'workspace', bold: true }], []]);
  assert.deepEqual(cfg.rows_by_agent.codex[0], ['state_icon']);
  assert.equal(editStatusConfig(enabled, command, true), enabled);
  const disabled = parse(editStatusConfig(enabled, command, false)).ui.sidebar.agents;
  assert.deepEqual(disabled.rows, cfg.rows.slice(0, 2));
  assert.deepEqual(disabled.rows_by_agent.codex, [['state_icon']]);
});

test('invalid non-array sidebar rows fail before changing configuration', () => {
  assert.throws(() => editStatusConfig('[ui]\n[ui.sidebar.agents]\nrows=["agent"]\n', command, true), /array of arrays/);
});

for (const args of [['--pane'], ['--pane', '--json'], ['--pane', 'a', '--pane', 'b'],
  ['--typo'], ['unexpected'], ['claude-statusline', '--json']]) {
  test(`reject malformed status arguments: ${args.join(' ')}`, () => assert.throws(() => parseStatusArgs(args)));
}

test('status flags retain explicit pane identity and do not change meaning when reordered', () => {
  assert.deepEqual(parseStatusArgs(['--json', '--pane', 'w1:p1', '--herdr-tokenbar']),
    { json: true, herdrTokenbar: true, help: false, claude: false, paneId: 'w1:p1' });
  assert.equal(parseStatusArgs(['--help']).help, true);
  assert.equal(parseStatusArgs(['claude-statusline']).claude, true);
});

test('CLI fails invalid arguments rather than interpreting --json as a pane id', () => {
  const child = spawnSync(process.execPath, ['src/status.mjs', '--pane', '--json'], { encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 1); assert.match(child.stderr, /--pane requires a pane ID/); assert.equal(child.stdout, '');
});

test('tab-bar JSON includes the same unavailable reason and provider identity as ordinary diagnostics', () => {
  const child = spawnSync(process.execPath, ['src/status.mjs', '--herdr-tokenbar', '--json'], {
    env: { ...process.env, HERDR_BIN_PATH: join(tmpdir(), 'tokenbar-does-not-exist.exe') }, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(child.status, 0); const result = JSON.parse(child.stdout);
  assert.equal(result.usage, null); assert.match(result.reason, /ENOENT/);
});


test('a valid-JSON cache with corrupted usage fields is recomputed', async t => {
  const dir = await temporary(t), sessions = join(dir, 'sessions'), state = join(dir, 'cache');
  await mkdir(sessions); await writeFile(join(sessions, `${ID}.jsonl`), JSON.stringify(event()) + '\n');
  await loadCodexUsage(dir, ID, state);
  const file = join(state, (await readdir(state))[0]);
  const data = JSON.parse(await readFile(file)); data.usage.total = 'corrupt';
  await writeFile(file, JSON.stringify(data));
  assert.equal((await loadCodexUsage(dir, ID, state)).total, 210);
});
