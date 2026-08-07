import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';

import { AuroraClient } from './aurora.js';
import { WhazzupClient } from './whazzup.js';
import { PendingSet } from './pending.js';
import { loadDb, assignSquawk, normalizeSquawk, normalizeFlightRules } from './matcher.js';

const PORT = process.env.SERVER_PORT || 4000;
const AURORA_PORT = Number(process.env.AURORA_PORT) || 1130;
const LOG_AURORA_RAW = process.env.LOG_AURORA_RAW === '1';

const db = loadDb();
const aurora = new AuroraClient({ port: AURORA_PORT, logRaw: LOG_AURORA_RAW });
const whazzup = new WhazzupClient();
const pending = new PendingSet();

// Aurora's #LBSQK label is a flash-only notification, not a persistent
// field (confirmed live 2026-08-02, incl. resending every 1.5s — still
// didn't stick). Manual entry in Aurora's own UI persists; #LBSQK doesn't.
// No documented command makes it persistent, so we send it best-effort and
// rely on the web UI as the actual source of truth for the controller.

aurora.connect();
aurora.on('error', (err) => console.error('[aurora] error:', err.message || err.code || err));
aurora.on('connected', () => console.log('[aurora] connected'));
aurora.on('disconnected', () => console.warn('[aurora] disconnected, will retry'));

// Maps a departure ICAO to its controlling FIR/center. Indonesia's two
// centers line up directly with the departure prefix: WA* -> WAAF
// (Ujung Pandang), WI* -> WIIF (Jakarta).
function centerForDeparture(departureICAO) {
  if (!departureICAO) return null;
  if (departureICAO.startsWith('WA')) return 'WAAF';
  if (departureICAO.startsWith('WI')) return 'WIIF';
  return null;
}

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/status', async (req, res) => {
  let controlledAirports = [];
  if (aurora.connected) {
    try {
      controlledAirports = await aurora.getControlledAirports();
    } catch {
      // leave empty; traffic list will still reflect actual filtering
    }
  }
  res.json({
    aurora: { connected: aurora.connected, host: aurora.host, port: aurora.port },
    whazzup: { cacheAgeMs: whazzup.cacheAgeMs() },
    pending: { active: pending.activeCodes().size },
    controlledAirports,
  });
});

// Flight plan data (departure/arrival/rules) rarely changes once filed, so
// we cache it per callsign instead of re-querying #FP on every poll tick.
// Repeatedly hammering #FP for aircraft we already know about was found to
// interfere with Aurora's own squawk-label display: right after a real
// #LBSQK assign, the very next #FP poll for that callsign appears to reset
// the strip's assigned-squawk label back to blank in Aurora's UI (confirmed
// via raw log against a live Aurora instance, 2026-08-02).
const flightPlanCache = new Map(); // callsign -> { departure, arrival, flightRules }

// Pulls the current radar snapshot from Aurora (#TR for the traffic list,
// #CTRL for the controller's actual controlled airports, #FP only for
// callsigns not yet cached), but deliberately sources currentSquawk from
// whazzup, not Aurora's #TRSQK. Aurora can echo back a just-assigned label
// before the pilot has actually dialed it in, which would make the UI lie
// about what the aircraft is really squawking. Whazzup reflects the real
// transponder value, so "Current SQK" only changes once it's true.
// Single-flight guard: the 2s poll tick and a direct /api/traffic call can
// overlap, each issuing its own concurrent #FP for the same new callsign.
// Two in-flight #FP for the same callsign racing on one connection can
// leave one stuck until timeout, silently dropping that aircraft (its
// catch-branch result has no `departure`, so the controlled-airport filter
// drops it).
let trafficInFlight = null;
async function fetchIndonesiaTraffic() {
  if (trafficInFlight) return trafficInFlight;
  trafficInFlight = fetchIndonesiaTrafficImpl();
  try {
    return await trafficInFlight;
  } finally {
    trafficInFlight = null;
  }
}

