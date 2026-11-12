import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createTokenbarRows, gradientToken, GRADIENT_STYLES, TOKENBAR_ROWS,
  separatorTokens, sessionColorSlots, SEPARATOR_COLORS, SEPARATOR_WIDTH,
} from '../src/presentation.mjs';
import { formatAgentTokens } from '../src/status.mjs';

test('presentation rows respect native row/token limits and keep counters separate from separators', () => {
  assert.deepEqual(TOKENBAR_ROWS.map(row => row.length), [1, 1, 16, 8]);
  assert.equal(TOKENBAR_ROWS[0][0].token, '$tokenbar_total');
  assert.equal(TOKENBAR_ROWS[1][0].token, '$tokenbar_context');
  for (const row of TOKENBAR_ROWS) {
    assert.ok(row.length <= 16);
    for (const style of row) {
      assert.match(style.fg ?? '#000', /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i);
      assert.equal(style.dim, false);
    }
  }
});

test('the fifteen-step gradient has exact green/yellow/red anchors and distinct intermediate colors', () => {
  assert.equal(GRADIENT_STYLES.length, 15);
  assert.equal(GRADIENT_STYLES[0].fg, '#a6e3a1');
  assert.equal(GRADIENT_STYLES[7].fg, '#f9e2af');
  assert.equal(GRADIENT_STYLES[14].fg, '#f38ba8');
  assert.equal(new Set(GRADIENT_STYLES.map(style => style.fg)).size, 15);
  assert.equal(GRADIENT_STYLES[14].bold, true);
});

test('gradient selection clamps known percentages but does not invent a color for missing data', () => {
  for (const [value, expected] of [[-10, '00'], [0, '00'], [50, '07'], [100, '14'], [150, '14']]) {
    assert.equal(gradientToken(value), 'tokenbar_gradient_' + expected);
  }
  for (const value of [undefined, null, NaN, Infinity, '50']) assert.equal(gradientToken(value), 'tokenbar_unknown');
});

test('exactly one visible gradient token is active and all inactive colors clear at every percentage', () => {
  const row = TOKENBAR_ROWS[2];
  for (let index = 0; index <= 1000; index++) {
    const percent = index / 10;
    const tokens = formatAgentTokens({ contextUsed: percent * 2000, contextWindow: 200000, percent });
    const visible = row.filter(style => tokens[style.token.slice(1)] !== null);
    assert.equal(visible.length, 1);
    assert.equal(visible[0].token.slice(1), gradientToken(percent));
    assert.match(tokens[gradientToken(percent)], /剩余: /);
    assert.equal(tokens.tokenbar_unknown, null);
  }
  const unknown = formatAgentTokens(null);
  assert.deepEqual(row.filter(style => unknown[style.token.slice(1)] !== null).map(style => style.fg), ['#7f849c']);
});

test('remaining context uses the requested Chinese caption, including exact 164.5k, zero and unknown values', () => {
  const tokens = formatAgentTokens({ total: 1000, contextUsed: 35500, contextWindow: 200000 });
  assert.equal(tokens[gradientToken(17.75)], '█░░░░░ 18% · 剩余: 164.5k');
  assert.equal(tokens.tokenbar_healthy, tokens[gradientToken(17.75)]);
  assert.match(formatAgentTokens({ contextUsed: 250000, contextWindow: 200000 })[gradientToken(100)], /剩余: 0k$/);
  assert.equal(formatAgentTokens(null).tokenbar_unknown, '░░░░░░ -- · 剩余: --');
  assert.ok(Object.values(tokens).every(value => value === null || !value.includes(' left')));
});

test('each separator report contains one line and explicitly clears the other seven colors', () => {
  for (let slot = 0; slot < SEPARATOR_COLORS.length; slot++) {
    const tokens = separatorTokens(slot);
    assert.equal(Object.keys(tokens).length, 8);
    assert.equal(Object.values(tokens).filter(value => value !== null).length, 1);
    assert.equal(tokens['tokenbar_separator_' + slot], '─'.repeat(SEPARATOR_WIDTH));
    assert.ok(Buffer.byteLength(tokens['tokenbar_separator_' + slot], 'utf8') <= 256);
  }
  assert.deepEqual(separatorTokens(8), separatorTokens(0));
  assert.deepEqual(separatorTokens(NaN), separatorTokens(0));
});

test('separator preserves the requested 64 characters in every color slot', () => {
  assert.equal(SEPARATOR_WIDTH, 64);
  const row = TOKENBAR_ROWS.at(-1);
  for (let slot = 0; slot < SEPARATOR_COLORS.length; slot++) {
    const tokens = separatorTokens(slot);
    const visible = row.map(style => tokens[style.token.slice(1)]).filter(value => value !== null);
    assert.deepEqual(visible, ['─'.repeat(64)]);
    assert.equal(Buffer.byteLength(visible[0], 'utf8'), 192);
  }
});

test('up to eight sessions have distinct slots, independent of API order, with documented cycling after eight', () => {
  const ids = ['w1:p1', 'w1:p2', 'w2:p1', 'w3:p1', 'w4:p1', 'w5:p1', 'w6:p1', 'w7:p1'];
  const slots = sessionColorSlots(ids);
  assert.equal(new Set(slots.values()).size, 8);
  assert.deepEqual(sessionColorSlots([...ids].reverse()), slots);
  assert.deepEqual(sessionColorSlots([...ids, ids[0]]), slots);
  const more = sessionColorSlots([...ids, 'w8:p1']);
  assert.equal(more.get('w8:p1'), more.get('w1:p1'));
});

test('custom separator palettes cannot change gradient colors and never mutate defaults', () => {
  const rows = createTokenbarRows('#AbC, #123456');
  assert.deepEqual(rows.at(-1).map(style => style.fg), ['#abc', '#123456', '#abc', '#123456', '#abc', '#123456', '#abc', '#123456']);
  assert.deepEqual(rows[2], TOKENBAR_ROWS[2]);
  assert.equal(TOKENBAR_ROWS.at(-1)[0].fg, '#89b4fa');
  assert.equal(createTokenbarRows(['#fff']).at(-1).every(style => style.fg === '#fff'), true);
});

for (const palette of ['red', '#12', '#12345g', '#fff,', [], 123, ['#fff', 1], Array(9).fill('#fff')]) {
  test('reject invalid separator palette: ' + JSON.stringify(palette), () => {
    assert.throws(() => createTokenbarRows(palette), /Separator palette/);
  });
}
