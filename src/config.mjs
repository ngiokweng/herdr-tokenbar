/** Make narrowly scoped TOML edits while preserving unrelated settings and comments. */
import { parse, stringify } from 'smol-toml';
import { createTokenbarRows, LEGACY_PROGRESS_TOKENS, TOKENBAR_ROWS } from './presentation.mjs';

const AGENT_TABLE = ['ui', 'sidebar', 'agents'];
const DEFAULT_AGENT_ROWS = [['state_icon', 'machine', 'workspace', 'tab'], ['agent']];
const HEADER_TOKEN = '$tokenbar_header';
const COMPACT_AGENT_ROWS = [['state_icon', HEADER_TOKEN]];
const USAGE_TOKENS = new Set(['$tokenbar', ...LEGACY_PROGRESS_TOKENS, ...TOKENBAR_ROWS.flat().map(item => item.token)]);
const OWNED_TOKENS = new Set([HEADER_TOKEN, ...USAGE_TOKENS]);
const SPACING_MARKER = '# herdr-tokenbar spacing';

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

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pathValue(object, path) {
  return path.reduce((value, key) => value?.[key], object);
}

function tablePathPattern(path) {
  const header = path.map(part => {
    const escaped = escapeRegex(part);
    return `(?:${escaped}|"${escaped}"|'${escaped}')`;
  }).join('\\s*\\.\\s*');
  return header;
}

