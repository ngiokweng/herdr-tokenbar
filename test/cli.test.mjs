import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('../src/status.mjs', import.meta.url));
const ID = '019a4d90-0000-7000-8000-000000000001';

/** Join disjoint native patches for assertions while checking the real API's cap. */
async function readReports(path) {
  const chunks = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const pending = new Map(), reports = [];
  for (const args of chunks) {
    const keys = args.flatMap((arg, index) => args[index - 1] === '--clear-token' ? [arg]
      : args[index - 1] === '--token' ? [arg.slice(0, arg.indexOf('='))] : []);
    assert.ok(keys.length <= 16, 'Herdr accepts no more than 16 keys per metadata patch');
    for (const key of keys) assert.match(key, /^[A-Za-z0-9_-]{1,32}$/);
    const previous = pending.get(args[1]);
    if (previous) {
      reports.push([...previous, ...args.slice(2)]);
      pending.delete(args[1]);
    } else {
      pending.set(args[1], args);
    }
  }
  assert.equal(pending.size, 0, 'Each pane receives both display patches');
  return reports;
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'tokenbar-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'agent'), "const fs=require('node:fs');process.stdout.write(fs.readFileSync(process.env.TEST_AGENT_RESPONSE_FILE));");
  await writeFile(join(dir, 'workspace'), "const fs=require('node:fs');if(process.env.TEST_WORKSPACE_FAIL==='1')process.exit(1);process.stdout.write(fs.readFileSync(process.env.TEST_WORKSPACE_RESPONSE_FILE));");
  await writeFile(join(dir, 'pane'), "const fs=require('node:fs');fs.appendFileSync(process.env.TEST_REPORT_OUTPUT,JSON.stringify(process.argv.slice(2))+'\\n');if(process.env.TEST_REPORT_FAIL==='1')process.exit(1);");
  const response = join(dir, 'response.json'), reports = join(dir, 'reports.jsonl');
  const workspaceResponse = join(dir, 'workspaces.json');
  await writeFile(workspaceResponse, JSON.stringify({ result: { workspaces: [{ workspace_id: 'w1', label: 'herdr-tokenbar' }] } }));
  const env = { ...process.env, HERDR_BIN_PATH: process.execPath, CODEX_HOME: dir,
    HERDR_TOKENBAR_STATE_DIR: join(dir, 'cache'), TEST_AGENT_RESPONSE_FILE: response, TEST_REPORT_OUTPUT: reports,
    TEST_WORKSPACE_RESPONSE_FILE: workspaceResponse, TEST_WORKSPACE_FAIL: '', HERDR_TOKENBAR_MACHINE: '',
    HERDR_ACTIVE_PANE_ID: '', HERDR_TOKENBAR_DEBUG: '' };
  async function agents(value) { await writeFile(response, JSON.stringify({ result: { agents: value } })); }
  async function session() {
    const folder = join(dir, 'sessions'); await mkdir(folder);
    await writeFile(join(folder, `${ID}.jsonl`), [
      { type: 'session_meta', payload: { id: ID, cwd: dir } },
      { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, output_tokens: 100 },
        last_token_usage: { total_tokens: 500 }, model_context_window: 10000 } } },
    ].map(record => JSON.stringify(record)).join('\n') + '\n');
    await writeFile(join(dir, 'session_index.jsonl'), JSON.stringify({ id: ID, thread_name: 'Task' }) + '\n');
  }
  function run(args, options = {}) {
    return spawnSync(process.execPath, [script, ...args], { cwd: dir, env, encoding: 'utf8', windowsHide: true, ...options });
  }
  const agent = { pane_id: 'w1:p1', workspace_id: 'w1', agent: 'codex', focused: true, cwd: dir, terminal_title_stripped: 'Task | project' };
  return { dir, env, reports, response, workspaceResponse, agents, session, run, agent };
}