async function fetchIndonesiaTrafficImpl() {
  const [callsigns, whazzupPilots, controlledAirports] = await Promise.all([
    aurora.getTraffic(),
    whazzup.getIndonesiaPilots(),
    aurora.getControlledAirports(),
  ]);
  const confirmedSquawkByCallsign = new Map(whazzupPilots.map((p) => [p.callsign, p.squawk]));
  const controlledSet = new Set(controlledAirports);

  // Drop cache entries for aircraft no longer on radar so it doesn't grow
  // unbounded and so a callsign reused later gets a fresh flight plan.
  const onRadar = new Set(callsigns);
  for (const cs of flightPlanCache.keys()) {
    if (!onRadar.has(cs)) flightPlanCache.delete(cs);
  }

  const results = await Promise.all(
    callsigns.map(async (callsign) => {
      try {
        let fp = flightPlanCache.get(callsign);
        if (!fp) {
          const raw = await aurora.getFlightPlan(callsign);
          fp = {
            departure: raw.departure,
            arrival: raw.arrival,
            flightRules: normalizeFlightRules(raw.flightRules ?? ''),
          };
          flightPlanCache.set(callsign, fp);
        }
        return {
          callsign,
          departure: fp.departure,
          arrival: fp.arrival,
          flightRules: fp.flightRules,
          currentSquawk: confirmedSquawkByCallsign.get(callsign) ?? null,
          controlled: controlledSet.has(fp.departure),
        };
      } catch (err) {
        return { callsign, error: err.message };
      }
    })
  );
  return results
    .filter((r) => r.controlled)
    .map(({ controlled, ...rest }) => rest);
}

app.get('/api/traffic', async (req, res) => {
  if (!aurora.connected) {
    return res.status(503).json({ error: 'Aurora not connected' });
  }
  try {
    const traffic = await fetchIndonesiaTraffic();
    res.json(traffic);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/assign', async (req, res) => {
  const { callsign } = req.body ?? {};
  if (!callsign) {
    return res.status(400).json({ error: 'callsign is required' });
  }
  if (!aurora.connected) {
    return res.status(503).json({ error: 'Aurora not connected' });
  }

  try {
    const [fp, controlledAirports] = await Promise.all([
      aurora.getFlightPlan(callsign),
      aurora.getControlledAirports(),
    ]);
    if (!controlledAirports.includes(fp.departure)) {
      return res.status(422).json({ error: `Departure ${fp.departure} is not one of your controlled airports` });
    }
    const center = centerForDeparture(fp.departure);
    if (!center) {
      return res.status(422).json({ error: `Departure ${fp.departure} is not in scope (WA*/WI*)` });
    }
    if (!fp.flightRules) {
      return res.status(422).json({ error: 'Could not determine flight rules from flight plan' });
    }
    const flightRules = normalizeFlightRules(fp.flightRules);
    // Warm the traffic poller's cache with this fetch so the very next poll
    // tick doesn't issue its own #FP for this callsign right after we set
    // its squawk (see flightPlanCache comment above).
    flightPlanCache.set(callsign, { departure: fp.departure, arrival: fp.arrival, flightRules });

    const usedFromWhazzup = await whazzup.getUsedCodes();
    const usedCodes = new Set([...usedFromWhazzup, ...pending.activeCodes()]);

    const result = assignSquawk(
      db.rules,
      {
        originICAO: fp.departure,
        destICAO: fp.arrival,
        flightRules,
        center,
      },
      usedCodes
    );

    if (result.error) {
      return res.status(409).json({ error: result.error });
    }

    // #LBSQK flashes a label in Aurora (best-effort, doesn't persist — see
    // note above). Pilot dials in the real squawk themselves; the web UI's
    // "Tell pilot to squawk" column is the actual source of truth.
    await aurora.setSquawk(callsign, result.code);
    pending.add(result.code);

    res.json({
      callsign,
      assignedSquawk: result.code,
      ruleOrder: result.ruleOrder,
      spilledOver: result.spilledOver,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

function broadcast(payload) {
  const message = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(message);
  }
}

// Periodically push traffic + status so the UI stays live without manual
// refresh. This hits local Aurora (not the throttled whazzup API), so it's
// safe to run fast — departing traffic needs its squawk fast.
const POLL_INTERVAL_MS = 2_000;
setInterval(async () => {
  if (!aurora.connected || wss.clients.size === 0) return;
  try {
    const filtered = await fetchIndonesiaTraffic();
    broadcast({ type: 'traffic', data: filtered });

    // Reconcile pending-set against live squawks so it doesn't grow stale.
    const liveCodes = new Set(filtered.map((r) => r.currentSquawk).filter(Boolean).map((c) => normalizeSquawk(c)));
    pending.reconcile(liveCodes);
  } catch (err) {
    console.error('[poll] failed:', err.message);
  }
}, POLL_INTERVAL_MS);

httpServer.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});
