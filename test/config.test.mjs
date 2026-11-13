import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { editStatusConfig } from '../src/config.mjs';
import { quoteArgument } from '../src/setup.mjs';
import { formatAgentTokens } from '../src/status.mjs';
import { TOKENBAR_ROWS } from '../src/presentation.mjs';

const command = 'node "/path with spaces/status.mjs" --herdr-tokenbar';
const parse = text => structuredClone(parseToml(text));
const nativeRows = [['state_icon', 'machine', 'workspace', 'tab'], ['agent']];
const compactRows = [['state_icon', '$tokenbar_header']];
const legacyUsageRows = [
  [{ token: '$tokenbar_total', fg: '#89b4fa', dim: false }],
  [{ token: '$tokenbar_context', dim: false }],
  [
    { token: '$tokenbar_healthy', fg: '#a6e3a1', dim: false },
    { token: '$tokenbar_warning', fg: '#f9e2af', dim: false },
    { token: '$tokenbar_critical', fg: '#f38ba8', bold: true, dim: false },
    { token: '$tokenbar_unknown', fg: '#7f849c', dim: false },
  ],
];

const usageRows = structuredClone(TOKENBAR_ROWS);

test('reported usage selects exactly one gradient bar, including gray for missing data', () => {
  const rows = parse(editStatusConfig('[ui]\n', command, true)).ui.sidebar.agents.rows;
  const bar = rows.at(-2);
  for (const [percent, color] of [[0, '#a6e3a1'], [50, '#f9e2af'], [100, '#f38ba8'], [null, '#7f849c']]) {
    const tokens = formatAgentTokens(percent === null ? null : { percent });
    const visible = bar.filter(item => tokens[item.token.slice(1)] !== null);
    assert.equal(visible.length, 1);
    assert.equal(visible[0].fg, color);
    assert.equal(visible[0].dim, false);
  }
});

test('add a persistent status alongside existing entries and preserve unrelated text', () => {
  const original = '# my settings\r\n[ui]\r\n# clock\r\ntab_bar_right = [\r\n { type = "datetime", format = "%H:%M" }, # existing\r\n]\r\nstatus_indicators = "dots"\r\n\r\n[theme]\r\nname = "catppuccin"\r\n';
  const updated = editStatusConfig(original, command, true);
  const config = parse(updated);
  assert.equal(config.ui.tab_bar_right.length, 2);
  assert.equal(config.ui.tab_bar_right[0].type, 'datetime');
  assert.equal(config.ui.tab_bar_right[1].command, command);
  assert.ok(updated.startsWith('# my settings\r\n[ui]\r\n# clock\r\n'));
  assert.ok(updated.includes('status_indicators = "dots"\r\n\r\n[theme]\r\nname = "catppuccin"\r\n'));
  assert.deepEqual(config.ui.sidebar.agents.rows.slice(-4), usageRows);
  assert.equal(config.ui.sidebar.agents.row_gap, 0);
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
  const defaults = compactRows;
  const defaultRows = parse(editStatusConfig('[ui]\n', command, true)).ui.sidebar.agents.rows;
  assert.deepEqual(defaultRows, [...defaults, ...usageRows]);
  const childOnly = '[ui]\nstatus_indicators = "dots"\n'
    + '[ui.sidebar.agents.rows_by_agent]\nclaude = [["agent"]]\n';
  const childUpdated = parse(editStatusConfig(childOnly, command, true));
  assert.deepEqual(childUpdated.ui.sidebar.agents.rows, [...defaults, ...usageRows]);
  assert.deepEqual(childUpdated.ui.sidebar.agents.rows_by_agent.claude.slice(-4), usageRows);
  const original = '[ui]\nstatus_indicators = "dots"\n'
    + '[ui.sidebar.agents]\nrow_gap = 1\nrows = [["agent"]]\n'
    + '[ui.sidebar.agents.rows_by_agent]\nclaude = [["agent"], ["terminal_title_stripped"]]\ncodex = [["agent"]]\n';
  const enabled = editStatusConfig(original, command, true);
  const config = parse(enabled);
  assert.deepEqual(config.ui.sidebar.agents.rows, [['agent'], ...usageRows]);
  assert.deepEqual(config.ui.sidebar.agents.rows_by_agent.claude.slice(-4), usageRows);
  assert.deepEqual(config.ui.sidebar.agents.rows_by_agent.codex.slice(-4), usageRows);
  const disabled = editStatusConfig(enabled, command, false);
  assert.deepEqual(parse(disabled).ui.sidebar, parse(original).ui.sidebar);
  assert.deepEqual(parse(disabled).ui.tab_bar_right ?? [], parse(original).ui.tab_bar_right ?? []);
  assert.equal(editStatusConfig(disabled, command, false), disabled);
});