test('tab-bar CLI recovers a session and reports only display metadata with cleared inactive colors', async t => {
  const f = await fixture(t); await f.session(); await f.agents([f.agent]);
  const result = f.run(['--herdr-tokenbar', '--json']);
  assert.equal(result.status, 0); assert.equal(result.stderr, '');
  const sample = JSON.parse(result.stdout);
  assert.equal(sample.usage.total, 1100); assert.equal(sample.sessionId, ID);
  assert.equal(sample.provider, 'codex'); assert.equal(sample.sessionSource, 'title-cwd'); assert.equal(sample.reason, null);
  const args = (await readReports(f.reports))[0];
  assert.equal(args[0], 'report-metadata'); assert.equal(args[1], 'w1:p1');
  assert.ok(args.includes('tokenbar_header=Local/codex herdr-tokenbar'));
  assert.ok(args.includes('tokenbar_total=Tokens 1.1k'));
  assert.ok(args.includes('tokenbar_warning')); assert.ok(args.includes('--clear-token'));
  assert.equal(args.at(-2), '--ttl-ms'); assert.equal(args.at(-1), '7000');
});

test('tab-bar missing usage exposes a real reason rather than success with null counters', async t => {
  const f = await fixture(t); await f.agents([f.agent]);
  const result = f.run(['--herdr-tokenbar', '--json']);
  assert.equal(result.status, 0); assert.equal(JSON.parse(result.stdout).reason, 'no-agent-session');
  const args = (await readReports(f.reports))[0];
  assert.ok(args.includes('tokenbar_header=Local/codex herdr-tokenbar'));
  assert.ok(args.includes('tokenbar_total=Tokens --'));
});

test('explicit pane and focused-pane status return identical recovered provider counters', async t => {
  const f = await fixture(t); await f.session(); await f.agents([f.agent]);
  const a = JSON.parse(f.run(['--json']).stdout);
  const b = JSON.parse(f.run(['--pane', f.agent.pane_id, '--json']).stdout);
  assert.deepEqual(a, b);
  assert.match(f.run([]).stdout, /^Tokens 1\.1k \| Context 0\.5k\/10k 5%/);
});

test('no selected agent in tab-bar mode preserves labels and explicit target identity', async t => {
  const f = await fixture(t); await f.agents([]);
  const result = JSON.parse(f.run(['--herdr-tokenbar', '--json', '--pane', 'w9:p9']).stdout);
  assert.equal(result.usage, null); assert.equal(result.paneId, 'w9:p9'); assert.equal(result.reason, 'no-agent-session');
});

for (const [response, reason] of [
  [{ error: { message: 'API unavailable' } }, /API unavailable/],
  [{ error: {} }, /Herdr API error/],
  [{ result: {} }, /Unexpected Herdr agent list/],
]) test(`Herdr response errors keep status labels visible: ${JSON.stringify(response)}`, async t => {
  const f = await fixture(t); await writeFile(f.response, JSON.stringify(response));
  const json = f.run(['--json']);
  assert.equal(json.status, 0); assert.match(JSON.parse(json.stdout).reason, reason);
  assert.match(f.run([]).stdout, /^Tokens -- \| Context --\/--/);
});

test('metadata-report failure is isolated, debug-visible, and cannot hide valid top-bar usage', async t => {
  const f = await fixture(t); await f.session(); await f.agents([f.agent]);
  const result = f.run(['--herdr-tokenbar', '--json'], { env: { ...f.env, TEST_REPORT_FAIL: '1', HERDR_TOKENBAR_DEBUG: '1' } });
  assert.equal(result.status, 0); assert.equal(JSON.parse(result.stdout).usage.total, 1100);
  assert.match(result.stderr, /Unable to report token usage for w1:p1/);
});

