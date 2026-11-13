import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLoadedCodexSessions } from '../src/codex-live.mjs';

const ID = '019a4d90-0000-7000-8000-000000000001';
const OTHER = '019a4d90-0000-7000-8000-000000000002';

function serverFrame(payload, opcode = 1, final = true) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const header = Buffer.alloc(data.length < 126 ? 2 : data.length < 65536 ? 4 : 10);
  header[0] = (final ? 0x80 : 0) | opcode;
  header[1] = data.length < 126 ? data.length : data.length < 65536 ? 126 : 127;
  if (header.length === 4) header.writeUInt16BE(data.length, 2);
  if (header.length === 10) header.writeBigUInt64BE(BigInt(data.length), 2);
  return Buffer.concat([header, data]);
}

async function fixture(t, { reply, fragments = false, badHandshake = false } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'tokenbar-live-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, 'app-server-control'));
  await writeFile(join(home, 'app-server-control', 'app-server-control.sock'), '');
  const requests = [], pongs = [], child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false;
  child.kill = () => { child.killed = true; child.stdout.destroy(); child.stderr.destroy(); };
  let buffer = Buffer.alloc(0), upgraded = false;
  const write = data => { if (!child.stdout.destroyed) child.stdout.write(data); };
  const respond = response => {
    const data = Buffer.from(JSON.stringify(response));
    if (fragments) {
      write(serverFrame(data.subarray(0, 7), 1, false));
      write(serverFrame('ping', 9));
      const tail = serverFrame(data.subarray(7), 0);
      write(tail.subarray(0, 1)); write(tail.subarray(1, 3)); write(tail.subarray(3));
    } else write(serverFrame(data));
  };
  child.stdin = new Writable({ write(chunk, encoding, callback) {
    try {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) { callback(); return; }
        const key = buffer.toString('ascii').match(/Sec-WebSocket-Key: (.+)\r\n/)[1];
        const accept = badHandshake ? 'invalid' : createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        buffer = buffer.subarray(end + 4); upgraded = true;
        queueMicrotask(() => write(Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)));
      }
      while (buffer.length >= 2) {
        assert.ok(buffer[1] & 0x80, 'client frames must be masked');
        const opcode = buffer[0] & 15;
        let size = buffer[1] & 127, offset = 2;
        if (size === 126) { if (buffer.length < 4) break; size = buffer.readUInt16BE(2); offset = 4; }
        if (buffer.length < offset + 4 + size) break;
        const mask = buffer.subarray(offset, offset + 4);
        const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + size));
        buffer = buffer.subarray(offset + 4 + size);
        for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4];
        if (opcode === 10) { pongs.push(payload.toString()); continue; }
        const request = JSON.parse(payload.toString()); requests.push(request);
        queueMicrotask(() => {
          if (!request.id) return;
          if (reply) { reply(request, respond, write); return; }
          const result = request.method === 'initialize' ? {}
            : request.method === 'thread/loaded/list' ? { data: request.params.cursor ? [OTHER] : [ID], nextCursor: request.params.cursor ? null : 'page-2' }
              : { thread: { id: request.params.threadId, cwd: home, status: { type: 'active' },
                name: '会话'.repeat(100), source: 'vscode', parentThreadId: null, preview: 'x'.repeat(70000) } };
          respond({ id: request.id, result });
        });
      }
      callback();
    } catch (error) { callback(error); }
  } });
  const env = { CODEX_BIN_PATH: process.execPath };
  const run = options => readLoadedCodexSessions(home, env, { timeoutMs: 500, spawnProxy: () => child, ...options });
  return { home, env, run, requests, pongs, child };
}

test('reads paginated loaded thread metadata without turns, resuming threads or starting a server', async t => {
  const f = await fixture(t);
  const sessions = await f.run();
  assert.deepEqual(sessions.map(thread => thread.id), [ID, OTHER]);
  assert.equal(sessions[0].name, '会话'.repeat(100));
  assert.equal(sessions[0].preview, undefined);
  assert.deepEqual(f.requests.map(request => request.method), ['initialize', 'initialized', 'thread/loaded/list', 'thread/loaded/list', 'thread/read', 'thread/read']);
  assert.ok(f.requests.filter(request => request.method === 'thread/read').every(request => request.params.includeTurns === false));
  assert.equal(f.child.killed, true);
});

test('metadata responses survive fragmented frames, partial headers, large payloads and interleaved pings', async t => {
  const f = await fixture(t, { fragments: true });
  const result = await f.run();
  assert.deepEqual(result.map(thread => thread.id), [ID, OTHER]);
  assert.ok(f.pongs.length >= 4); assert.ok(f.pongs.every(pong => pong === 'ping'));
});

test('an authoritative empty loaded list is different from an unavailable daemon', async t => {
  const f = await fixture(t, { reply: (request, respond) => respond({ id: request.id,
    result: request.method === 'initialize' ? {} : { data: [], nextCursor: null } }) });
  assert.deepEqual(await f.run(), []);
});

test('a missing control socket does not launch a proxy or start a daemon', async t => {
  const f = await fixture(t);
  await rm(join(f.home, 'app-server-control', 'app-server-control.sock'));
  let spawned = false;
  const result = await f.run({ spawnProxy: () => { spawned = true; return f.child; } });
  assert.equal(result, null); assert.equal(spawned, false);
});

for (const [name, reply] of [
  ['RPC error', (request, respond) => respond({ id: request.id, error: { code: -32601 } })],
  ['close frame', (request, respond, write) => write(serverFrame('', 8))],
  ['malformed JSON', (request, respond, write) => write(serverFrame('{broken'))],
  ['oversized message', (request, respond, write) => {
    const header = Buffer.from([0x81, 127, 0, 0, 0, 0, 0, 0x80, 0, 0]); write(header);
  }],
  ['invalid thread ID', (request, respond) => respond({ id: request.id,
    result: request.method === 'initialize' ? {} : { data: ['../invalid'] } })],
  ['repeated cursor', (request, respond) => respond({ id: request.id,
    result: request.method === 'initialize' ? {} : { data: [ID], nextCursor: 'same' } })],
  ['thread disappears during snapshot', (request, respond) => respond({ id: request.id,
    result: request.method === 'initialize' ? {} : request.method === 'thread/loaded/list' ? { data: [ID] }
      : { thread: { id: OTHER, cwd: '/tmp', status: { type: 'active' } } } })],
]) test(`unavailable metadata on ${name} is bounded and closes the proxy`, async t => {
  const f = await fixture(t, { reply });
  assert.equal(await f.run(), null); assert.equal(f.child.killed, true);
});

test('rejects a bad WebSocket upgrade without issuing metadata requests', async t => {
  const f = await fixture(t, { badHandshake: true });
  assert.equal(await f.run(), null); assert.deepEqual(f.requests, []);
});

test('an unresponsive daemon times out and closes the proxy', async t => {
  const f = await fixture(t, { reply: () => {} });
  assert.equal(await f.run({ timeoutMs: 30 }), null);
  assert.equal(f.child.killed, true);
});
