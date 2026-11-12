/** Install a stable status command and update only this plugin's Herdr tab-bar entry. */
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { editStatusConfig } from './config.mjs';
import { readJson, writeJson } from './usage.mjs';

/**
 * Resolve Herdr's configuration location, respecting its explicit override.
 * @param {object} [env] Configuration-path environment variables.
 * @param {string} [platform] Node platform identifier.
 * @returns {string} Config file path.
 */
export function configPath(env = process.env, platform = process.platform) {
  if (env.HERDR_CONFIG_PATH) return env.HERDR_CONFIG_PATH;
  if (platform === 'win32') return join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'herdr', 'config.toml');
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'herdr', 'config.toml');
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'herdr', 'config.toml');
}

/**
 * Quote an argument for Herdr's command shell.
 * @param {string} value Literal argument.
 * @param {string} [platform] Node platform identifier.
 * @returns {string} Shell-quoted argument; rejects unsupported Windows path characters.
 */
export function quoteArgument(value, platform = process.platform) {
  if (platform !== 'win32') return `'${value.replaceAll("'", "'\\''")}'`;
  if (/["%\r\n]/.test(value)) throw new Error('Windows status command paths cannot contain quotes, percent signs or newlines');
  return `"${value}"`;
}

/**
 * Build a command with cmd.exe's outer quoting for executable paths containing spaces.
 * @param {string[]} argv Executable followed by literal arguments.
 * @param {string} [platform] Node platform identifier.
 * @returns {string} Command ready for Herdr's platform-specific shell.
 */
export function shellCommand(argv, platform = process.platform) {
  const command = argv.map(value => quoteArgument(value, platform)).join(' ');
  return platform === 'win32' ? `"${command}"` : command;
}

async function main(action) {
  if (!['enable', 'disable', 'refresh'].includes(action)) throw new Error('Usage: node src/setup.mjs enable|disable|refresh');
  const herdr = process.env.HERDR_BIN_PATH || 'herdr';
  const target = configPath();
  const configDir = process.env.HERDR_PLUGIN_CONFIG_DIR;
  if (!configDir) throw new Error('Run this command through herdr plugin action invoke herdr.tokenbar.enable');
  const runtime = join(configDir, 'runtime');
  const settings = await readJson(join(runtime, 'runtime-settings.json'));
  const stateDir = settings?.stateDir ?? process.env.HERDR_PLUGIN_STATE_DIR ?? join(configDir, 'state');
  if (action !== 'disable') {
    await mkdir(runtime, { recursive: true });
    for (const name of ['presentation.mjs', 'sessions.mjs', 'usage.mjs', 'status.mjs']) await copyFile(join(dirname(fileURLToPath(import.meta.url)), name), join(runtime, name));
    await writeJson(join(runtime, 'runtime-settings.json'), { stateDir });
  }
  if (action === 'refresh') return;
  const script = join(runtime, 'status.mjs');
  const command = shellCommand([process.execPath, script, '--herdr-tokenbar']);
  const original = await readFile(target, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  const updated = editStatusConfig(original, command, action === 'enable', { separatorColors: process.env.HERDR_TOKENBAR_SEPARATOR_COLORS });
  if (updated !== original) {
    await mkdir(dirname(target), { recursive: true });
    const backup = `${target}.tokenbar-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
    if (original) await writeFile(backup, original, { flag: 'wx', mode: 0o600 });
    await writeFile(target, updated, { mode: 0o600 });
    console.log(`Updated ${target}${original ? ` (backup: ${backup})` : ''}`);
  }
  try {
    execFileSync(herdr, ['server', 'reload-config'], { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    console.log('Herdr configuration reloaded.');
  } catch {
    console.log('Configuration saved. Reload config from Herdr settings or reattach the client to apply it.');
  }
  console.log(action === 'enable' ? `Token status enabled. Claude statusline command: ${shellCommand([process.execPath, script, 'claude-statusline'])}`
    : 'Token status disabled. Runtime files and usage state are retained.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
