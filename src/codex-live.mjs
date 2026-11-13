/** Read metadata from an existing Codex daemon; never start a server or resume a thread. */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const SESSION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

async function proxyCommand(home, env) {
  const name = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const candidates = [env.CODEX_BIN_PATH, join(home, 'packages', 'app-server-daemon', 'current', 'bin', name),
    ...(env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean).map(directory => join(directory, name))];
  for (const file of candidates.filter(Boolean)) {
    if (!await stat(file).then(info => info.isFile(), () => false)) continue;
    return file.endsWith('.js') ? [process.execPath, [file]] : [file, []];
  }
  return null;
}

function clientFrame(payload, opcode = 1) {
  const data = Buffer.from(payload);
  const header = Buffer.alloc(data.length < 126 ? 6 : 8);
  header[0] = 0x80 | opcode;
  header[1] = 0x80 | (data.length < 126 ? data.length : 126);
  if (data.length >= 126) header.writeUInt16BE(data.length, 2);
  const mask = randomBytes(4);
  mask.copy(header, header.length - 4);
  for (let index = 0; index < data.length; index++) data[index] ^= mask[index % 4];
  return Buffer.concat([header, data]);
}

/** A bounded WebSocket client over the daemon's stdio proxy (also works on Windows). */
async function loadedSessionsFromProxy(child, timeoutMs) {
  let timer;
  try {
    return await new Promise(resolve => {
      let settled = false, upgraded = false, buffer = Buffer.alloc(0), fragments = [], fragmentSize = 0;
      let nextId = 1;
      const pending = new Map();
      const key = randomBytes(16).toString('base64');
      const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      const finish = value => { if (!settled) { settled = true; resolve(value); } };
      timer = setTimeout(() => finish(null), timeoutMs);
      const fail = () => finish(null);
      child.on('error', fail);
      child.on('exit', fail);
      child.stdin.on('error', fail);
      child.stdout.on('error', fail);
      child.stdout.on('end', fail);
      child.stderr?.resume();
      const send = value => child.stdin.write(clientFrame(JSON.stringify(value)));
      const request = (method, params) => new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        send({ id, method, params });
      });
      const list = async () => {
        await request('initialize', { clientInfo: { name: 'herdr-tokenbar', version: '0.1.3' } });
        send({ method: 'initialized' });
        const ids = [], cursors = new Set();
        let cursor;
        do {
          const page = await request('thread/loaded/list', { limit: 100, ...(cursor ? { cursor } : {}) });
          if (!Array.isArray(page?.data) || page.data.some(id => !SESSION_ID.test(id))) throw new Error('Invalid loaded threads');
          ids.push(...page.data);
          if (ids.length > 256) throw new Error('Too many loaded threads');
          cursor = page.nextCursor;
          if (cursor && cursors.has(cursor)) throw new Error('Repeated cursor');
          cursors.add(cursor);
        } while (cursor);
        const threads = await Promise.all([...new Set(ids)].map(async id => {
          const result = await request('thread/read', { threadId: id, includeTurns: false });
          const thread = result?.thread;
          if (thread?.id !== id || typeof thread.cwd !== 'string' || typeof thread.status?.type !== 'string') {
            throw new Error('Invalid thread metadata');
          }
          return { id, cwd: thread.cwd, status: thread.status.type, name: thread.name,
            parentThreadId: thread.parentThreadId ?? null, source: thread.source };
        }));
        finish(threads);
      };
      const message = payload => {
        const response = JSON.parse(payload.toString('utf8'));
        const entry = pending.get(response.id);
        if (!entry) return;
        pending.delete(response.id);
        if (response.error) entry.reject(new Error('Codex metadata request failed'));
        else entry.resolve(response.result);
      };
      child.stdout.on('data', chunk => {
        if (settled) return;
        try {
          if (buffer.length + chunk.length > MAX_MESSAGE_BYTES + 16384) throw new Error('Oversized proxy buffer');
          buffer = Buffer.concat([buffer, chunk]);
          if (!upgraded) {
            const end = buffer.indexOf('\r\n\r\n');
            if (end < 0) { if (buffer.length > 16384) fail(); return; }
            const header = buffer.subarray(0, end).toString('ascii');
            if (!/^HTTP\/1\.1 101\b/.test(header) || !header.split('\r\n')
              .some(line => /^sec-websocket-accept:/i.test(line) && line.slice(line.indexOf(':') + 1).trim() === accept)) { fail(); return; }
            buffer = buffer.subarray(end + 4);
            upgraded = true;
            list().catch(fail);
          }
          while (!settled && buffer.length >= 2) {
            const opcode = buffer[0] & 15, final = Boolean(buffer[0] & 0x80);
            if (buffer[0] & 0x70 || buffer[1] & 0x80) throw new Error('Unsupported WebSocket frame');
            let size = buffer[1] & 127, offset = 2;
            if (size === 126) {
              if (buffer.length < 4) return;
              size = buffer.readUInt16BE(2); offset = 4;
            } else if (size === 127) {
              if (buffer.length < 10) return;
              const large = buffer.readBigUInt64BE(2);
              if (large > BigInt(MAX_MESSAGE_BYTES)) throw new Error('Oversized WebSocket message');
              size = Number(large); offset = 10;
            }
            if (size > MAX_MESSAGE_BYTES || (opcode >= 8 && (!final || size > 125))) throw new Error('Invalid frame size');
            if (buffer.length < offset + size) return;
            const payload = buffer.subarray(offset, offset + size);
            buffer = buffer.subarray(offset + size);
            if (opcode === 8) { fail(); return; }
            if (opcode === 9) { child.stdin.write(clientFrame(payload, 10)); continue; }
            if (opcode === 10) continue;
            if (opcode !== (fragments.length ? 0 : 1)) throw new Error('Invalid message fragment');
            fragments.push(payload); fragmentSize += size;
            if (fragmentSize > MAX_MESSAGE_BYTES) throw new Error('Oversized WebSocket message');
            if (final) { message(Buffer.concat(fragments)); fragments = []; fragmentSize = 0; }
          }
        } catch { fail(); }
      });
      child.stdin.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
  } finally {
    clearTimeout(timer);
    child.stdin.destroy();
    child.stdout.destroy();
    child.kill();
  }
}

/** Return null when unavailable, distinct from an authoritative empty loaded-thread list. */
export async function readLoadedCodexSessions(home, env = process.env, { spawnProxy = spawn, timeoutMs = 1200 } = {}) {
  try {
    const control = join(home, 'app-server-control');
    const socket = join(control, 'app-server-control.sock');
    // Windows can list AF_UNIX sockets while stat/open on the socket returns EACCES.
    if (!(await readdir(control).catch(() => [])).includes('app-server-control.sock')) return null;
    const command = await proxyCommand(home, env);
    if (!command) return null;
    const [file, args] = command;
    const child = spawnProxy(file, [...args, 'app-server', 'proxy', '--sock', socket], {
      env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    return await loadedSessionsFromProxy(child, timeoutMs);
  } catch { return null; }
}