test('migrate existing native layouts with old or current usage rows and restore them on disable', () => {
  for (const previousUsage of [[], [['$tokenbar']], legacyUsageRows, usageRows]) {
    const original = '[ui]\n[ui.sidebar.agents]\n' + stringifyToml({ rows: [...nativeRows, ...previousUsage] });
    const enabled = editStatusConfig(original, command, true);
    assert.deepEqual(parse(enabled).ui.sidebar.agents.rows, [...compactRows, ...usageRows]);
    assert.equal(parse(enabled).ui.sidebar.agents.rows.length, 5);
    assert.equal(editStatusConfig(enabled, command, true), enabled);
    const disabled = editStatusConfig(enabled, command, false);
    assert.deepEqual(parse(disabled).ui.sidebar.agents.rows, nativeRows);
    assert.equal(editStatusConfig(disabled, command, false), disabled);
  }
});

test('migrate native per-agent overrides in both TOML representations without changing custom overrides', () => {
  const custom = [['terminal_title_stripped'], ['agent']];
  for (const inline of [false, true]) {
    const overrides = inline
      ? 'rows_by_agent = { codex = ' + JSON.stringify([...nativeRows, ['$tokenbar']]) + ', claude = ' + JSON.stringify(custom) + ' }\n'
      : '[ui.sidebar.agents.rows_by_agent]\ncodex = ' + JSON.stringify([...nativeRows, ['$tokenbar']]) + '\nclaude = ' + JSON.stringify(custom) + '\n';
    const original = '[ui]\n[ui.sidebar.agents]\nrows = ' + JSON.stringify(nativeRows) + '\n' + overrides;
    const enabled = editStatusConfig(original, command, true);
    const settings = parse(enabled).ui.sidebar.agents;
    assert.deepEqual(settings.rows, [...compactRows, ...usageRows]);
    assert.deepEqual(settings.rows_by_agent.codex, [...compactRows, ...usageRows]);
    assert.deepEqual(settings.rows_by_agent.claude, [...custom, ...usageRows]);
    assert.equal(editStatusConfig(enabled, command, true), enabled);
    const disabled = editStatusConfig(enabled, command, false);
    const restored = parse(disabled).ui.sidebar.agents;
    assert.deepEqual(restored.rows, nativeRows);
    assert.deepEqual(restored.rows_by_agent, { codex: nativeRows, claude: custom });
    assert.equal(editStatusConfig(disabled, command, false), disabled);
  }
});

test('disable restores native identity after a fresh install rather than leaving only the state icon', () => {
  const enabled = editStatusConfig('[ui]\n', command, true);
  assert.deepEqual(parse(enabled).ui.sidebar.agents.rows, [...compactRows, ...usageRows]);
  const disabled = parse(editStatusConfig(enabled, command, false)).ui.sidebar.agents;
  assert.deepEqual(disabled.rows, nativeRows);
  assert.equal(disabled.row_gap, undefined);
});

test('disable restores styled compact identities and preserves extra custom rows', () => {
  const icon = { token: 'state_icon', dim: false };
  const header = { token: '$tokenbar_header', fg: '#abcdef', bold: true };
  for (const identity of [[icon, header], [header]]) {
    const rows = [identity, ['terminal_title_stripped']];
    const original = '[ui]\n[ui.sidebar.agents]\n' + stringifyToml({ rows });
    const enabled = editStatusConfig(original, command, true);
    assert.deepEqual(parse(enabled).ui.sidebar.agents.rows.slice(0, 2), rows);
    const disabled = editStatusConfig(enabled, command, false);
    assert.deepEqual(parse(disabled).ui.sidebar.agents.rows, [
      [...(identity.length === 2 ? [icon] : []), 'machine', 'workspace', 'tab'],
      ['agent'], ['terminal_title_stripped'],
    ]);
    assert.equal(editStatusConfig(disabled, command, false), disabled);
  }
});

test('mixed custom rows remove only the header on disable without removing unrelated tokens', () => {
  const rows = [['machine', { token: '$tokenbar_header', bold: true }, 'workspace'], []];
  const original = '[ui]\n[ui.sidebar.agents]\n' + stringifyToml({ rows });
  const enabled = editStatusConfig(original, command, true);
  assert.deepEqual(parse(enabled).ui.sidebar.agents.rows.slice(0, 2), rows);
  assert.deepEqual(parse(editStatusConfig(enabled, command, false)).ui.sidebar.agents.rows,
    [['machine', 'workspace'], []]);
});