test('a provider file failure is isolated from the CLI and emits a useful per-pane diagnostic', async t => {
  const f = await fixture(t); await f.session();
  await mkdir(join(f.dir, 'bad.jsonl'));
  await f.agents([{ ...f.agent, agent: 'claude', agent_session: { agent: 'claude', kind: 'id', value: '../bad' } }]);
  const result = f.run(['--json'], { env: { ...f.env, HERDR_TOKENBAR_DEBUG: '1' } });
  assert.equal(result.status, 0); assert.match(result.stderr, /Unable to read claude usage/);
  assert.match(JSON.parse(result.stdout).reason, /usage-read-error/);
});

test('Claude receiver and collector agree, and another pane never receives the cached sample', async t => {
  const f = await fixture(t), sessionId = 'claude-session';
  const payload = { session_id: sessionId, context_window: { total_input_tokens: 1000, total_output_tokens: 100,
    context_window_size: 10000, current_usage: { input_tokens: 500 } } };
  const receiver = f.run(['claude-statusline'], { input: JSON.stringify(payload), env: { ...f.env, HERDR_PANE_ID: 'w1:p1' } });
  assert.equal(receiver.status, 0); assert.match(receiver.stdout, /Tokens 1\.1k/);
  const a = { ...f.agent, agent: 'claude', agent_session: { agent: 'claude', kind: 'id', value: sessionId } };
  await f.agents([a]);
  assert.equal(JSON.parse(f.run(['--json']).stdout).usage.total, 1100);
  await f.agents([{ ...a, pane_id: 'w2:p1' }]);
  assert.equal(JSON.parse(f.run(['--json']).stdout).reason, 'claude-statusline-unavailable');
});

test('oversized Claude statusline payload is bounded and fails without writing a cache', async t => {
  const f = await fixture(t);
  const result = f.run(['claude-statusline'], { input: 'x'.repeat(1024 * 1024 + 1), maxBuffer: 2 * 1024 * 1024 });
  assert.equal(result.status, 1); assert.match(result.stderr, /payload exceeds 1 MiB/);
});

test('help is self-contained and does not require a running Herdr server', async t => {
  const f = await fixture(t);
  const result = f.run(['--help']);
  assert.equal(result.status, 0); assert.match(result.stdout, /Usage:/); assert.equal(result.stderr, '');
});


test('compact headers match workspace IDs rather than list order or cwd and stay pane-local', async t => {
  const f = await fixture(t);
  await f.agents([
    f.agent,
    { ...f.agent, pane_id: 'w2:p1', workspace_id: 'w2', agent: 'claude', focused: false },
    { ...f.agent, pane_id: 'w3:p1', workspace_id: 'w3', focused: false },
  ]);
  await writeFile(f.workspaceResponse, JSON.stringify({ result: { workspaces: [
    { workspace_id: 'w2', label: '項目 A | B & C=1' }, null,
    { workspace_id: 'w1', label: 'renamed-project' },
  ] } }));
  const result = f.run(['--herdr-tokenbar', '--json']);
  assert.equal(result.status, 0); assert.equal(result.stderr, '');
  const reports = await readReports(f.reports);
  const headers = new Map(reports.map(args => [args[1], args.find(arg => arg.startsWith('tokenbar_header='))]));
  assert.deepEqual(headers, new Map([
    ['w1:p1', 'tokenbar_header=Local/codex renamed-project'],
    ['w2:p1', 'tokenbar_header=Local/claude 項目 A | B & C=1'],
    ['w3:p1', 'tokenbar_header=Local/codex w3'],
  ]));
});

test('the next poll picks up workspace renames and pane occupant changes without stale titles', async t => {
  const f = await fixture(t); await f.agents([f.agent]);
  assert.equal(f.run(['--herdr-tokenbar']).status, 0);
  await f.agents([{ ...f.agent, agent: 'claude' }]);
  await writeFile(f.workspaceResponse, JSON.stringify({ result: { workspaces: [{ workspace_id: 'w1', label: '新名稱' }] } }));
  assert.equal(f.run(['--herdr-tokenbar']).status, 0);
  const reports = await readReports(f.reports);
  assert.equal(reports.length, 2);
  assert.ok(reports[0].includes('tokenbar_header=Local/codex herdr-tokenbar'));
  assert.ok(reports[1].includes('tokenbar_header=Local/claude 新名稱'));
});

