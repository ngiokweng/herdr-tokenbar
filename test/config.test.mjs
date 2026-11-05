import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { editStatusConfig } from '../src/config.mjs';
import { quoteArgument } from '../src/setup.mjs';

const command = 'node "/path with spaces/status.mjs" --herdr-tokenbar';

test('add a persistent status alongside existing entries and preserve unrelated text', () => {
  const original = '# my settings\r\n[ui]\r\n# clock\r\ntab_bar_right = [\r\n { type = "datetime", format = "%H:%M" }, # existing\r\n]\r\nstatus_indicators = "dots"\r\n\r\n[theme]\r\nname = "catppuccin"\r\n';
  const updated = editStatusConfig(original, command, true);
  const config = parse(updated);
  assert.equal(config.ui.tab_bar_right.length, 2);
  assert.equal(config.ui.tab_bar_right[0].type, 'datetime');
  assert.equal(config.ui.tab_bar_right[1].command, command);
  assert.ok(updated.startsWith('# my settings\r\n[ui]\r\n# clock\r\n'));
  assert.ok(updated.includes('status_indicators = "dots"\r\n\r\n[theme]\r\nname = "catppuccin"\r\n'));
  assert.deepEqual(config.ui.sidebar.agents.rows.at(-1), ['$tokenbar']);
  assert.equal(editStatusConfig(updated, command, true), updated);
});

test('disable removes only this plugin and repeated disable is a no-op', () => {
  const original = '[ui]\ntab_bar_right = [{ type = "hostname" }]\n';
  const enabled = editStatusConfig(original, command, true);
  const disabled = editStatusConfig(enabled, command, false);
  assert.deepEqual(parse(disabled).ui.tab_bar_right, parse(original).ui.tab_bar_right);
  assert.equal(parse(disabled).ui.sidebar.agents.rows.some(row => row.includes('$tokenbar')), false);
  assert.equal(editStatusConfig(disabled, command, false), disabled);
  assert.equal(editStatusConfig('', command, false), '');
});

test('add and remove token rows for default and per-agent layouts', () => {
  const defaults = [['state_icon', 'machine', 'workspace', 'tab'], ['agent']];
  const defaultRows = parse(editStatusConfig('[ui]\n', command, true)).ui.sidebar.agents.rows;
  assert.deepEqual(defaultRows, [...defaults, ['$tokenbar']]);
  const childOnly = '[ui]\nstatus_indicators = "dots"\n'
    + '[ui.sidebar.agents.rows_by_agent]\nclaude = [["agent"]]\n';
  const childUpdated = parse(editStatusConfig(childOnly, command, true));
  assert.deepEqual(childUpdated.ui.sidebar.agents.rows, [...defaults, ['$tokenbar']]);
  assert.deepEqual(childUpdated.ui.sidebar.agents.rows_by_agent.claude.at(-1), ['$tokenbar']);
  const original = '[ui]\nstatus_indicators = "dots"\n'
    + '[ui.sidebar.agents]\nrow_gap = 1\nrows = [["agent"]]\n'
    + '[ui.sidebar.agents.rows_by_agent]\nclaude = [["agent"], ["terminal_title_stripped"]]\ncodex = [["agent"]]\n';
  const enabled = editStatusConfig(original, command, true);
  const config = parse(enabled);
  assert.deepEqual(config.ui.sidebar.agents.rows, [['agent'], ['$tokenbar']]);
  assert.deepEqual(config.ui.sidebar.agents.rows_by_agent.claude.at(-1), ['$tokenbar']);
  assert.deepEqual(config.ui.sidebar.agents.rows_by_agent.codex.at(-1), ['$tokenbar']);
  const disabled = editStatusConfig(enabled, command, false);
  assert.deepEqual(parse(disabled).ui.sidebar, parse(original).ui.sidebar);
  assert.deepEqual(parse(disabled).ui.tab_bar_right ?? [], parse(original).ui.tab_bar_right ?? []);
  assert.equal(editStatusConfig(disabled, command, false), disabled);
});

test('renaming replaces the legacy status entry and preserves other commands', () => {
  const original = '[ui]\ntab_bar_right = [\n'
    + '{type="command",command="echo clock"},\n'
    + '{type="command",command="node old/status.mjs --herdr-hold-token"}\n]\n';
  const updated = editStatusConfig(original, command, true);
  assert.deepEqual(parse(updated).ui.tab_bar_right.map(entry => entry.command), ['echo clock', command]);
  assert.equal(editStatusConfig(updated, command, true), updated);
  assert.deepEqual(parse(editStatusConfig(original, command, false)).ui.tab_bar_right.map(entry => entry.command), ['echo clock']);
});

