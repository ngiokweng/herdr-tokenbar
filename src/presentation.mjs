/** Shared sidebar styles; each row stays within Herdr 0.9.4's 16-token limit. */
export const BAR_WIDTH = 6;
// Preserve the requested 64-character separator. Herdr may ellipsize it in
// narrow sidebars; the shared metadata does not adapt to each client's width.
export const SEPARATOR_WIDTH = 64;
export const SEPARATOR_COLORS = [
  '#89b4fa', '#cba6f7', '#94e2d5', '#f9e2af',
  '#f5c2e7', '#a6e3a1', '#fab387', '#74c7ec',
];
export const LEGACY_PROGRESS_TOKENS = [
  '$tokenbar_healthy', '$tokenbar_warning', '$tokenbar_critical', '$tokenbar_unknown',
];

function interpolateColor(from, to, amount) {
  const channels = [1, 3, 5].map(offset => {
    const start = parseInt(from.slice(offset, offset + 2), 16);
    const end = parseInt(to.slice(offset, offset + 2), 16);
    return Math.round(start + (end - start) * amount).toString(16).padStart(2, '0');
  });
  return '#' + channels.join('');
}

// One whole-token color per step: Herdr inserts separators between adjacent tokens.
export const GRADIENT_STYLES = Array.from({ length: 15 }, (_, index) => ({
  token: '$tokenbar_gradient_' + String(index).padStart(2, '0'),
  fg: index <= 7 ? interpolateColor('#a6e3a1', '#f9e2af', index / 7)
    : interpolateColor('#f9e2af', '#f38ba8', (index - 7) / 7),
  ...(index >= 12 ? { bold: true } : {}),
  dim: false,
}));
export const UNKNOWN_PROGRESS_STYLE = { token: '$tokenbar_unknown', fg: '#7f849c', dim: false };
export const SEPARATOR_STYLES = SEPARATOR_COLORS.map((fg, index) => ({
  token: '$tokenbar_separator_' + index, fg, dim: false,
}));

export function gradientToken(percent) {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return 'tokenbar_unknown';
  const index = Math.round(Math.min(100, Math.max(0, percent)) / 100 * (GRADIENT_STYLES.length - 1));
  return GRADIENT_STYLES[index].token.slice(1);
}

/** Accept 1-8 #RGB/#RRGGBB colors; shorter palettes repeat across the eight slots. */
function separatorColors(value) {
  if (value === undefined || value === '') return SEPARATOR_COLORS;
  const colors = typeof value === 'string' ? value.split(',').map(color => color.trim()) : value;
  if (!Array.isArray(colors) || !colors.length || colors.length > SEPARATOR_COLORS.length
    || colors.some(color => typeof color !== 'string' || !/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(color))) {
    throw new Error('Separator palette must contain 1-8 comma-separated #RGB or #RRGGBB colors');
  }
  return SEPARATOR_COLORS.map((_, index) => colors[index % colors.length].toLowerCase());
}

export function createTokenbarRows(palette) {
  const colors = separatorColors(palette);
  return [
    [{ token: '$tokenbar_total', fg: '#89b4fa', dim: false }],
    [{ token: '$tokenbar_context', dim: false }],
    [...GRADIENT_STYLES.map(style => ({ ...style })), { ...UNKNOWN_PROGRESS_STYLE }],
    SEPARATOR_STYLES.map((style, index) => ({ ...style, fg: colors[index] })),
  ];
}
export const TOKENBAR_ROWS = createTokenbarRows();

export function separatorTokens(slot = 0) {
  const index = Number.isInteger(slot) ? (slot % SEPARATOR_COLORS.length + SEPARATOR_COLORS.length) % SEPARATOR_COLORS.length : 0;
  return Object.fromEntries(SEPARATOR_STYLES.map((style, candidate) => [
    style.token.slice(1), candidate === index ? '─'.repeat(SEPARATOR_WIDTH) : null,
  ]));
}

/** Distinct slots for up to eight active panes, independent of API response order. */
export function sessionColorSlots(paneIds) {
  const ids = [...new Set(paneIds)].sort();
  return new Map(ids.map((id, index) => [id, index % SEPARATOR_COLORS.length]));
}
