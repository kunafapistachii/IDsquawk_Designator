const DEFAULT_TTL_MS = 60_000;

// Tracks squawk codes we've just assigned but that may not yet be visible
// in whazzup (pilot hasn't dialed it in yet). Entries expire either by TTL
// or explicitly once the code is observed live in whazzup.
export class PendingSet {
  constructor({ ttlMs = DEFAULT_TTL_MS } = {}) {
    this.ttlMs = ttlMs;
    this.entries = new Map(); // code -> expiresAt
  }

  add(code) {
    this.entries.set(code, Date.now() + this.ttlMs);
  }

  has(code) {
    const expiresAt = this.entries.get(code);
    if (expiresAt == null) return false;
    if (Date.now() > expiresAt) {
      this.entries.delete(code);
      return false;
    }
    return true;
  }

  // Call once a code is confirmed live in whazzup, so it doesn't linger.
  confirm(code) {
    this.entries.delete(code);
  }

  reconcile(liveCodes) {
    for (const code of liveCodes) {
      this.entries.delete(code);
    }
  }

  activeCodes() {
    const now = Date.now();
    const codes = new Set();
    for (const [code, expiresAt] of this.entries) {
      if (expiresAt >= now) codes.add(code);
      else this.entries.delete(code);
    }
    return codes;
  }
}
