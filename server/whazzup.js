import { normalizeSquawk, normalizeFlightRules } from './matcher.js';

const WHAZZUP_URL = 'https://api.ivao.aero/v2/tracker/whazzup';
const CACHE_TTL_MS = 20_000; // keep within the 15-30s recommended fetch floor

const INDONESIA_PREFIXES = ['WA', 'WI'];

function isIndonesiaDeparture(departureId) {
  if (!departureId) return false;
  return INDONESIA_PREFIXES.some((p) => departureId.startsWith(p));
}

export class WhazzupClient {
  constructor({ fetchImpl = fetch, url = WHAZZUP_URL, cacheTtlMs = CACHE_TTL_MS } = {}) {
    this.fetchImpl = fetchImpl;
    this.url = url;
    this.cacheTtlMs = cacheTtlMs;
    this.cache = null; // { data, fetchedAt }
    this.inflight = null;
  }

  cacheAgeMs() {
    if (!this.cache) return null;
    return Date.now() - this.cache.fetchedAt;
  }

  async getData() {
    if (this.cache && this.cacheAgeMs() < this.cacheTtlMs) {
      return this.cache.data;
    }
    if (this.inflight) {
      return this.inflight;
    }
    this.inflight = this._fetch();
    try {
      return await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  async _fetch() {
    try {
      const res = await this.fetchImpl(this.url);
      if (!res.ok) {
        throw new Error(`whazzup HTTP ${res.status}`);
      }
      const data = await res.json();
      this.cache = { data, fetchedAt: Date.now() };
      return data;
    } catch (err) {
      // Defensive: whazzup can be down. Fall back to stale cache if we have
      // one, otherwise surface an empty pilot list so callers degrade
      // gracefully instead of crashing.
      if (this.cache) {
        return this.cache.data;
      }
      return { pilots: [], _fetchError: String(err?.message ?? err) };
    }
  }

  async getIndonesiaPilots() {
    const data = await this.getData();
    // Real whazzup v2 responses nest pilots under clients.pilots, not a
    // top-level `pilots` key.
    const pilots = data?.clients?.pilots ?? [];
    return pilots
      .filter((p) => isIndonesiaDeparture(p?.flightPlan?.departureId))
      .map((p) => ({
        callsign: p.callsign,
        departureId: p.flightPlan?.departureId ?? null,
        arrivalId: p.flightPlan?.arrivalId ?? null,
        flightRules: normalizeFlightRules(p.flightPlan?.flightRules ?? ''),
        squawk: p.lastTrack?.transponder != null ? normalizeSquawk(p.lastTrack.transponder) : null,
      }));
  }

  // Used-codes must be the union of WA* and WI* traffic (cross-FIR dedup),
  // since squawk ranges overlap between WAAF and WIIF.
  async getUsedCodes() {
    const pilots = await this.getIndonesiaPilots();
    const codes = new Set();
    for (const p of pilots) {
      if (p.squawk) codes.add(p.squawk);
    }
    return codes;
  }

  // The "real" current squawk for a callsign, as confirmed by the pilot's
  // own transponder over the network. Deliberately does NOT read Aurora's
  // #TRSQK, which can echo back a just-assigned label before the pilot has
  // actually dialed it in.
  async getConfirmedSquawk(callsign) {
    const pilots = await this.getIndonesiaPilots();
    const pilot = pilots.find((p) => p.callsign === callsign);
    return pilot?.squawk ?? null;
  }
}
