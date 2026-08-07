import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PendingSet } from '../pending.js';

test('pending-set: add + has works within TTL', () => {
  const pending = new PendingSet({ ttlMs: 60_000 });
  pending.add('4601');
  assert.ok(pending.has('4601'));
  assert.ok(!pending.has('4602'));
});

test('pending-set: expires after TTL', () => {
  const pending = new PendingSet({ ttlMs: -1 }); // already expired
  pending.add('4601');
  assert.ok(!pending.has('4601'));
});

test('pending-set: confirm removes entry once seen live in whazzup', () => {
  const pending = new PendingSet({ ttlMs: 60_000 });
  pending.add('4601');
  pending.confirm('4601');
  assert.ok(!pending.has('4601'));
});

test('pending-set: reconcile clears codes now visible live', () => {
  const pending = new PendingSet({ ttlMs: 60_000 });
  pending.add('4601');
  pending.add('4602');
  pending.reconcile(new Set(['4601']));
  assert.ok(!pending.has('4601'));
  assert.ok(pending.has('4602'));
});

test('pending-set: activeCodes returns all non-expired codes', () => {
  const pending = new PendingSet({ ttlMs: 60_000 });
  pending.add('4601');
  pending.add('4602');
  const codes = pending.activeCodes();
  assert.equal(codes.size, 2);
});