test('upgrade the original tokenbar row without duplicating it or touching custom styles', () => {
  const original = '[ui]\n[ui.sidebar.agents]\nrows = [["state_icon", {token="workspace", bold=false}], ["agent"], ["$tokenbar"]]\n'
    + '[ui.sidebar.agents.rows_by_agent]\nclaude = [["terminal_title"], ["$tokenbar"]]\n';
  const enabled = editStatusConfig(original, command, true);
  const config = parse(enabled).ui.sidebar.agents;
  assert.deepEqual(config.rows, [['state_icon', { token: 'workspace', bold: false }], ['agent'], ...usageRows]);
  assert.deepEqual(config.rows_by_agent.claude, [['terminal_title'], ...usageRows]);
  assert.equal(editStatusConfig(enabled, command, true), enabled);
  const disabled = parse(editStatusConfig(enabled, command, false)).ui.sidebar.agents;
  assert.deepEqual(disabled.rows, config.rows.slice(0, -4));
  assert.deepEqual(disabled.rows_by_agent.claude, [['terminal_title']]);
  assert.equal(disabled.row_gap, undefined);
});

test('spacing is reversible and explicit user spacing is preserved', () => {
  for (const gap of [undefined, 0, 1, 2]) {
    const original = '[ui]\n[ui.sidebar.agents]\n' + (gap === undefined ? '' : `row_gap = ${gap} # custom spacing\n`)
      + 'rows = [["agent"]]\n';
    const enabled = editStatusConfig(original, command, true);
    assert.equal(parse(enabled).ui.sidebar.agents.row_gap, gap ?? 0);
    const disabled = editStatusConfig(enabled, command, false);
    assert.deepEqual(parse(disabled).ui.sidebar, parse(original).ui.sidebar);
    if (gap !== undefined) assert.ok(disabled.includes(`# custom spacing`));
  }
  const enabled = editStatusConfig('[ui]\n[ui.sidebar.agents]\nrows = [["agent"]]\n', command, true);
  const customized = enabled.replace('row_gap = 0', 'row_gap = 2');
  assert.equal(parse(editStatusConfig(customized, command, false)).ui.sidebar.agents.row_gap, 2);
});

test('leave room for usage and separator rows within Herdr layout limits', () => {
  const rows = Array.from({ length: 14 }, () => ['agent']);
  assert.throws(() => editStatusConfig(`[ui]\n[ui.sidebar.agents]\nrows = ${JSON.stringify(rows)}\n`, command, true), /16 agent rows/);
});

test('updating the status command replaces its entry and preserves other commands', () => {
  const original = '[ui]\ntab_bar_right = [\n'
    + '{type="command",command="echo clock"},\n'
    + '{type="command",command="node previous/status.mjs --herdr-tokenbar"}\n]\n';
  const updated = editStatusConfig(original, command, true);
  assert.deepEqual(parse(updated).ui.tab_bar_right.map(entry => entry.command), ['echo clock', command]);
  assert.equal(parse(updated).ui.tab_bar_right[1].interval_seconds, 3);
  assert.equal(parse(updated).ui.tab_bar_right[1].timeout_seconds, 8);
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
  const stateDir = join(directory, 'state');
  await writeFile(config, '# keep this comment\n[ui]\nstatus_indicators="dots"\n');
  const env = { ...process.env, HERDR_CONFIG_PATH: config, HERDR_PLUGIN_CONFIG_DIR: pluginConfig,
    HERDR_PLUGIN_STATE_DIR: stateDir, HERDR_BIN_PATH: process.execPath, HERDR_TOKENBAR_SEPARATOR_COLORS: '' };
  const setup = action => execFileSync(process.execPath, ['src/setup.mjs', action], { env, encoding: 'utf8', windowsHide: true });
  setup('enable');
  const enabled = await readFile(config, 'utf8');
  assert.equal(parse(enabled).ui.tab_bar_right.length, 1);
  assert.ok(enabled.startsWith('# keep this comment'));
  assert.equal((await readdir(directory)).filter(name => name.endsWith('.bak')).length, 1);
  const script = join(pluginConfig, 'runtime', 'status.mjs');
  assert.equal(await readFile(join(pluginConfig, 'runtime', 'presentation.mjs'), 'utf8'), await readFile('src/presentation.mjs', 'utf8'));
  assert.equal(await readFile(join(pluginConfig, 'runtime', 'codex-live.mjs'), 'utf8'), await readFile('src/codex-live.mjs', 'utf8'));
  assert.equal(JSON.parse(await readFile(join(pluginConfig, 'runtime', 'runtime-settings.json'), 'utf8')).stateDir, stateDir);
  assert.match(execFileSync(process.execPath, [script, '--help'], { encoding: 'utf8', windowsHide: true }), /Usage:/);
  if (process.platform === 'win32') {
    const nativeCommand = parse(enabled).ui.tab_bar_right[0].command;
    const output = execFileSync('cmd.exe', ['/d', '/c', nativeCommand], {
      env, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true,
    });
    assert.match(output, /Tokens -- \| Context --\/--/);
  }
  env.HERDR_PLUGIN_STATE_DIR = join(directory, 'other-state');
  setup('enable');
  assert.equal(await readFile(config, 'utf8'), enabled);
  assert.equal(JSON.parse(await readFile(join(pluginConfig, 'runtime', 'runtime-settings.json'), 'utf8')).stateDir, stateDir);
  setup('disable');
  assert.deepEqual(parse(await readFile(config, 'utf8')).ui.tab_bar_right, []);
});


