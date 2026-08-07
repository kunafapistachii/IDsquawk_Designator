# IDsquawk Designator

Squawk deduplication tool for Aurora ATC clients on the IVAO network, scoped to Indonesian FIR (WAAF/WIIF).

## The problem

IVAO's built-in SSR system assigns squawk codes one lookup at a time. It doesn't handle overlapping allocation ranges, so during busy traffic two aircraft can end up on the same code. Indonesia's squawk allotment table has intentional overlaps between aerodromes, which makes this worse.

## What it does

The app watches your Aurora traffic, checks which codes are in use across the live IVAO network (via the Whazzup API), and computes the smallest available code from your allocation rules. If the primary range is full, it spills over to the next priority rule.

You control which airports it tracks: it reads Aurora's own controlled-airport list (`#CTRL`), skipping the hardcoded prefix match some tools use. It checks squawk conflicts against real transponder data pulled from Whazzup.

Aurora has no command that remotely sets an aircraft's actual transponder. The app computes the code and displays it for you to relay to the pilot, the same way you'd assign a squawk over voice or text in real ATC. It also sends a best-effort label to Aurora via `#LBSQK`, though that field doesn't persist in Aurora's own UI.

## Architecture

```
Aurora  <--TCP:1130-->  Node server  <--HTTP/WS-->  React UI
                              |
                        Whazzup API (live network squawks)
                              |
                        squawk_db.json (allocation rules)
```

Node has to sit between the browser and Aurora because Aurora's third-party API is a raw TCP socket. Browsers can't open those.

## Stack

- **Server:** Node.js, Express, `net` for the Aurora TCP client, `ws` for pushing live traffic to the UI.
- **Client:** React, Vite, Tailwind.
- **Data:** `squawk_db.json`, a converted copy of the official Indonesian FIR squawk allotment spreadsheet.

## Running it

```bash
npm run install:all
npm run dev
```

This starts the server on port 4000 and the client on port 5173. Or double-click `start.bat`, which installs dependencies if needed and opens the browser once both are up.

Aurora needs "3rd Party Software Access" enabled: PVD → Settings (F7) → Other.

## API

| Endpoint | What it does |
|---|---|
| `GET /api/traffic` | Traffic at your controlled airports, with live squawk status |
| `POST /api/assign` | Computes a conflict-free squawk for a callsign |
| `GET /api/status` | Aurora connection, Whazzup cache age, controlled airports |

## Tests

```bash
cd server
npm test
```

Covers octal range expansion, cross-FIR deduplication, spillover priority, and the Aurora TCP framing.

## Known limits

Aurora's `#LBSQK` command writes a coordination label that flashes briefly and clears itself. It's not a persistent field like the ones set through Aurora's own manual entry. The web UI is the source of truth for what code was computed. There's no documented workaround.
