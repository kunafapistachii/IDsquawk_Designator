import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Squawk codes excluded from the assignable pool as a safety net, even
// though the current squawk_db.json data is already validated clean.
export const RESERVED_CODES = new Set(['7500', '7600', '7700', '7000', '2000', '1200', '0000']);

export function loadDb(path = join(__dirname, 'squawk_db.json')) {
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw);
}

// Expands an octal min/max squawk range (inclusive) into zero-padded 4-digit
// octal code strings. Must walk base-8 values, not decimal integers, or
// digits 8/9 leak into "valid" squawks (e.g. 4558/4559 are not octal).
export function expandOctalRange(minSquawk, maxSquawk) {
  const min = parseInt(minSquawk, 8);
  const max = parseInt(maxSquawk, 8);
  if (Number.isNaN(min) || Number.isNaN(max)) {
    throw new Error(`Invalid octal range: ${minSquawk}-${maxSquawk}`);
  }
  const codes = [];
  for (let v = min; v <= max; v++) {
    codes.push(v.toString(8).padStart(4, '0'));
  }
  return codes;
}

// Whazzup transponder values arrive as integers with leading zeros stripped
// (e.g. 234 for squawk 0234). Always zero-pad before comparing to DB codes.
export function normalizeSquawk(value) {
  return String(value).trim().padStart(4, '0');
}

export function normalizeFlightRules(code) {
  switch (code) {
    case 'I': return 'IFR';
    case 'V': return 'VFR';
    // Y/Z (mixed) default per handoff doc; should be confirmed with the
    // user in practice, but this keeps the assign flow from breaking.
    case 'Y': return 'IFR';
    case 'Z': return 'VFR';
    default: return code; // already normalized (IFR/VFR) or unknown
  }
}

function tokenMatches(icao, tokens) {
  if (!icao) return false;
  return tokens.some((token) => icao.startsWith(token));
}

export function isApplicable(rule, { originICAO, destICAO, flightRules, center, military = 0 }) {
  if (rule.center !== center) return false;
  if (rule.flightRules !== flightRules) return false;
  if ((rule.military ?? 0) !== military) return false;
  return tokenMatches(originICAO, rule.origins) && tokenMatches(destICAO, rule.destinations);
}

// Returns applicable rules sorted ascending by `order` (priority + spillover sequence).
export function getApplicableRules(rules, query) {
  return rules
    .filter((rule) => isApplicable(rule, query))
    .sort((a, b) => a.order - b.order);
}

// Core assignment algorithm: walk applicable rules in order, expand each
// range, subtract used codes, take the smallest survivor. Spills over to
// the next rule when a range is fully consumed.
export function assignFromRules(applicableRules, usedCodes) {
  for (const rule of applicableRules) {
    const candidates = expandOctalRange(rule.minSquawk, rule.maxSquawk);
    const available = candidates.filter(
      (code) => !usedCodes.has(code) && !RESERVED_CODES.has(code)
    );
    if (available.length > 0) {
      available.sort();
      return {
        code: available[0],
        ruleOrder: rule.order,
        spilledOver: rule !== applicableRules[0],
      };
    }
  }
  return { error: 'no code available' };
}

export function assignSquawk(rules, query, usedCodes) {
  const applicable = getApplicableRules(rules, query);
  if (applicable.length === 0) {
    return { error: 'no applicable rule' };
  }
  return assignFromRules(applicable, usedCodes);
}
