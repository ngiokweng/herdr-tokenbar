/** Herdr tab-bar command and optional Claude statusline receiver; only Node built-ins are needed. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { claudeUsage, loadCodexUsage, readJson, writeJson } from './usage.mjs';

const execute = promisify(execFile);

/**
 * Abbreviate a count for Herdr's limited status space.
 * @param {number|null} value Token count.
 * @returns {string} Count with optional k/M suffix, or -- for unavailable data.
 */
export function formatTokens(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '--';
  if (value < 1000) return String(Math.round(value));
  const divisor = value >= 1_000_000 ? 1_000_000 : 1000;
  return `${(value / divisor).toFixed(1).replace(/\.0$/, '')}${divisor === 1000 ? 'k' : 'M'}`;
}

/**
 * Render cumulative usage separately from current context occupancy.
 * @param {object|null} usage Provider sample.
 * @returns {string} One plain-text status line with persistent labels.
 */
export function formatStatus(usage) {
  const percent = usage?.percent;
  const percentage = typeof percent === 'number' && Number.isFinite(percent) ? ` ${Math.round(percent)}%` : '';
  return `Tokens ${formatTokens(usage?.total)} | Context ${formatTokens(usage?.contextUsed)}/${formatTokens(usage?.contextWindow)}${percentage}`;
}

/**
 * Select an agent without borrowing another pane's usage.
 * @param {object[]} agents Herdr agent list.
 * @param {string} [paneId] Explicit active pane; otherwise use the focused agent.
 * @returns {object|undefined} Matching agent, if present.
 */
export function selectAgent(agents, paneId) {
  return paneId ? agents.find(agent => agent.pane_id === paneId) : agents.find(agent => agent.focused);
}

/**
 * Resolve state for the checkout or the stable installed runtime.
 * @param {object} [env] Environment and optional state-directory override.
 * @returns {Promise<string>} Plugin-owned cache directory.
 */
export async function stateDirectory(env = process.env) {
  const settings = await readJson(join(dirname(fileURLToPath(import.meta.url)), 'runtime-settings.json'));
  return env.HERDR_TOKENBAR_STATE_DIR ?? env.HERDR_HOLD_TOKEN_STATE_DIR
    ?? settings?.stateDir ?? env.HERDR_PLUGIN_STATE_DIR ?? join(homedir(), '.cache', 'herdr-tokenbar');
}

/**
 * Read Herdr's session mapping and the selected provider's latest usage.
 * @param {object} [options] Optional env, paneId and stateDir overrides.
 * @returns {Promise<object>} Sample and session identity, or an unavailable-data reason.
 */
export async function collectStatus({ env = process.env, paneId, stateDir } = {}) {
  const { stdout } = await execute(env.HERDR_BIN_PATH || 'herdr', ['agent', 'list'], {
    env, encoding: 'utf8', timeout: 1800, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
  });
  const response = JSON.parse(stdout);
  if (response.error) throw new Error(response.error.message || 'Herdr API error');
  const agents = response.result?.agents;
  if (!Array.isArray(agents)) throw new Error('Unexpected Herdr agent list');
  const agent = selectAgent(agents, paneId ?? env.HERDR_ACTIVE_PANE_ID);
  const session = agent?.agent_session;
  if (!agent || session?.kind !== 'id') return { usage: null, reason: 'no-agent-session', paneId: agent?.pane_id ?? paneId ?? env.HERDR_ACTIVE_PANE_ID ?? null };
  const directory = stateDir ?? await stateDirectory(env);
  let usage = null;
  if (agent.agent === 'codex' && session.agent === 'codex') {
    usage = await loadCodexUsage(env.CODEX_HOME || join(homedir(), '.codex'), session.value, directory);
  } else if (agent.agent === 'claude' && session.agent === 'claude') {
    const sample = await readJson(join(directory, `claude-${safeSessionId(session.value)}.json`));
    if (sample?.sessionId === session.value && sample.paneId === agent.pane_id) usage = sample.usage;
  }
  return { paneId: agent.pane_id, provider: agent.agent, sessionId: session.value,
    usage, reason: usage ? null : 'usage-unavailable' };
}

function safeSessionId(value) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value ?? '')) throw new Error('Invalid session id');
  return value;
}

/**
 * Save Claude usage and pane identity without persisting its conversation payload.
 * @param {object} payload Claude statusline JSON.
 * @param {object} [env] Pane identity and optional state-directory override.
 * @returns {Promise<object>} Saved usage sample.
 */
export async function recordClaude(payload, env = process.env) {
  const usage = claudeUsage(payload);
  if (!usage || !env.HERDR_PANE_ID) throw new Error('Claude statusline requires usage data and HERDR_PANE_ID');
  const sessionId = safeSessionId(payload.session_id);
  await writeJson(join(await stateDirectory(env), `claude-${sessionId}.json`), {
    sessionId, paneId: env.HERDR_PANE_ID, usage,
  });
  return usage;
}

async function main(args) {
  if (args.includes('--help')) {
    console.log('Usage: node src/status.mjs [--json] [--pane PANE_ID]\n       node src/status.mjs claude-statusline');
    return;
  }
  if (args[0] === 'claude-statusline') {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    console.log(formatStatus(await recordClaude(JSON.parse(input))));
    return;
  }
  const paneIndex = args.indexOf('--pane');
  if (paneIndex >= 0 && !args[paneIndex + 1]) throw new Error('--pane requires a pane ID');
  try {
    const result = await collectStatus({ paneId: paneIndex >= 0 ? args[paneIndex + 1] : undefined });
    console.log(args.includes('--json') ? JSON.stringify(result) : formatStatus(result.usage));
  } catch (error) {
    // Keep the fixed labels visible while Herdr reconnects or a transcript is inaccessible.
    if (args.includes('--json')) console.log(JSON.stringify({ usage: null, reason: error.message }));
    else console.log(formatStatus(null));
    if (process.env.HERDR_TOKENBAR_DEBUG === '1' || process.env.HERDR_HOLD_TOKEN_DEBUG === '1') console.error(error.message);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