test('insert [ui] or its missing key without moving nested tables', () => {
  for (const original of ['', '[theme]\nname="dark"\n', '[ui]\nstatus_indicators="dots"\n[ui.sidebar.agents]\nrows=[["agent"]]\n']) {
    const updated = parse(editStatusConfig(original, command, true));
    assert.equal(updated.ui.tab_bar_right[0].command, command);
  }
});

test('update quoted keys, comments and commands containing TOML delimiters', () => {
  const original = '["ui"] # tab settings\n"tab_bar_right" = [{type="command",command="echo ] # quote", interval_seconds=5}] # trailing\n';
  const updated = editStatusConfig(original, command, true);
  assert.equal(parse(updated).ui.tab_bar_right[0].command, 'echo ] # quote');
  assert.ok(updated.includes('# trailing'));
});

test('refuse ambiguous dotted settings or edits inside multiline strings', () => {
  assert.throws(() => editStatusConfig('ui.tab_bar_right=[]\n', command, true), /\[ui\]/);
  const original = 'message = """\n[ui]\ntab_bar_right=[]\n"""\n[ui]\nstatus_indicators="dots"\n';
  assert.throws(() => editStatusConfig(original, command, true), /unrelated|safely/);
});

test('respect Herdr entry limits', () => {
  const entries = Array.from({ length: 16 }, () => '{ type="hostname" }').join(',');
  assert.throws(() => editStatusConfig(`[ui]\ntab_bar_right=[${entries}]\n`, command, true), /16/);
});

test('quote paths for Unix shells and Windows cmd', () => {
  assert.equal(quoteArgument("/a'b c", 'linux'), "'/a'\\''b c'");
  assert.equal(quoteArgument('C:\\Program Files\\node.exe', 'win32'), '"C:\\Program Files\\node.exe"');
  assert.throws(() => quoteArgument('C:\\%UNEXPANDED%\\node.exe', 'win32'), /Windows/);
});

test('setup copies a self-contained runtime, backs up configuration and disables cleanly', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tokenbar-setup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, 'config.toml');
  const pluginConfig = join(directory, 'plugin config');
  await mkdir(pluginConfig);
  const legacyRuntime = join(directory, 'herdr.hold-token', 'runtime');
  const legacyState = join(directory, 'legacy-state');
  await mkdir(legacyRuntime, { recursive: true });
  await mkdir(legacyState);
  await writeFile(join(legacyRuntime, 'runtime-settings.json'), JSON.stringify({ stateDir: legacyState }));
  await writeFile(config, '# keep this comment\n[ui]\nstatus_indicators="dots"\n');
  const env = { ...process.env, HERDR_CONFIG_PATH: config, HERDR_PLUGIN_CONFIG_DIR: pluginConfig,
    HERDR_PLUGIN_STATE_DIR: join(directory, 'state'), HERDR_BIN_PATH: process.execPath };
  const setup = action => execFileSync(process.execPath, ['src/setup.mjs', action], { env, encoding: 'utf8', windowsHide: true });
  setup('enable');
  const enabled = await readFile(config, 'utf8');
  assert.equal(parse(enabled).ui.tab_bar_right.length, 1);
  assert.ok(enabled.startsWith('# keep this comment'));
  assert.equal((await readdir(directory)).filter(name => name.endsWith('.bak')).length, 1);
  const script = join(pluginConfig, 'runtime', 'status.mjs');
  assert.equal(JSON.parse(await readFile(join(pluginConfig, 'runtime', 'runtime-settings.json'), 'utf8')).stateDir, legacyState);
  assert.match(execFileSync(process.execPath, [script, '--help'], { encoding: 'utf8', windowsHide: true }), /Usage:/);
  if (process.platform === 'win32') {
    const nativeCommand = parse(enabled).ui.tab_bar_right[0].command;
    const output = execFileSync('cmd.exe', ['/d', '/c', nativeCommand], {
      env, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true,
    });
    assert.match(output, /Tokens -- \| Context --\/--/);
  }
  setup('enable');
  assert.equal(await readFile(config, 'utf8'), enabled);
  setup('disable');
  assert.deepEqual(parse(await readFile(config, 'utf8')).ui.tab_bar_right, []);
});
