import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

function stripInlineComment(value) {
  let quote = null;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if ((char === '"' || char === "'") && value[index - 1] !== '\\') {
      quote = quote === char ? null : quote || char;
      continue;
    }

    if (char === '#' && !quote && /\s/.test(value[index - 1] || '')) {
      return value.slice(0, index).trimEnd();
    }
  }

  return value;
}

function unquote(value) {
  const trimmed = stripInlineComment(value.trim());
  if (trimmed.length < 2) return trimmed;

  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];

  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

export function parseDotEnv(text) {
  const values = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const normalized = line.startsWith('export ') ? line.slice(7).trimStart() : line;
    const separator = normalized.indexOf('=');
    if (separator <= 0) continue;

    const key = normalized.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    values[key] = unquote(normalized.slice(separator + 1));
  }

  return values;
}

export function loadDotEnv(filePath = path.resolve(process.cwd(), '.env')) {
  if (!existsSync(filePath)) return {};

  const parsed = parseDotEnv(readFileSync(filePath, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  return parsed;
}
