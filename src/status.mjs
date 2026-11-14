/** Herdr tab-bar command and optional Claude statusline receiver; only Node built-ins are needed. */
import { execFile } from 'node:child_process';
import { promisify, stripVTControlCharacters } from 'node:util';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { claudeUsage, loadCodexUsage, number, readJson, writeJson } from './usage.mjs';
import { codexSessionResolver } from './sessions.mjs';
import { readLoadedCodexSessions } from './codex-live.mjs';
import { BAR_WIDTH, GRADIENT_STYLES, gradientToken, separatorTokens, sessionColorSlots } from './presentation.mjs';

const execute = promisify(execFile);
const tokenCount = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

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
    ...Object.fromEntries(GRADIENT_STYLES.map(style => [style.token.slice(1), null])),
  };
  const progress = `${bar} ${percent === null ? '--' : `${Math.round(percent)}%`} · 剩余: ${formatTokens(remaining)}`;
  tokens[`tokenbar_${level}`] = progress; // Keep existing custom/legacy rows working.
  tokens[gradientToken(percent)] = progress;
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

async function listItems(kind, env) {
  const { stdout } = await execute(env.HERDR_BIN_PATH || 'herdr', [kind, 'list'], {
    env, encoding: 'utf8', timeout: 1800, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
  });
  const response = JSON.parse(stdout);
  if (response.error) throw new Error(response.error.message || 'Herdr API error');
  const items = response.result?.[`${kind}s`];
  if (!Array.isArray(items)) throw new Error(`Unexpected Herdr ${kind} list`);
  return items;
}

async function listWorkspaces(env) {
  try {
    return await listItems('workspace', env);
  } catch (error) {
    // A display-label lookup must never hide valid provider counters.
    if (env.HERDR_TOKENBAR_DEBUG === '1') console.error(`Unable to list workspaces: ${error.message}`);
    return [];
  }
}

function displayText(value) {
  return typeof value === 'string' ? stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').trim() : '';
}

