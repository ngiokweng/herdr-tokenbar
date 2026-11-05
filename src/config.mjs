/** Make narrowly scoped TOML edits while preserving unrelated settings and comments. */
import { parse, stringify } from 'smol-toml';

function inlineValue(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(inlineValue).join(', ')}]`;
  if (value && [null, Object.prototype].includes(Object.getPrototypeOf(value))) {
    return `{ ${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)} = ${inlineValue(item)}`).join(', ')} }`;
  }
  return stringify({ value }).trim().replace(/^value\s*=\s*/, '');
}

/** Locate a TOML value's end, respecting strings, nested arrays/tables, and comments. */
function valueEnd(text, start) {
  let depth = 0;
  let quote = null;
  let triple = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      if (quote === '"' && char === '\\') { index++; continue; }
      if (char === quote && (!triple || text.slice(index, index + 3) === quote.repeat(3))) {
        if (triple) index += 2;
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      triple = text.slice(index, index + 3) === char.repeat(3);
      if (triple) index += 2;
    } else if (char === '[' || char === '{') depth++;
    else if (char === ']' || char === '}') depth--;
    else if (char === '#') {
      if (depth === 0) return index;
      const newline = text.indexOf('\n', index);
      if (newline < 0) return text.length;
      index = newline - 1;
    } else if ((char === '\n' || char === '\r') && depth === 0) return index;
  }
  return text.length;
}

/**
 * Add/remove this plugin's entry while retaining unrelated TOML settings and text.
 * @param {string} text Original config.toml contents.
 * @param {string} command Fully quoted status command.
 * @param {boolean} enabled Whether the plugin entry should be present.
 * @returns {string} Validated configuration, unchanged when already configured.
 */
export function editStatusConfig(text, command, enabled) {
  const config = parse(text);
  const entries = config.ui?.tab_bar_right ?? [];
  if (!Array.isArray(entries)) throw new Error('ui.tab_bar_right must be an array');
  // Recognize the previous name so upgrading replaces its entry instead of adding a second bar.
  const owned = entry => entry.type === 'command'
    && ['--herdr-tokenbar', '--herdr-hold-token'].some(marker => entry.command?.includes(marker));
  const filtered = entries.filter(entry => !owned(entry));
  if (enabled) filtered.push({ type: 'command', command, interval_seconds: 2, timeout_seconds: 4 });
  if (filtered.length > 16) throw new Error('Herdr supports at most 16 tab-bar entries');
  if (JSON.stringify(entries) === JSON.stringify(filtered)) return text;
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const value = inlineValue(filtered);
  const ui = /^\[\s*(?:ui|"ui"|'ui')\s*\][ \t]*(?:#[^\r\n]*)?\r?$/m.exec(text);
  let result;
  if (ui) {
    const start = ui.index + ui[0].length;
    const nextTable = /^\s*\[/m.exec(text.slice(start));
    const end = nextTable ? start + nextTable.index : text.length;
    const key = /^[ \t]*(?:tab_bar_right|"tab_bar_right"|'tab_bar_right')[ \t]*=[ \t]*/m.exec(text.slice(start, end));
    if (key) {
      const valueStart = start + key.index + key[0].length;
      result = text.slice(0, valueStart) + value + ' ' + text.slice(valueEnd(text, valueStart));
    } else {
      if (config.ui?.tab_bar_right !== undefined) throw new Error('Use a direct tab_bar_right key under [ui] before enabling');
      result = text.slice(0, start) + `${newline}tab_bar_right = ${value}${newline}` + text.slice(start);
    }
  } else {
    if (config.ui !== undefined) throw new Error('Use a [ui] table before enabling; dotted/inline ui settings are not rewritten');
    result = `${text}${text.endsWith('\n') || !text ? '' : newline}[ui]${newline}tab_bar_right = ${value}${newline}`;
  }
  const check = parse(result);
  if (JSON.stringify(check.ui.tab_bar_right) !== JSON.stringify(filtered)) throw new Error('Could not safely update the tab-bar configuration');
  const expected = structuredClone(config);
  expected.ui ??= {};
  expected.ui.tab_bar_right = filtered;
  // Serialization ignores key ordering but catches an edit landing inside a multiline string.
  if (!sameValue(check, expected)) throw new Error('Configuration edit changed unrelated values');
  return result;
}

function sameValue(a, b) {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && sameValue(a[key], b[key]));
}