function tableBounds(text, path) {
  const header = tablePathPattern(path);
  const found = new RegExp(`^\\[\\s*${header}\\s*\\][ \\t]*(?:#[^\\r\\n]*)?\\r?$`, 'm').exec(text);
  if (!found) return null;
  const start = found.index + found[0].length;
  const next = /^[ \t]*\[/m.exec(text.slice(start));
  return { start, end: next ? start + next.index : text.length };
}

function setTableValue(text, path, key, value, comment = '') {
  const config = parse(text);
  const table = pathValue(config, path);
  const current = table?.[key];
  if (current !== undefined && Array.isArray(current) !== Array.isArray(value)) {
    throw new Error(`${[...path, key].join('.')} has an incompatible type`);
  }
  const bounds = tableBounds(text, path);
  const keyName = escapeRegex(key);
  const keyPattern = `(?:${keyName}|"${keyName}"|'${keyName}')`;
  if (bounds) {
    const section = text.slice(bounds.start, bounds.end);
    const assignment = new RegExp(`^[ \\t]*${keyPattern}[ \\t]*=[ \\t]*`, 'm').exec(section);
    if (assignment) {
      const valueStart = bounds.start + assignment.index + assignment[0].length;
      return text.slice(0, valueStart) + inlineValue(value) + ' ' + text.slice(valueEnd(text, valueStart));
    }
    if (current !== undefined) throw new Error(`Use a direct ${[...path, key].join('.')} key before enabling`);
    const newline = text.includes('\r\n') ? '\r\n' : '\n';
    const prefix = text.slice(0, bounds.end);
    return `${prefix}${prefix.endsWith(newline) ? '' : newline}${key} = ${inlineValue(value)}${comment ? ` ${comment}` : ''}${newline}${text.slice(bounds.end)}`;
  }
  if (current !== undefined) throw new Error(`Use a direct [${path.join('.')}] table before enabling`);
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const child = new RegExp(`^\\[\\s*${tablePathPattern(path)}\\s*\\.`, 'm').exec(text);
  const insertion = child ? child.index : text.length;
  const before = text.slice(0, insertion);
  const prefix = before.endsWith(newline) || !before ? before : `${before}${newline}`;
  return `${prefix}[${path.join('.')}]${newline}${key} = ${inlineValue(value)}${comment ? ` ${comment}` : ''}${newline}${text.slice(insertion)}`;
}

function removeRowTokens(rows, tokens) {
  return rows.flatMap(row => {
    const retained = row.filter(item => !tokens.has(typeof item === 'string' ? item : item?.token));
    return row.length && !retained.length ? [] : [retained];
  });
}

function tokenbarRows(rows, enabled, tokenRows) {
  if (!Array.isArray(rows) || rows.some(row => !Array.isArray(row))) {
    throw new Error('ui.sidebar.agents rows must be an array of arrays');
  }
  // Migrate only the known native layout. Custom identity rows and styles stay intact.
  let next = removeRowTokens(rows, USAGE_TOKENS);
  if (enabled && sameValue(next, DEFAULT_AGENT_ROWS)) {
    next = structuredClone(COMPACT_AGENT_ROWS);
  } else if (!enabled) {
    next = next.flatMap(row => {
      const names = row.map(item => typeof item === 'string' ? item : item?.token);
      const hasIcon = sameValue(names, ['state_icon', HEADER_TOKEN]);
      if (hasIcon || sameValue(names, [HEADER_TOKEN])) {
        // Restore native identity even after styling the header or adding custom rows.
        return [[...(hasIcon ? [row[0]] : []), ...DEFAULT_AGENT_ROWS[0].slice(1)], [...DEFAULT_AGENT_ROWS[1]]];
      }
      return removeRowTokens([row], OWNED_TOKENS);
    });
  }
  if (enabled) next.push(...tokenRows);
  if (next.length > 16) throw new Error('Herdr supports at most 16 agent rows; leave room for the 4 TokenBar rows');
  return next;
}

function ownedSpacing(text) {
  const bounds = tableBounds(text, AGENT_TABLE);
  if (!bounds) return null;
  const section = text.slice(bounds.start, bounds.end);
  const line = new RegExp(`^[ \\t]*row_gap[ \\t]*=[ \\t]*[01][ \\t]*${escapeRegex(SPACING_MARKER)}[ \\t]*\\r?\\n?`, 'm').exec(section);
  return line ? { start: bounds.start + line.index, end: bounds.start + line.index + line[0].length } : null;
}

function editAgentRows(text, config, enabled, tokenRows) {
  const agentSettings = pathValue(config, AGENT_TABLE);
  let result = text;
  if (enabled && (agentSettings?.row_gap === undefined || (agentSettings.row_gap === 1 && ownedSpacing(text)))) {
    result = setTableValue(result, AGENT_TABLE, 'row_gap', 0, SPACING_MARKER);
  } else if (!enabled && [0, 1].includes(agentSettings?.row_gap)) {
    const spacing = ownedSpacing(result);
    if (spacing) result = result.slice(0, spacing.start) + result.slice(spacing.end);
  }
  const currentRows = agentSettings?.rows;
  if (enabled || currentRows !== undefined) {
    const nextRows = tokenbarRows(currentRows ?? DEFAULT_AGENT_ROWS, enabled, tokenRows);
    if (JSON.stringify(currentRows) !== JSON.stringify(nextRows)) {
      result = setTableValue(result, AGENT_TABLE, 'rows', nextRows);
    }
  }

  const overrides = agentSettings?.rows_by_agent;
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return result;
  const overridesTable = [...AGENT_TABLE, 'rows_by_agent'];
  if (!tableBounds(result, overridesTable)) {
    const nextOverrides = Object.fromEntries(Object.entries(overrides).map(([agent, rows]) => [
      agent, tokenbarRows(rows, enabled, tokenRows),
    ]));
    if (!sameValue(overrides, nextOverrides)) {
      result = setTableValue(result, AGENT_TABLE, 'rows_by_agent', nextOverrides);
    }
    return result;
  }
  for (const [agent, rows] of Object.entries(overrides)) {
    const nextRows = tokenbarRows(rows, enabled, tokenRows);
    if (JSON.stringify(rows) !== JSON.stringify(nextRows)) {
      result = setTableValue(result, overridesTable, agent, nextRows);
    }
  }
  return result;
}

/**
 * Add/remove this plugin's tab-bar entry, usage rows and default spacing while retaining custom settings.
 * @param {string} text Original config.toml contents.
 * @param {string} command Fully quoted status command.
 * @param {boolean} enabled Whether the plugin entry should be present.
 * @param {object} [options] Optional separatorColors palette (1-8 hex colors).
 * @returns {string} Validated configuration, unchanged when already configured.
 */
export function editStatusConfig(text, command, enabled, { separatorColors } = {}) {
  const tokenRows = enabled ? createTokenbarRows(separatorColors) : TOKENBAR_ROWS;
  const config = parse(text);
  const entries = config.ui?.tab_bar_right ?? [];
  if (!Array.isArray(entries)) throw new Error('ui.tab_bar_right must be an array');
  const owned = entry => entry.type === 'command'
    && entry.command?.includes('--herdr-tokenbar');
  const filtered = entries.filter(entry => !owned(entry));
  if (enabled) filtered.push({ type: 'command', command, interval_seconds: 2, timeout_seconds: 4 });
  if (filtered.length > 16) throw new Error('Herdr supports at most 16 tab-bar entries');
  let result = text;
  if (JSON.stringify(entries) !== JSON.stringify(filtered)) {
    const newline = text.includes('\r\n') ? '\r\n' : '\n';
    const value = inlineValue(filtered);
    const ui = /^\[\s*(?:ui|"ui"|'ui')\s*\][ \t]*(?:#[^\r\n]*)?\r?$/m.exec(text);
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
  }
  result = editAgentRows(result, config, enabled, tokenRows);
  if (result === text) return text;
  const check = parse(result);
  if (!sameValue(check.ui?.tab_bar_right ?? [], filtered)) throw new Error('Could not safely update the tab-bar configuration');
  const expected = structuredClone(config);
  expected.ui ??= {};
  if (config.ui?.tab_bar_right !== undefined || filtered.length) expected.ui.tab_bar_right = filtered;
  const agentSettings = pathValue(config, AGENT_TABLE);
  if (enabled && (agentSettings?.row_gap === undefined || (agentSettings.row_gap === 1 && ownedSpacing(text)))) {
    expected.ui.sidebar ??= {};
    expected.ui.sidebar.agents ??= {};
    expected.ui.sidebar.agents.row_gap = 0;
  } else if (!enabled && [0, 1].includes(agentSettings?.row_gap) && ownedSpacing(text)) {
    delete expected.ui.sidebar.agents.row_gap;
  }
  const rows = agentSettings?.rows;
  if (enabled || rows !== undefined) {
    expected.ui.sidebar ??= {};
    expected.ui.sidebar.agents ??= {};
    expected.ui.sidebar.agents.rows = tokenbarRows(rows ?? DEFAULT_AGENT_ROWS, enabled, tokenRows);
  }
  const overrides = agentSettings?.rows_by_agent;
  if (overrides && typeof overrides === 'object' && !Array.isArray(overrides)) {
    expected.ui.sidebar ??= {};
    expected.ui.sidebar.agents ??= {};
    expected.ui.sidebar.agents.rows_by_agent = Object.fromEntries(Object.entries(overrides).map(([agent, rows]) => [
      agent, tokenbarRows(rows, enabled, tokenRows),
    ]));
  }
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
