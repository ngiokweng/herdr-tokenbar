/** Herdr tab-bar command and optional Claude statusline receiver; only Node built-ins are needed. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { claudeUsage, loadCodexUsage, number, readJson, writeJson } from './usage.mjs';

const execute = promisify(execFile);
const tokenCount = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const BAR_WIDTH = 6;

/**
 * Format token counts in thousands consistently across Herdr's status surfaces.
 * @param {number|null} value Token count.
 * @returns {string} Count in k with up to one decimal, or -- for unavailable data.
 */
export function formatTokens(value) {
  return number(value) === null ? '--' : `${tokenCount.format(value / 1000)}k`;
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
 * Render a compact fallback for layouts that still use the original $tokenbar token.
 * @param {object|null} usage Provider sample.
 * @returns {string} Cumulative usage and context counts with a progress bar.
 */
export function formatAgentTokenRow(usage) {
  const { percent, bar } = contextProgress(usage);
  return `T ${formatTokens(usage?.total)} C ${formatTokens(usage?.contextUsed)}/${formatTokens(usage?.contextWindow)} ${percent === null ? '--' : `${Math.round(percent)}%`} ${bar}`;
}

function contextProgress(usage) {
  const used = number(usage?.contextUsed);
  const window = number(usage?.contextWindow);
  const rawPercent = number(usage?.percent) ?? (used !== null && window > 0 ? used / window * 100 : null);
  const percent = rawPercent === null ? null : Math.min(100, rawPercent);
  const filled = percent === null ? 0 : Math.round(percent / 100 * BAR_WIDTH);
  return { percent, bar: `${'█'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)}`,
    remaining: used !== null && window > 0 ? Math.max(0, window - used) : null };
}

/**
 * Split token counts from the colored context bar for narrow agent sidebars.
 * @param {object|null} usage Provider sample.
 * @returns {object} Metadata values; inactive color tokens are null so old states get cleared.
 */
export function formatAgentTokens(usage) {
  const { percent, bar, remaining } = contextProgress(usage);
  const level = percent === null ? 'unknown' : percent > 80 ? 'critical' : percent >= 50 ? 'warning' : 'healthy';
  const tokens = {
    tokenbar: formatAgentTokenRow(usage),
    tokenbar_total: `Tokens ${formatTokens(usage?.total)}`,
    tokenbar_context: `Ctx ${formatTokens(usage?.contextUsed)}/${formatTokens(usage?.contextWindow)}`,
    tokenbar_healthy: null, tokenbar_warning: null, tokenbar_critical: null, tokenbar_unknown: null,
  };
  tokens[`tokenbar_${level}`] = `${bar} ${percent === null ? '--' : `${Math.round(percent)}%`} · ${formatTokens(remaining)} left`;
  return tokens;
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

async function listAgents(env) {
  const { stdout } = await execute(env.HERDR_BIN_PATH || 'herdr', ['agent', 'list'], {
    env, encoding: 'utf8', timeout: 1800, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
  });
  const response = JSON.parse(stdout);
  if (response.error) throw new Error(response.error.message || 'Herdr API error');
  const agents = response.result?.agents;
  if (!Array.isArray(agents)) throw new Error('Unexpected Herdr agent list');
  return agents;
}

async function usageForAgent(agent, env, directory) {
  const session = agent?.agent_session;
  if (!agent || session?.kind !== 'id') return null;
  if (agent.agent === 'codex' && session.agent === 'codex') {
    return loadCodexUsage(env.CODEX_HOME || join(homedir(), '.codex'), session.value, directory);
  }
  if (agent.agent === 'claude' && session.agent === 'claude') {
    const sample = await readJson(join(directory, `claude-${safeSessionId(session.value)}.json`));
    return sample?.sessionId === session.value && sample.paneId === agent.pane_id ? sample.usage : null;
  }
  return null;
}

/**
 * Resolve state for the checkout or the stable installed runtime.
 * @param {object} [env] Environment and optional state-directory override.
 * @returns {Promise<string>} Plugin-owned cache directory.
 */
export async function stateDirectory(env = process.env) {
  const settings = await readJson(join(dirname(fileURLToPath(import.meta.url)), 'runtime-settings.json'));
  return env.HERDR_TOKENBAR_STATE_DIR
    ?? settings?.stateDir ?? env.HERDR_PLUGIN_STATE_DIR ?? join(homedir(), '.cache', 'herdr-tokenbar');
}

/**
 * Read Herdr's session mapping and the selected provider's latest usage.
 * @param {object} [options] Optional env, paneId and stateDir overrides.
 * @returns {Promise<object>} Sample and session identity, or an unavailable-data reason.
 */
export async function collectStatus({ env = process.env, paneId, stateDir } = {}) {
  const agents = await listAgents(env);
  const agent = selectAgent(agents, paneId ?? env.HERDR_ACTIVE_PANE_ID);
  const session = agent?.agent_session;
  if (!agent || session?.kind !== 'id') return { usage: null, reason: 'no-agent-session', paneId: agent?.pane_id ?? paneId ?? env.HERDR_ACTIVE_PANE_ID ?? null };
  const directory = stateDir ?? await stateDirectory(env);
  const usage = await usageForAgent(agent, env, directory);
  return { paneId: agent.pane_id, provider: agent.agent, sessionId: session.value,
    usage, reason: usage ? null : 'usage-unavailable' };
}

/** Load each live agent's provider usage for the Herdr sidebar. */
export async function collectAgentUsages({ env = process.env, stateDir } = {}) {
  const agents = await listAgents(env);
  const needsState = agents.some(agent => agent.agent_session?.kind === 'id'
    && ((agent.agent === 'codex' && agent.agent_session.agent === 'codex')
      || (agent.agent === 'claude' && agent.agent_session.agent === 'claude')));
  const directory = stateDir ?? (needsState ? await stateDirectory(env) : null);
  return Promise.all(agents.map(async agent => {
    try {
      return { agent, usage: directory ? await usageForAgent(agent, env, directory) : null };
    } catch (error) {
      if (env.HERDR_TOKENBAR_DEBUG === '1') {
        console.error(`Unable to read ${agent.agent} usage for ${agent.pane_id}: ${error.message}`);
      }
      return { agent, usage: null };
    }
  }));
}

/** Refresh display-only pane metadata; short TTLs clear rows after the command stops polling. */
export async function reportAgentUsages(entries, env = process.env) {
  const herdr = env.HERDR_BIN_PATH || 'herdr';
  const results = await Promise.allSettled(entries.map(async ({ agent, usage }) => {
    if (!agent?.pane_id || !agent.agent) return;
    // Only one color token has a value. Clearing the others prevents stale bars after state changes.
    const tokens = Object.entries(formatAgentTokens(usage)).flatMap(([key, value]) =>
      value === null ? ['--clear-token', key] : ['--token', `${key}=${value}`]);
    await execute(herdr, ['pane', 'report-metadata', agent.pane_id, '--source', 'herdr-tokenbar', '--agent', agent.agent,
      ...tokens, '--ttl-ms', '7000'], {
      env, encoding: 'utf8', timeout: 1800, maxBuffer: 1024 * 1024, windowsHide: true,
    });
  }));
  if (env.HERDR_TOKENBAR_DEBUG === '1') {
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        const { agent } = entries[index];
        console.error(`Unable to report token usage for ${agent?.pane_id ?? 'unknown pane'}: ${result.reason.message}`);
      }
    });
  }
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
    const paneId = paneIndex >= 0 ? args[paneIndex + 1] : undefined;
    let result;
    if (args.includes('--herdr-tokenbar')) {
      const entries = await collectAgentUsages();
      await reportAgentUsages(entries);
      const agent = selectAgent(entries.map(entry => entry.agent), paneId ?? process.env.HERDR_ACTIVE_PANE_ID);
      result = { usage: entries.find(entry => entry.agent === agent)?.usage ?? null,
        paneId: agent?.pane_id ?? paneId ?? process.env.HERDR_ACTIVE_PANE_ID ?? null,
        reason: agent ? null : 'no-agent-session' };
    } else {
      result = await collectStatus({ paneId });
    }
    console.log(args.includes('--json') ? JSON.stringify(result) : formatStatus(result.usage));
  } catch (error) {
    // Keep the fixed labels visible while Herdr reconnects or a transcript is inaccessible.
    if (args.includes('--json')) console.log(JSON.stringify({ usage: null, reason: error.message }));
    else console.log(formatStatus(null));
    if (process.env.HERDR_TOKENBAR_DEBUG === '1') console.error(error.message);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