/** Build a single identity token without Herdr's automatic inter-token separators. */
export function formatAgentHeader(agent, workspace, machine = 'Local') {
  const label = displayText(workspace?.label) || displayText(agent?.workspace_id) || '--';
  return `${displayText(machine) || 'Local'}/${displayText(agent?.agent) || '--'} ${label}`;
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
export async function collectStatus({ env = process.env, paneId, stateDir, agents, liveSessions } = {}) {
  agents ??= await listItems('agent', env);
  const target = paneId ?? env.HERDR_ACTIVE_PANE_ID;
  const agent = selectAgent(agents, target);
  if (!agent) return { usage: null, reason: 'no-agent-session', paneId: target ?? null };
  const entries = await collectAgentUsages({ env, stateDir, agents, liveSessions });
  const { agent: ignored, ...result } = entries.find(entry => entry.agent === agent);
  return { ...result, paneId: agent.pane_id, provider: agent.agent };
}

/** Load live provider usage; session recovery is shared by sidebar and tab-bar diagnostics. */
export async function collectAgentUsages({ env = process.env, stateDir, agents, liveSessions } = {}) {
  agents ??= await listItems('agent', env);
  const directory = stateDir ?? await stateDirectory(env);
  const codexHome = env.CODEX_HOME || join(homedir(), '.codex');
  if (liveSessions === undefined && agents.some(agent => agent.agent === 'codex')) {
    liveSessions = await readLoadedCodexSessions(codexHome, env);
  }
  const resolveCodex = codexSessionResolver(codexHome, { liveSessions, agents, stateDir: directory });
  return Promise.all(agents.map(async agent => {
    const base = { agent, usage: null, sessionId: null, sessionSource: null };
    try {
      if (agent.agent === 'codex') {
        const identity = await resolveCodex(agent);
        if (identity.reason) return { ...base, ...identity };
        const usage = await loadCodexUsage(codexHome, identity.sessionId, directory, identity.file);
        return { ...base, ...identity, usage, reason: usage ? null : 'no-usage-events' };
      }
      const session = agent.agent_session;
      if (agent.agent !== 'claude') return { ...base, reason: 'unsupported-provider' };
      if (session?.kind !== 'id' || session.agent !== 'claude') return { ...base, reason: 'no-agent-session' };
      const sample = await readJson(join(directory, `claude-${safeSessionId(session.value)}.json`));
      const usage = sample?.sessionId === session.value && sample.paneId === agent.pane_id ? sample.usage : null;
      return { ...base, sessionId: session.value, sessionSource: 'herdr', usage,
        reason: usage ? null : 'claude-statusline-unavailable' };
    } catch (error) {
      if (env.HERDR_TOKENBAR_DEBUG === '1') {
        console.error(`Unable to read ${agent.agent} usage for ${agent.pane_id}: ${error.message}`);
      }
      return { ...base, reason: `usage-read-error: ${error.code ?? error.message}` };
    }
  }));
}

/** Refresh display-only pane metadata; short TTLs clear rows after the command stops polling. */
export async function reportAgentUsages(entries, env = process.env, workspaces = []) {
  const herdr = env.HERDR_BIN_PATH || 'herdr';
  const colorSlots = sessionColorSlots(entries.filter(({ agent }) => agent?.pane_id && agent.agent).map(({ agent }) => agent.pane_id));
  const byWorkspace = new Map(workspaces.filter(workspace => typeof workspace?.workspace_id === 'string')
    .map(workspace => [workspace.workspace_id, workspace]));
  const results = await Promise.allSettled(entries.map(async ({ agent, usage }) => {
    if (!agent?.pane_id || !agent.agent) return;
    // Clear inactive tokens in each color family after percentage or session-slot changes.
    const metadata = {
      tokenbar_header: formatAgentHeader(agent, byWorkspace.get(agent.workspace_id), env.HERDR_TOKENBAR_MACHINE),
      ...formatAgentTokens(usage),
      ...separatorTokens(colorSlots.get(agent.pane_id)),
    };
    // Native metadata patches accept at most 16 keys (including clears). Keep the
    // full gradient family together, so a single update clears its previous color.
    const gradientKeys = new Set(['tokenbar_unknown', ...GRADIENT_STYLES.map(style => style.token.slice(1))]);
    const pairs = Object.entries(metadata);
    const groups = [pairs.filter(([key]) => gradientKeys.has(key)), pairs.filter(([key]) => !gradientKeys.has(key))];
    const patches = groups.flatMap(group => Array.from({ length: Math.ceil(group.length / 16) },
      (_, index) => group.slice(index * 16, (index + 1) * 16)));
    // Disjoint patches merge on the server; parallel calls preserve the polling timeout budget.
    await Promise.all(patches.map(async patch => {
      const tokens = patch.flatMap(([key, value]) =>
        value === null ? ['--clear-token', key] : ['--token', `${key}=${value}`]);
      await execute(herdr, ['pane', 'report-metadata', agent.pane_id, '--source', 'herdr-tokenbar', '--agent', agent.agent,
        ...tokens, '--ttl-ms', '7000'], {
        env, encoding: 'utf8', timeout: 1800, maxBuffer: 1024 * 1024, windowsHide: true,
      });
    }));
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

/** Strict argument parsing keeps flags from accidentally becoming a pane ID. */
export function parseStatusArgs(args) {
  const options = { json: false, herdrTokenbar: false, help: false, claude: false };
  if (args[0] === 'claude-statusline') {
    if (args.length !== 1) throw new Error('claude-statusline does not accept additional arguments');
    return { ...options, claude: true };
  }
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === '--json') options.json = true;
    else if (value === '--herdr-tokenbar') options.herdrTokenbar = true;
    else if (value === '--help') options.help = true;
    else if (value === '--pane') {
      if (options.paneId !== undefined) throw new Error('--pane may only be supplied once');
      const pane = args[++index];
      if (!pane || pane.startsWith('-')) throw new Error('--pane requires a pane ID');
      options.paneId = pane;
    } else throw new Error(`Unknown argument: ${value}`);
  }
  return options;
}

async function main(args) {
  const options = parseStatusArgs(args);
  if (options.help) {
    console.log('Usage: node src/status.mjs [--json] [--pane PANE_ID]\n       node src/status.mjs claude-statusline');
    return;
  }
  if (options.claude) {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 1024 * 1024) throw new Error('Claude statusline payload exceeds 1 MiB');
    }
    console.log(formatStatus(await recordClaude(JSON.parse(input))));
    return;
  }
  try {
    const paneId = options.paneId;
    let result;
    if (options.herdrTokenbar) {
      // Fetch labels alongside usage so a slow label API does not add another timeout window.
      const [entries, workspaces] = await Promise.all([collectAgentUsages(), listWorkspaces(process.env)]);
      await reportAgentUsages(entries, process.env, workspaces);
      const agent = selectAgent(entries.map(entry => entry.agent), paneId ?? process.env.HERDR_ACTIVE_PANE_ID);
      const entry = entries.find(entry => entry.agent === agent);
      const { agent: ignored, ...sample } = entry ?? {};
      result = { ...sample, usage: sample.usage ?? null, provider: agent?.agent ?? null,
        paneId: agent?.pane_id ?? paneId ?? process.env.HERDR_ACTIVE_PANE_ID ?? null,
        reason: entry?.reason ?? (agent ? null : 'no-agent-session') };
    } else {
      result = await collectStatus({ paneId });
    }
    console.log(options.json ? JSON.stringify(result) : formatStatus(result.usage));
  } catch (error) {
    // Keep the fixed labels visible while Herdr reconnects or a transcript is inaccessible.
    if (options.json) console.log(JSON.stringify({ usage: null, reason: error.message }));
    else console.log(formatStatus(null));
    if (process.env.HERDR_TOKENBAR_DEBUG === '1') console.error(error.message);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
