/** Resolve provider identity without selecting the newest transcript in a directory. */
import { open, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, isAbsolute, join, relative, resolve, win32 } from 'node:path';
import { locateCodexSession, readJson, writeJson } from './usage.mjs';

export const SESSION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

const ACTIVE_SESSION_WINDOW_MS = 2 * 60 * 1000;

/** Compare native or Windows directory names, even in cross-platform fixtures. */
export function sameDirectory(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !left || !right) return false;
  const windowsPath = value => /^(?:[a-z]:[\\/]|\\\\)/i.test(value);
  if (windowsPath(left) && windowsPath(right)) {
    return win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase();
  }
  return resolve(left) === resolve(right);
}

/** Read only the bounded session header, never conversation/tool records. */
export async function sessionMetadata(file) {
  const handle = await open(file, 'r');
  try {
    const chunks = [];
    for (let position = 0; position < 1024 * 1024; position += 16384) {
      const buffer = Buffer.alloc(16384);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      const part = buffer.subarray(0, bytesRead);
      const end = part.indexOf(10);
      chunks.push(end < 0 ? part : part.subarray(0, end));
      if (end >= 0 || bytesRead < buffer.length) {
        const record = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        return record?.type === 'session_meta' ? record.payload : null;
      }
    }
    return null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  } finally { await handle.close(); }
}

function titleNames(agent) {
  const title = (agent.terminal_title_stripped ?? agent.terminal_title ?? '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/^[\u2800-\u28ff]\s*/u, '').trim();
  const separator = title.lastIndexOf(' | ');
  return new Set([title, ...(separator >= 0 ? [title.slice(0, separator)] : [])].filter(Boolean));
}

async function sessionIndex(home) {
  try {
    // This is Codex's title index, not a transcript; later records supersede renames.
    const handle = await open(resolve(home, 'session_index.jsonl'), 'r');
    try {
      if ((await handle.stat()).size > 16 * 1024 * 1024) return [];
      const data = await handle.readFile('utf8');
      const latest = new Map();
      for (const line of data.split('\n')) {
        try {
          const record = JSON.parse(line);
          if (SESSION_ID.test(record.id) && typeof record.thread_name === 'string') latest.set(record.id, record);
        } catch { /* A concurrent title update may leave an unfinished last line. */ }
      }
      return [...latest.values()];
    } finally { await handle.close(); }
  } catch { return []; }
}

function sessionIdFromFile(file) {
  const match = basename(file).match(/-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i);
  return match?.[1] ?? null;
}

async function recentSessionFiles(home, now = Date.now()) {
  const root = join(home, 'sessions');
  const files = [];
  // Codex stores active transcripts under YYYY/MM/DD. Check adjacent local
  // dates to cover midnight and clock/time-zone boundaries without walking the
  // entire session history on each status poll.
  const dates = new Set([-1, 0, 1].map(offset => {
    const date = new Date(now);
    date.setDate(date.getDate() + offset);
    return join(root, String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'));
  }));
  await Promise.all([...dates].map(async directory => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries.map(async entry => {
      const path = join(directory, entry.name);
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) return;
      const info = await stat(path).catch(() => null);
      if (!info || now - info.mtimeMs < 0 || now - info.mtimeMs > ACTIVE_SESSION_WINDOW_MS) return;
      const id = sessionIdFromFile(path);
      if (id) files.push({ id, file: path, mtimeMs: info.mtimeMs });
    }));
  }));
  return files;
}

async function activeSession(home, agent) {
  if (agent?.agent_status !== 'working' || !agent.cwd) return null;
  const candidates = [];
  for (const candidate of await recentSessionFiles(home)) {
    const metadata = await sessionMetadata(candidate.file).catch(() => null);
    const id = metadata?.id ?? metadata?.session_id;
    if (id !== candidate.id || !sameDirectory(metadata?.cwd, agent.cwd)) continue;
    candidates.push({ ...candidate, metadata });
  }
  return candidates.length === 1 ? {
    sessionId: candidates[0].id,
    file: candidates[0].file,
    sessionSource: 'active-cwd',
    reason: null,
  } : null;
}