for (const response of [{ error: { message: 'Labels unavailable' } }, { result: {} }, null]) {
  test('workspace lookup failure cannot hide usage and falls back to the matching workspace ID: ' + JSON.stringify(response), async t => {
    const f = await fixture(t); await f.session(); await f.agents([f.agent]);
    await writeFile(f.workspaceResponse, JSON.stringify(response));
    const result = f.run(['--herdr-tokenbar', '--json'], { env: { ...f.env, HERDR_TOKENBAR_DEBUG: '1' } });
    assert.equal(result.status, 0); assert.equal(JSON.parse(result.stdout).usage.total, 1100);
    assert.match(result.stderr, /Unable to list workspaces/);
    const args = (await readReports(f.reports))[0];
    assert.ok(args.includes('tokenbar_header=Local/codex w1'));
    assert.ok(args.includes('tokenbar_total=Tokens 1.1k'));
  });
}

test('workspace command failure is isolated and the machine label can be configured', async t => {
  const f = await fixture(t); await f.session(); await f.agents([f.agent]);
  const result = f.run(['--herdr-tokenbar', '--json'], {
    env: { ...f.env, TEST_WORKSPACE_FAIL: '1', HERDR_TOKENBAR_MACHINE: 'devbox' },
  });
  assert.equal(result.status, 0); assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).usage.total, 1100);
  const args = (await readReports(f.reports))[0];
  assert.ok(args.includes('tokenbar_header=devbox/codex w1'));
});


test('metadata reports a gradient and one pane-specific separator color with all stale colors cleared', async t => {
  const f = await fixture(t); await f.session();
  const other = { ...f.agent, pane_id: 'w2:p1', workspace_id: 'w2', focused: false };
  await f.agents([other, f.agent]);
  assert.equal(f.run(['--herdr-tokenbar']).status, 0);
  await f.agents([f.agent, other]);
  assert.equal(f.run(['--herdr-tokenbar']).status, 0);
  const reports = await readReports(f.reports);
  assert.equal(reports.length, 4);
  for (const paneId of ['w1:p1', 'w2:p1']) {
    const paneReports = reports.filter(args => args[1] === paneId);
    assert.equal(paneReports.length, 2);
    const expectedSlot = paneId === 'w1:p1' ? 0 : 1;
    for (const args of paneReports) {
      const active = args.filter(arg => /^tokenbar_separator_\d=/.test(arg));
      assert.equal(active.length, 1);
      assert.ok(active[0].startsWith('tokenbar_separator_' + expectedSlot + '=─'));
      assert.match(active[0].split('=')[1], /^─{64}$/u);
      const cleared = args.filter((arg, index) => args[index - 1] === '--clear-token');
      assert.equal(cleared.filter(key => key.startsWith('tokenbar_separator_')).length, 7);
      assert.ok(args.some(arg => arg.startsWith('tokenbar_gradient_') && arg.includes('剩余:')));
      assert.equal(args[args.indexOf('--agent') + 1], 'codex');
      assert.ok(!args.includes('--display-agent'));
    }
  }
});


test('native gradient color changes are applied in one patch of sixteen keys, not one oversized report', async t => {
  const f = await fixture(t); await f.session(); await f.agents([f.agent]);
  assert.equal(f.run(['--herdr-tokenbar']).status, 0);
  const chunks = (await readFile(f.reports, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(chunks.length, 2);
  const gradient = chunks.find(args => args.some(arg => /^tokenbar_gradient_\d+=/.test(arg)));
  assert.ok(gradient);
  const cleared = gradient.filter((arg, index) => gradient[index - 1] === '--clear-token');
  assert.equal(cleared.filter(key => key.startsWith('tokenbar_gradient_')).length, 14);
  assert.ok(cleared.includes('tokenbar_unknown'));
  assert.equal((await readReports(f.reports)).length, 1);
});