test('upgrade compact layouts and plugin-owned blank spacing to colored separator rows', () => {
  const original = '[ui]\n[ui.sidebar.agents]\nrow_gap = 1 # herdr-tokenbar spacing\n'
    + stringifyToml({ rows: [...compactRows, ...legacyUsageRows] });
  const enabled = editStatusConfig(original, command, true);
  const agents = parse(enabled).ui.sidebar.agents;
  assert.equal(agents.row_gap, 0);
  assert.deepEqual(agents.rows, [...compactRows, ...usageRows]);
  assert.equal(editStatusConfig(enabled, command, true), enabled);
  assert.equal((enabled.match(/herdr-tokenbar spacing/g) ?? []).length, 1);
  const disabled = editStatusConfig(enabled, command, false);
  assert.deepEqual(parse(disabled).ui.sidebar.agents.rows, nativeRows);
  assert.equal(parse(disabled).ui.sidebar.agents.row_gap, undefined);
  assert.equal(editStatusConfig(disabled, command, false), disabled);
});

test('separator palettes are configurable without recoloring counters or the gradient', () => {
  const enabled = editStatusConfig('[ui]\n', command, true, { separatorColors: '#abc,#123456' });
  const rows = parse(enabled).ui.sidebar.agents.rows;
  assert.equal(rows.at(-1).length, 8);
  assert.deepEqual(rows.at(-1).map(item => item.fg), Array.from({ length: 8 }, (_, index) => index % 2 ? '#123456' : '#abc'));
  assert.deepEqual(rows.slice(1, -1), usageRows.slice(0, -1));
  assert.equal(editStatusConfig(enabled, command, true, { separatorColors: '#abc,#123456' }), enabled);
  assert.throws(() => editStatusConfig(enabled, command, true, { separatorColors: 'red' }), /Separator palette/);
  assert.deepEqual(parse(editStatusConfig(enabled, command, false, { separatorColors: 'invalid' })).ui.sidebar.agents.rows, nativeRows);
});

test('four additional rows fit exactly at the sixteen-row limit', () => {
  const customRows = Array.from({ length: 12 }, () => ['agent']);
  const original = '[ui]\n[ui.sidebar.agents]\n' + stringifyToml({ rows: customRows });
  assert.equal(parse(editStatusConfig(original, command, true)).ui.sidebar.agents.rows.length, 16);
});


test('setup applies the configured separator palette and invalid colors cannot rewrite the live config', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tokenbar-palette-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, 'config.toml');
  const pluginConfig = join(directory, 'plugin');
  await writeFile(config, '[ui]\n');
  const env = { ...process.env, HERDR_CONFIG_PATH: config, HERDR_PLUGIN_CONFIG_DIR: pluginConfig,
    HERDR_BIN_PATH: process.execPath, HERDR_TOKENBAR_SEPARATOR_COLORS: '#abc,#123456' };
  const setup = currentEnv => execFileSync(process.execPath, ['src/setup.mjs', 'enable'], {
    env: currentEnv, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  setup(env);
  const enabled = await readFile(config, 'utf8');
  assert.deepEqual(parse(enabled).ui.sidebar.agents.rows.at(-1).map(item => item.fg),
    ['#abc', '#123456', '#abc', '#123456', '#abc', '#123456', '#abc', '#123456']);
  assert.throws(() => setup({ ...env, HERDR_TOKENBAR_SEPARATOR_COLORS: 'not-a-color' }), /Separator palette/);
  assert.equal(await readFile(config, 'utf8'), enabled);
});
