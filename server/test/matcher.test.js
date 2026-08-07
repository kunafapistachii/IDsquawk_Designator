import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  expandOctalRange,
  normalizeSquawk,
  normalizeFlightRules,
  isApplicable,
  getApplicableRules,
  assignSquawk,
  loadDb,
  RESERVED_CODES,
} from '../matcher.js';

// --- 1. Octal expand ---
test('octal expand: 4550-4567 yields exactly 16 codes, no 4558/4559', () => {
  const codes = expandOctalRange('4550', '4567');
  assert.equal(codes.length, 16);
  assert.ok(!codes.includes('4558'));
  assert.ok(!codes.includes('4559'));
  assert.equal(codes[0], '4550');
  assert.equal(codes.at(-1), '4567');
});

// --- 2. Zero-pad ---
test('zero-pad: transponder 234 normalizes to 0234', () => {
  assert.equal(normalizeSquawk(234), '0234');
  assert.equal(normalizeSquawk('234'), '0234');
});

// --- 3. Dedup ---
test('dedup: used code within selected range is excluded from assignment', () => {
  const rules = [
    { center: 'WAAF', origins: ['WADD'], destinations: ['WADD'], order: 1, flightRules: 'VFR', military: 0, minSquawk: '4601', maxSquawk: '4602' },
  ];
  const used = new Set(['0234']);
  const query = { originICAO: 'WADD', destICAO: 'WADD', flightRules: 'VFR', center: 'WAAF' };
  const result = assignSquawk(rules, query, used);
  // 4601 should still be returned since 0234 isn't in range; now block 4601 itself
  const used2 = new Set(['4601']);
  const result2 = assignSquawk(rules, query, used2);
  assert.equal(result.code, '4601');
  assert.equal(result2.code, '4602');
});

// --- 4. Ascending ---
test('ascending: smallest available code returned from pool', () => {
  const rules = [
    { center: 'WAAF', origins: ['WADD'], destinations: ['WADD'], order: 1, flightRules: 'VFR', military: 0, minSquawk: '4601', maxSquawk: '4607' },
  ];
  const used = new Set(['4601', '4602', '4603']);
  const query = { originICAO: 'WADD', destICAO: 'WADD', flightRules: 'VFR', center: 'WAAF' };
  const result = assignSquawk(rules, query, used);
  assert.equal(result.code, '4604');
});

// --- 5. Spillover ---
test('spillover: moves to next applicable rule by order when primary range exhausted', () => {
  const rules = [
    { center: 'WAAF', origins: ['WADD'], destinations: ['WADD'], order: 1, flightRules: 'VFR', military: 0, minSquawk: '4601', maxSquawk: '4602' },
    { center: 'WAAF', origins: ['WADD'], destinations: ['WADD'], order: 2, flightRules: 'VFR', military: 0, minSquawk: '4700', maxSquawk: '4701' },
  ];
  const used = new Set(['4601', '4602']); // exhaust order-1 range
  const query = { originICAO: 'WADD', destICAO: 'WADD', flightRules: 'VFR', center: 'WAAF' };
  const result = assignSquawk(rules, query, used);
  assert.equal(result.code, '4700');
  assert.equal(result.ruleOrder, 2);
  assert.equal(result.spilledOver, true);
});

test('no spillover flag when primary rule serves the code', () => {
  const rules = [
    { center: 'WAAF', origins: ['WADD'], destinations: ['WADD'], order: 1, flightRules: 'VFR', military: 0, minSquawk: '4601', maxSquawk: '4602' },
  ];
  const query = { originICAO: 'WADD', destICAO: 'WADD', flightRules: 'VFR', center: 'WAAF' };
  const result = assignSquawk(rules, query, new Set());
  assert.equal(result.spilledOver, false);
});

test('no code available error when all applicable rules are exhausted', () => {
  const rules = [
    { center: 'WAAF', origins: ['WADD'], destinations: ['WADD'], order: 1, flightRules: 'VFR', military: 0, minSquawk: '4601', maxSquawk: '4601' },
  ];
  const query = { originICAO: 'WADD', destICAO: 'WADD', flightRules: 'VFR', center: 'WAAF' };
  const result = assignSquawk(rules, query, new Set(['4601']));
  assert.equal(result.error, 'no code available');
});

