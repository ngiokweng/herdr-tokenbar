/** Normalize provider usage without counting cached or reasoning tokens twice. */
import { open, readdir, readFile, stat, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const CODEX_USAGE_CACHE_VERSION = 2;

/**
 * Validate a provider counter without coercing missing data to zero.
 * @param {unknown} value Provider counter.
 * @returns {number|null} Finite, nonnegative count or null.
 */
export function number(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function total(usage) {
  if (!usage) return null;
  return number(usage.total_tokens) ?? (number(usage.input_tokens) !== null && number(usage.output_tokens) !== null
    ? usage.input_tokens + usage.output_tokens : null);
}

/**
 * Match Codex /status usage while retaining cached input in context occupancy.
 * @param {object} record Parsed JSONL record.
 * @returns {object|null} Cumulative usage and last-request context, or null for other events.
 */
export function codexUsage(record) {
  if (record?.type !== 'event_msg' || record.payload?.type !== 'token_count') return null;
  const info = record.payload.info;
  if (!info) return null; // Rate-limit-only notifications carry no new usage.
  const contextUsed = total(info.last_token_usage);
  const contextWindow = number(info.model_context_window);
  const cumulative = info.total_token_usage;
  const input = number(cumulative?.input_tokens);
  const cachedInput = number(cumulative?.cached_input_tokens) ?? 0;
  const output = number(cumulative?.output_tokens);
  const uncachedInput = input !== null ? Math.max(0, input - cachedInput) : null;
  const totalIncludingCached = total(cumulative);
  // Codex /status excludes cached input from usage, although cached tokens still occupy context.
  const statusTotal = uncachedInput !== null && output !== null ? uncachedInput + output
    : totalIncludingCached !== null ? Math.max(0, totalIncludingCached - cachedInput) : null;
  return {
    provider: 'codex', total: statusTotal, input: uncachedInput, cachedInput, output,
    totalIncludingCached, contextUsed, contextWindow,
    percent: contextUsed !== null && contextWindow > 0 ? contextUsed / contextWindow * 100 : null,
    updatedAt: record.timestamp ?? null,
  };
}

/**
 * Normalize Claude's counters using its reported context limit.
 * @param {object} payload Statusline JSON received on stdin.
 * @returns {object|null} Usage sample, or null when no context data is present.
 */
export function claudeUsage(payload) {
  const context = payload?.context_window;
  if (!context) return null;
  const current = context.current_usage;
  const contextUsed = current && number(current.input_tokens) !== null
    ? current.input_tokens + (number(current.cache_creation_input_tokens) ?? 0)
      + (number(current.cache_read_input_tokens) ?? 0) + (number(current.output_tokens) ?? 0)
    : null;
  const contextWindow = number(context.context_window_size);
  const input = number(context.total_input_tokens);
  const output = number(context.total_output_tokens);
  return {
    provider: 'claude', total: input !== null && output !== null ? input + output : null,
    contextUsed, contextWindow,
    percent: number(context.used_percentage) ?? (contextUsed !== null && contextWindow > 0
      ? contextUsed / contextWindow * 100 : null),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Read an optional cache without making status rendering depend on it.
 * @param {string} file JSON cache path.
 * @returns {Promise<object|null>} Parsed data, or null for a missing or invalid cache.
 */
export async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

/**
 * Atomically replace JSON so concurrent polls never read half a write.
 * @param {string} file Destination path; parent directories are created.
 * @param {object} value JSON-serializable data.
 * @returns {Promise<void>} Resolves after replacement.
 */
export async function writeJson(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

async function matchingFile(directory, sessionId) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries.find(entry => entry.isFile() && (entry.name === `${sessionId}.jsonl`
    || entry.name.endsWith(`-${sessionId}.jsonl`)))?.name;
}

async function findSession(directory, sessionId, depth = 0) {
  const file = await matchingFile(directory, sessionId);
  if (file) return join(directory, file);
  if (depth >= 3) return null;
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  // Recent date directories usually contain active sessions. Never follow symlinks.
  for (const entry of entries.filter(entry => entry.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) {
    const found = await findSession(join(directory, entry.name), sessionId, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Resolve the exact session Herdr identified, without borrowing a neighbouring session.
 * @param {string} codexHome Codex data root.
 * @param {string} sessionId Herdr-reported session UUID.
 * @param {string} [cachedPath] Previously resolved transcript path.
 * @returns {Promise<string|null>} Matching transcript path, or null.
 */
export async function locateCodexSession(codexHome, sessionId, cachedPath) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId ?? '')) return null;
  if (cachedPath && (basename(cachedPath) === `${sessionId}.jsonl`
    || basename(cachedPath).endsWith(`-${sessionId}.jsonl`))
    && await stat(cachedPath).then(value => value.isFile(), () => false)) return cachedPath;
  return await findSession(join(codexHome, 'sessions'), sessionId)
    ?? await findSession(join(codexHome, 'archived_sessions'), sessionId);
}

/**
 * Scan backwards past large tool output and unfinished records for the latest valid usage.
 * @param {string} file Codex transcript path.
 * @returns {Promise<object|null>} Latest complete usage sample, or null.
 */
export async function latestCodexUsage(file) {
  const handle = await open(file, 'r');
  try {
    let position = (await handle.stat()).size;
    let carry = Buffer.alloc(0);
    let discarding = false;
    while (position > 0) {
      const length = Math.min(position, 64 * 1024);
      position -= length;
      const chunk = Buffer.alloc(length);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      // The leading fragment belongs to the preceding block; visit complete records newest first.
      const parts = Buffer.concat([chunk.subarray(0, bytesRead), carry]).toString('utf8').split('\n');
      const first = parts.shift();
      for (let index = parts.length - 1; index >= 0; index--) {
        if (discarding && index === parts.length - 1) continue;
        if (!parts[index].includes('"token_count"')) continue;
        try {
          const usage = codexUsage(JSON.parse(parts[index]));
          if (usage) return usage;
        } catch { /* A writer may still be appending the final record. */ }
      }
      // Token events are small. Bound carry while skipping multi-megabyte transcript lines.
      discarding = parts.length === 0 ? discarding : false;
      carry = Buffer.from(first, 'utf8');
      if (carry.length > 128 * 1024) { carry = Buffer.alloc(0); discarding = true; }
      if (position === 0 && !discarding && first.includes('"token_count"')) {
        try { return codexUsage(JSON.parse(first)); } catch { return null; }
      }
    }
    return null;
  } finally { await handle.close(); }
}

/**
 * Load a Codex sample while caching its file identity and counters between polls.
 * @param {string} codexHome Codex data root.
 * @param {string} sessionId Herdr-reported session UUID.
 * @param {string} stateDir Plugin-owned cache directory.
 * @returns {Promise<object|null>} Latest sample, or null if no matching usage exists.
 */
export async function loadCodexUsage(codexHome, sessionId, stateDir) {
  const key = createHash('sha256').update(`${codexHome}\0${sessionId}`).digest('hex');
  const cacheFile = join(stateDir, `codex-${key}.json`);
  const cache = await readJson(cacheFile);
  const file = await locateCodexSession(codexHome, sessionId, cache?.file);
  if (!file) return null;
  const info = await stat(file);
  if (cache?.version === CODEX_USAGE_CACHE_VERSION && cache.file === file
    && cache.size === info.size && cache.mtime === info.mtimeMs) return cache.usage;
  const usage = await latestCodexUsage(file);
  await writeJson(cacheFile, { version: CODEX_USAGE_CACHE_VERSION, file, size: info.size, mtime: info.mtimeMs, usage }).catch(() => {});
  return usage;
}
