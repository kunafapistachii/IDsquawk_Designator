import { useEffect, useRef, useState } from 'react';

function useStatus() {
  const [status, setStatus] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        if (!cancelled) setStatus(data);
      } catch {
        if (!cancelled) setStatus(null);
      }
    }
    poll();
    const id = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return status;
}

function useTraffic() {
  const [traffic, setTraffic] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const wsRef = useRef(null);

  async function refresh() {
    setLoading(true);
    try {
      const res = await fetch('/api/traffic');
      const data = await res.json();
      if (Array.isArray(data)) {
        setTraffic(data);
        setError(null);
      } else {
        setError(data.error ?? 'Unknown error');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${window.location.host}/ws`);
    wsRef.current = ws;
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'traffic') setTraffic(msg.data);
      } catch {
        // ignore malformed frames
      }
    };
    return () => ws.close();
  }, []);

  return { traffic, loading, error, refresh };
}

function StatusBadge({ status }) {
  if (!status) {
    return <span className="px-2 py-1 rounded text-xs bg-slate-700 text-slate-300">Server unreachable</span>;
  }
  const auroraOk = status.aurora?.connected;
  const controlled = status.controlledAirports ?? [];
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className={`px-2 py-1 rounded text-xs font-medium ${auroraOk ? 'bg-emerald-800 text-emerald-200' : 'bg-red-900 text-red-200'}`}>
        Aurora {auroraOk ? 'connected' : 'disconnected'}
      </span>
      <span className="px-2 py-1 rounded text-xs bg-slate-800 text-slate-300">
        Whazzup cache {status.whazzup?.cacheAgeMs != null ? `${Math.round(status.whazzup.cacheAgeMs / 1000)}s old` : 'empty'}
      </span>
      <span className="px-2 py-1 rounded text-xs bg-slate-800 text-slate-300">
        Pending {status.pending?.active ?? 0}
      </span>
      <span className="px-2 py-1 rounded text-xs bg-slate-800 text-slate-300 font-mono">
        Controlling: {controlled.length > 0 ? controlled.join(', ') : 'none'}
      </span>
    </div>
  );
}

export default function App() {
  const status = useStatus();
  const { traffic, loading, error, refresh } = useTraffic();
  const [assigning, setAssigning] = useState({});
  const [results, setResults] = useState({});

  async function assign(callsign) {
    setAssigning((s) => ({ ...s, [callsign]: true }));
    try {
      const res = await fetch('/api/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callsign }),
      });
      const data = await res.json();
      setResults((r) => ({ ...r, [callsign]: data }));
      if (!data.error) refresh();
    } catch (err) {
      setResults((r) => ({ ...r, [callsign]: { error: err.message } }));
    } finally {
      setAssigning((s) => ({ ...s, [callsign]: false }));
    }
  }

  return (
    <div className="min-h-screen p-6 max-w-5xl mx-auto">
      <header className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold">Aurora Squawk Designator</h1>
          <p className="text-slate-400 text-sm">WAAF (Ujung Pandang) &amp; WIIF (Jakarta) — runtime deduplication</p>
        </div>
        <StatusBadge status={status} />
      </header>

      <div className="mb-4 p-3 rounded bg-amber-950/40 border border-amber-800 text-amber-200 text-sm">
        Aurora's 3rd-party API has no command to remotely set an aircraft's real squawk — after computing a code, you still need to tell the pilot to squawk it (voice/text), same as real ATC.
      </div>

      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-medium">Traffic</h2>
        <button
          onClick={refresh}
          className="px-3 py-1.5 text-sm rounded bg-slate-800 hover:bg-slate-700 transition"
        >
          Refresh
        </button>
      </div>

      {error && <div className="mb-4 p-3 rounded bg-red-950 border border-red-800 text-red-200 text-sm">{error}</div>}

      <div className="overflow-hidden rounded-lg border border-slate-800">
        <table className="w-full text-sm">
          <thead className="bg-slate-900 text-slate-400">
            <tr>
              <th className="text-left px-4 py-2 font-medium">Callsign</th>
              <th className="text-left px-4 py-2 font-medium">Dep</th>
              <th className="text-left px-4 py-2 font-medium">Arr</th>
              <th className="text-left px-4 py-2 font-medium">Rules</th>
              <th className="text-left px-4 py-2 font-medium">Current SQK</th>
              <th className="text-left px-4 py-2 font-medium">Tell pilot to squawk</th>
              <th className="text-left px-4 py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {loading && traffic.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-6 text-center text-slate-500">Loading traffic…</td></tr>
            )}
            {!loading && traffic.length === 0 && !error && (
              <tr><td colSpan={7} className="px-4 py-6 text-center text-slate-500">No WA*/WI* traffic on radar</td></tr>
            )}
            {traffic.map((t) => {
              const result = results[t.callsign];
              return (
                <tr key={t.callsign} className="border-t border-slate-800">
                  <td className="px-4 py-2 font-mono">{t.callsign}</td>
                  <td className="px-4 py-2 font-mono">{t.departure}</td>
                  <td className="px-4 py-2 font-mono">{t.arrival}</td>
                  <td className="px-4 py-2">{t.flightRules}</td>
                  <td className="px-4 py-2 font-mono">{t.currentSquawk}</td>
                  <td className="px-4 py-2 font-mono">
                    {result?.assignedSquawk ? (
                      <span className="text-emerald-300 font-semibold text-base">
                        {result.assignedSquawk}
                        {result.spilledOver && <span className="ml-1 text-amber-400 text-xs font-normal">(spillover)</span>}
                      </span>
                    ) : result?.error ? (
                      <span className="text-red-400 text-xs">{result.error}</span>
                    ) : (
                      <span className="text-slate-600">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <button
                      onClick={() => assign(t.callsign)}
                      disabled={assigning[t.callsign]}
                      className="px-3 py-1 rounded bg-sky-700 hover:bg-sky-600 disabled:opacity-50 disabled:cursor-not-allowed transition text-xs font-medium"
                    >
                      {assigning[t.callsign] ? 'Assigning…' : 'Assign'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