// --- 6. Cross-FIR dedup ---
test('cross-FIR: WI* traffic reduces pool for WAAF assignment on overlapping codes', () => {
  const rules = [
    { center: 'WAAF', origins: ['WADD'], destinations: ['WADD'], order: 1, flightRules: 'VFR', military: 0, minSquawk: '4601', maxSquawk: '4602' },
  ];
  // Simulate used-codes gathered from BOTH WA* and WI* departures (as whazzup.js does)
  const usedFromWI = new Set(['4601']); // e.g. a WIII departure happens to hold an overlapping code
  const query = { originICAO: 'WADD', destICAO: 'WADD', flightRules: 'VFR', center: 'WAAF' };
  const result = assignSquawk(rules, query, usedFromWI);
  assert.equal(result.code, '4602');
});

// --- 7. Pending-set (simulated at the assignSquawk call-site level) ---
test('pending-set: sequential assigns for different aircraft do not collide before whazzup updates', () => {
  const rules = [
    { center: 'WAAF', origins: ['WADD'], destinations: ['WADD'], order: 1, flightRules: 'VFR', military: 0, minSquawk: '4601', maxSquawk: '4602' },
  ];
  const query = { originICAO: 'WADD', destICAO: 'WADD', flightRules: 'VFR', center: 'WAAF' };
  const used = new Set(); // whazzup hasn't updated yet
  const first = assignSquawk(rules, query, used);
  used.add(first.code); // caller adds to pending-set immediately
  const second = assignSquawk(rules, query, used);
  assert.notEqual(first.code, second.code);
});

// --- 8. Prefix match ---
test('prefix match: WADD origin matches WAD-token rule, order decides winner', () => {
  const rules = [
    { center: 'WAAF', origins: ['WAD'], destinations: ['WA', 'WI', 'WR'], order: 5, flightRules: 'IFR', military: 0, minSquawk: '4401', maxSquawk: '4402' },
    { center: 'WAAF', origins: ['WA'], destinations: ['WA', 'WI', 'WR'], order: 31, flightRules: 'IFR', military: 0, minSquawk: '4600', maxSquawk: '4601' },
  ];
  const query = { originICAO: 'WADD', destICAO: 'WIII', flightRules: 'IFR', center: 'WAAF' };
  const applicable = getApplicableRules(rules, query);
  assert.equal(applicable.length, 2);
  assert.equal(applicable[0].order, 5); // lower order wins priority
  const result = assignSquawk(rules, query, new Set());
  assert.equal(result.ruleOrder, 5);
  assert.equal(result.code, '4401');
});

// --- flight rules normalization ---
test('flight rules normalization: I->IFR, V->VFR, Y->IFR, Z->VFR', () => {
  assert.equal(normalizeFlightRules('I'), 'IFR');
  assert.equal(normalizeFlightRules('V'), 'VFR');
  assert.equal(normalizeFlightRules('Y'), 'IFR');
  assert.equal(normalizeFlightRules('Z'), 'VFR');
});

// --- reserved code guard ---
test('reserved codes are excluded from assignable pool', () => {
  assert.ok(RESERVED_CODES.has('7700'));
  const rules = [
    { center: 'WAAF', origins: ['WADD'], destinations: ['WADD'], order: 1, flightRules: 'VFR', military: 0, minSquawk: '7700', maxSquawk: '7700' },
  ];
  const query = { originICAO: 'WADD', destICAO: 'WADD', flightRules: 'VFR', center: 'WAAF' };
  const result = assignSquawk(rules, query, new Set());
  assert.equal(result.error, 'no code available');
});

// --- real DB smoke test ---
test('real squawk_db.json loads and has 92 rules with valid octal ranges', () => {
  const db = loadDb();
  assert.equal(db.rules.length, 92);
  for (const rule of db.rules) {
    const codes = expandOctalRange(rule.minSquawk, rule.maxSquawk);
    assert.ok(codes.length > 0, `rule order ${rule.order} produced no codes`);
  }
});
