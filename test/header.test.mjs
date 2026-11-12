import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatAgentHeader } from '../src/status.mjs';

test('header combines machine/provider with the Herdr workspace label, not the cwd basename', () => {
  const agent = { agent: 'codex', workspace_id: 'w1', cwd: '/different/subdirectory' };
  assert.equal(formatAgentHeader(agent, { label: 'herdr-tokenbar' }), 'Local/codex herdr-tokenbar');
  assert.equal(formatAgentHeader({ ...agent, agent: 'claude' }, { label: '中文 項目' }), 'Local/claude 中文 項目');
  assert.equal(formatAgentHeader(agent, { label: 'project' }, 'devbox'), 'devbox/codex project');
});

test('missing workspace labels fall back to that agent workspace ID, never to cwd or another pane', () => {
  const agent = { agent: 'codex', workspace_id: 'w7', cwd: '/not-a-workspace-label' };
  for (const workspace of [undefined, null, {}, { label: '' }, { label: '  ' }, { label: 123 }]) {
    assert.equal(formatAgentHeader(agent, workspace), 'Local/codex w7');
  }
  assert.equal(formatAgentHeader({ agent: 'codex' }), 'Local/codex --');
  assert.equal(formatAgentHeader(null), 'Local/-- --');
});

test('header removes terminal escape sequences and control characters without destroying Unicode', () => {
  const agent = { agent: 'codex', workspace_id: 'w1' };
  assert.equal(formatAgentHeader(agent, { label: '\x1b[31m中文\x1b[0m\n項目\x00' }), 'Local/codex 中文 項目');
  assert.equal(formatAgentHeader(agent, { label: 'project' }, '\x1b[32mLocal\x1b[0m'), 'Local/codex project');
  assert.equal(formatAgentHeader(agent, { label: 'project' }, '  '), 'Local/codex project');
});