/** Share lookups per poll; recovered bindings must still belong to a loaded thread and the same terminal/mapping. */
export function codexSessionResolver(home, { liveSessions = null, agents = [], stateDir } = {}) {
  let index;
  const headers = new Map();
  const lookup = id => {
    if (!headers.has(id)) headers.set(id, (async () => {
      const file = await locateCodexSession(home, id);
      if (!file) return null;
      const metadata = await sessionMetadata(file);
      if (metadata && (metadata.id ?? metadata.session_id) !== id) return null;
      return { id, file, metadata };
    })());
    return headers.get(id);
  };
  return async agent => {
    const reported = agent.agent_session;
    let id = reported?.agent === 'codex' && reported.kind === 'id' && SESSION_ID.test(reported.value)
      ? reported.value : null;
    if (!id && reported?.agent === 'codex' && reported.kind === 'path' && typeof reported.value === 'string') {
      // A Herdr path mapping is accepted only inside this Codex home's session roots.
      const path = resolve(reported.value);
      const inside = ['sessions', 'archived_sessions'].some(root => {
        const tail = relative(resolve(home, root), path);
        return tail && tail !== '..' && !tail.startsWith(`..${win32.sep}`)
          && !tail.startsWith('../') && !isAbsolute(tail);
      });
      if (inside) {
        const metadata = await sessionMetadata(path).catch(() => null);
        const candidate = metadata?.id ?? metadata?.session_id;
        if (SESSION_ID.test(candidate) && (basename(path) === `${candidate}.jsonl`
          || basename(path).endsWith(`-${candidate}.jsonl`))) id = candidate;
      }
    }
    const explicit = id ? await lookup(id) : null;
    const wrongCwd = explicit?.metadata?.cwd && agent.cwd && !sameDirectory(explicit.metadata.cwd, agent.cwd);
    const names = titleNames(agent);
    index ??= sessionIndex(home);
    const records = await index;
    const indexed = id && records.find(record => record.id === id);
    const wrongTitle = indexed && !names.has(indexed.thread_name);
    const authoritative = () => ({ sessionId: id, file: explicit.file, sessionSource: 'herdr', reason: null });
    const bindingKey = stateDir && agent.terminal_id && createHash('sha256')
      .update(JSON.stringify([resolve(home), agent.pane_id, agent.terminal_id, agent.cwd, id])).digest('hex');
    const bindingFile = bindingKey && join(stateDir, `codex-live-${bindingKey}.json`);
    const binding = bindingFile ? await readJson(bindingFile) : null;
    const recovered = SESSION_ID.test(binding?.sessionId) && binding.sessionId !== id;
    if (!Array.isArray(liveSessions) && recovered) {
      // Once disproved, a stale Herdr id cannot reappear during a daemon outage.
      return { sessionId: null, reason: 'session-state-unavailable' };
    }
    // /clear can unload a thread without updating Herdr's id or terminal title.
    // Loaded daemon metadata can disprove that stale mapping, even when Windows
    // has not refreshed the open transcript's mtime. Never use newest-file wins.
    if (Array.isArray(liveSessions) && !liveSessions.some(thread => thread.id === id)) {
      const live = liveSessions.filter(thread => !thread.parentThreadId && typeof thread.source !== 'object'
        && sameDirectory(thread.cwd, agent.cwd));
      if (live.length) {
        const peers = agents.filter(other => other.agent === 'codex' && other.pane_id !== agent.pane_id
          && sameDirectory(other.cwd, agent.cwd));
        const claimed = new Set(peers.map(other => other.agent_session?.value));
        let candidates = live.filter(thread => !claimed.has(thread.id));
        // Two unmapped panes in one directory are not distinguishable by cwd.
        if (peers.some(other => !liveSessions.some(thread => thread.id === other.agent_session?.value))) candidates = [];
        if (agent.agent_status === 'working') {
          const active = candidates.filter(thread => thread.status === 'active');
          if (active.length) candidates = active;
        }
        const named = candidates.filter(thread => names.has(thread.name));
        if (named.length) candidates = named;
        if (candidates.length > 1 && !named.length && !candidates.some(thread => thread.status === 'active') && bindingFile) {
          // Keep the observed active binding when it becomes idle. /clear unloads
          // it; a new active thread or a changed terminal/Herdr id supersedes it.
          const bound = candidates.find(thread => thread.id === binding?.sessionId);
          if (bound) candidates = [bound];
        }
        if (candidates.length !== 1) return { sessionId: null, reason: 'ambiguous-agent-session' };
        const candidate = await lookup(candidates[0].id);
        if (!candidate?.metadata || !sameDirectory(candidate.metadata.cwd, agent.cwd)) {
          return { sessionId: candidates[0].id, sessionSource: 'codex-live', reason: 'session-file-not-found' };
        }
        if (bindingFile) await writeJson(bindingFile, { sessionId: candidate.id }).catch(() => {});
        return { sessionId: candidate.id, file: candidate.file, sessionSource: 'codex-live', reason: null };
      }
      if (recovered) return { sessionId: null, reason: 'no-agent-session' };
    }
    // A renamed/missing title alone cannot invalidate an otherwise valid Herdr mapping.
    if (explicit && !wrongCwd && !wrongTitle) return authoritative();
    const matches = [];
    for (const record of records) {
      if (!names.has(record.thread_name)) continue;
      const candidate = await lookup(record.id);
      if (candidate?.metadata && sameDirectory(candidate.metadata.cwd, agent.cwd)) matches.push(candidate);
    }
    if (matches.length === 1) return { sessionId: matches[0].id, file: matches[0].file, sessionSource: 'title-cwd', reason: null };
    // A thread can legitimately move to a worktree. A cwd change alone is not proof of a stale id.
    if (!matches.length && explicit && (!wrongCwd || !wrongTitle)) return authoritative();
    const active = await activeSession(home, agent);
    if (active) return active;
    return { sessionId: null, reason: matches.length > 1 ? 'ambiguous-agent-session'
      : wrongCwd ? 'session-cwd-mismatch' : id ? 'session-file-not-found' : 'no-agent-session' };
  };
}
