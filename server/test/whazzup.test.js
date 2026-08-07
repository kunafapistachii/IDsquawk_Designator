import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WhazzupClient } from '../whazzup.js';

// Real whazzup v2 nests the pilot array under clients.pilots.
function wrapPilots(pilots) {
  return { clients: { pilots } };
}

function mockFetch(payload, ok = true) {
  return async () => ({
    ok,
    status: ok ? 200 : 500,
    json: async () => payload,
  });
}

test('whazzup: filters pilots to WA*/WI* departures only', async () => {
  const client = new WhazzupClient({
    fetchImpl: mockFetch(
      wrapPilots([
        { callsign: 'GIA123', flightPlan: { departureId: 'WADD', arrivalId: 'WARR', flightRules: 'I' }, lastTrack: { transponder: 234 } },
        { callsign: 'SIA456', flightPlan: { departureId: 'WSSS', arrivalId: 'WADD', flightRules: 'I' }, lastTrack: { transponder: 1000 } },
        { callsign: 'BTK789', flightPlan: { departureId: 'WIII', arrivalId: 'WADD', flightRules: 'V' }, lastTrack: { transponder: 4601 } },
      ])
    ),
  });
  const pilots = await client.getIndonesiaPilots();
  assert.equal(pilots.length, 2);
  assert.deepEqual(pilots.map((p) => p.callsign).sort(), ['BTK789', 'GIA123']);
});

test('whazzup: getConfirmedSquawk returns the real transponder value for a callsign, null if unseen', async () => {
  const client = new WhazzupClient({
    fetchImpl: mockFetch(
      wrapPilots([
        { callsign: 'GIA123', flightPlan: { departureId: 'WADD' }, lastTrack: { transponder: 234 } },
      ])
    ),
  });
  assert.equal(await client.getConfirmedSquawk('GIA123'), '0234');
  assert.equal(await client.getConfirmedSquawk('UNKNOWN99'), null);
});

test('whazzup: getUsedCodes zero-pads and unions WA/WI traffic (cross-FIR)', async () => {
  const client = new WhazzupClient({
    fetchImpl: mockFetch(
      wrapPilots([
        { callsign: 'A1', flightPlan: { departureId: 'WADD' }, lastTrack: { transponder: 234 } },
        { callsign: 'A2', flightPlan: { departureId: 'WIII' }, lastTrack: { transponder: 4601 } },
      ])
    ),
  });
  const used = await client.getUsedCodes();
  assert.ok(used.has('0234'));
  assert.ok(used.has('4601'));
  assert.equal(used.size, 2);
});

test('whazzup: caches within TTL window (single fetch for two calls)', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { ok: true, status: 200, json: async () => wrapPilots([]) };
  };
  const client = new WhazzupClient({ fetchImpl, cacheTtlMs: 20_000 });
  await client.getData();
  await client.getData();
  assert.equal(calls, 1);
});

test('whazzup: degrades gracefully when fetch fails and no cache exists', async () => {
  const client = new WhazzupClient({ fetchImpl: async () => { throw new Error('network down'); } });
  const pilots = await client.getIndonesiaPilots();
  assert.deepEqual(pilots, []);
});

test('whazzup: falls back to stale cache on fetch failure', async () => {
  let shouldFail = false;
  const fetchImpl = async () => {
    if (shouldFail) throw new Error('down');
    return {
      ok: true,
      status: 200,
      json: async () => wrapPilots([{ callsign: 'X', flightPlan: { departureId: 'WADD' }, lastTrack: { transponder: 1 } }]),
    };
  };
  const client = new WhazzupClient({ fetchImpl, cacheTtlMs: -1 }); // always stale, forces refetch
  await client.getData();
  shouldFail = true;
  const data = await client.getData();
  assert.equal(data.clients.pilots.length, 1);
});

test('whazzup: real captured IVAO whazzup v2 shape parses correctly (regression for clients.pilots nesting)', async () => {
  // Minimal slice of an actual live response, structurally identical to
  // what api.ivao.aero/v2/tracker/whazzup returns (verified 2026-08-01).
  const realShapeSample = {
    updatedAt: '2026-08-01T20:34:54.751695036Z',
    servers: [],
    voiceServers: [],
    connections: {},
    clients: {
      pilots: [
        {
          id: 1,
          callsign: 'IPV33',
          flightPlan: { departureId: 'WADD', arrivalId: 'KLAX', flightRules: 'I' },
          lastTrack: { transponder: 2000 },
        },
        {
          id: 2,
          callsign: 'GIA878',
          flightPlan: { departureId: 'WIII', arrivalId: 'RKSI', flightRules: 'I' },
          lastTrack: { transponder: 7101 },
        },
      ],
      atcs: [],
      followMe: [],
      observers: [],
    },
  };
  const client = new WhazzupClient({ fetchImpl: mockFetch(realShapeSample) });
  const pilots = await client.getIndonesiaPilots();
  assert.equal(pilots.length, 2);
  assert.deepEqual(pilots.map((p) => p.callsign).sort(), ['GIA878', 'IPV33']);
});
