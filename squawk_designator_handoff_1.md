# Claude Code Handoff — Aurora Squawk Designator (Indonesian FIR)

> Prompt terstruktur untuk membangun aplikasi. Baca seluruh section sebelum mulai coding.
> File data `squawk_db.json` disediakan terpisah — jangan generate ulang, pakai yang ada.

---

## `<role>`

Kamu adalah senior engineer yang membangun tool ATC untuk jaringan IVAO. Stack: Node.js (backend/engine) + React (Vite, UI), berjalan **lokal di mesin controller** (localhost). Kamu paham protokol socket TCP, konsumsi REST API, dan konsep squawk/transponder (kode **octal**).

---

## `<context>`

**Masalah:** Server SSR resmi IVAO hanya assign 1 kode per lookup dan **tidak menangani range yang overlap**. Data alokasi squawk FIR Indonesia (`squawk_db.json`) sengaja punya banyak range yang overlap antar aerodrome. Akibatnya, saat traffic ramai, kode bisa bentrok (dua pesawat dapat squawk sama).

**Solusi:** App ini melakukan **runtime deduplication**. Sebelum assign kode ke sebuah pesawat, app mengecek semua squawk yang sedang dipakai traffic Indonesia (via whazzup API IVAO), membuang yang kepake, lalu assign kode available terkecil. Kalau range utama habis, app **spillover** ke rule prioritas berikutnya. Kode dikirim ke Aurora lewat 3rd Party API-nya (auto-set squawk label).

**Scope FIR:** WAAF (Ujung Pandang) & WIIF (Jakarta). Departure prefix Indonesia = `WA*` dan `WI*`.

**Perilaku:** On-demand — controller melihat list traffic, klik tombol per pesawat untuk assign. (Bukan full-auto.)

---

## `<data>`

File `squawk_db.json` (disediakan) — hasil konversi dari spreadsheet resmi. Struktur:

```json
{
  "source": "Squawk_Allotment_ID_FIR",
  "fir": ["WAAF", "WIIF"],
  "rules": [
    {
      "center": "WAAF",              // FIR ID (WAAF | WIIF)
      "origins": ["WAD", "WAT"],     // token prefix departure (match via startsWith)
      "destinations": ["WA","WI","WR"], // token prefix arrival (startsWith)
      "order": 31,                   // prioritas: kecil = tinggi. juga urutan spillover
      "flightRules": "IFR",          // "IFR" | "VFR"
      "military": 0,                 // 0 = civil (semua data saat ini 0)
      "minSquawk": "4401",           // string 4-digit OCTAL
      "maxSquawk": "4477",           // string 4-digit OCTAL
      "remark": null
    }
  ]
}
```

Catatan:
- 92 rules total. Sudah divalidasi: semua min/max valid octal, tidak ada tabrakan kode reserved.
- `origins`/`destinations` sudah di-split jadi array token. Token bisa 1–4 char. Daftar huruf tunggal (`A`,`B`,`ZB`,`ZH`, dst) = prefix ICAO negara lain = fallback internasional.
- Tiap route umumnya punya pasangan VFR + IFR dengan range sama (by design).

---

## `<architecture>`

```
[Aurora]  <-- TCP:1130 (ASCII) -->  [Node engine]  <-- HTTPS -->  [Whazzup API]
                                          |
                                    squawk_db.json (embed)
                                    matching + octal expand + spillover + dedup
                                          |
                                    HTTP/WS  <-->  [React UI @ localhost]
```

**KENAPA harus Node lokal, bukan browser murni:** Aurora 3rd Party API adalah **TCP socket di localhost:1130**. Browser TIDAK bisa buka raw TCP socket (cuma HTTP/WebSocket). Jadi engine Node wajib jalan di mesin yang sama dengan Aurora. Node ini juga yang fetch whazzup (server-side) → **CORS bukan masalah**.

---

## `<external_apis>`

### 1. Aurora 3rd Party API (harus di-enable: PVD → Settings/F7 → Other → "3rd Party Software Access" = YES)

- **Transport:** TCP, **port 1130**, localhost, ASCII.
- **Format packet:** diawali 1-byte identifier (`#`), lalu command 2–5 byte, argumen dipisah `;`, packet ditutup CR/LF (`\r\n`).
- **Larangan:** JANGAN kirim semicolon (`;`) di dalam isi argumen (itu delimiter).
- **Error:** server balas pesan error untuk command tak dikenal — tangani semua balasan sebagai string, jangan asumsi jumlah field tetap (IVAO bisa nambah field kapan saja).
- **Multi-client:** boleh banyak koneksi.

Command yang dipakai:

| Command | Arg | Balasan sukses | Guna |
|---|---|---|---|
| `#TR` | — | `#TR;CS1;CS2;...` | list semua callsign di radar |
| `#FP` | `CALLSIGN` | `#FP;CALLSIGN;<flightplan record>` | ambil flight plan |
| `#TRSQK` | `CALLSIGN` | `#TRSQK;CALLSIGN;SQK` | baca squawk terpasang |
| `#LBSQK` | `CALLSIGN;SQK` | `#LBSQK;CALLSIGN;SQK` | **SET squawk (ini "assign"-nya)** |
| `#SELTFC` | — | `#SELTFC;CALLSIGN;` | traffic yang diselect controller |

Flight plan record (dari `#FP`) — field index penting: **1 = Departure ICAO**, **2 = Arriving ICAO**, **8 = Flight rules**. (Field lain: 3 Alternate, 5 Aircraft ICAO, 14 Route, 15 Remarks.)
> ⚠️ Separator field flight-plan record belum 100% pasti dari dokumentasi. **Log raw response `#FP` dulu** untuk konfirmasi delimiter sebelum parsing.

`SQK` di `#LBSQK` = **octal 0000..7777** (dikonfirmasi dokumentasi).

### 2. Whazzup API v2

- **Endpoint:** `GET https://api.ivao.aero/v2/tracker/whazzup`
- **Update tiap ~15 detik** — cache di engine, jangan fetch lebih sering dari 15–30s.
- Field yang dipakai per pilot:
  - `pilots[].callsign`
  - `pilots[].flightPlan.departureId` (ICAO)
  - `pilots[].flightPlan.arrivalId` (ICAO)
  - `pilots[].flightPlan.flightRules` → `"I"` | `"V"` (huruf tunggal!)
  - `pilots[].lastTrack.transponder` → **integer** (mis. `234` = squawk `0234`)

---

## `<critical_constraints>`

Ini yang bikin bug diam-diam kalau kelewat:

1. **Squawk itu OCTAL.** Tiap digit 0–7. Expand range HARUS octal: `for v in range(int(min,8), int(max,8)+1): code = v.toString(8).padStart(4,'0')`. Jangan pakai integer loop biasa — `4558`,`4559` bukan squawk valid.
2. **`transponder` whazzup = integer**, leading zero hilang. **Zero-pad ke 4 digit** sebelum bandingkan.
3. **TCP ≠ browser.** Socket ke Aurora hanya boleh dari Node, bukan dari React langsung.
4. **Dedup lintas FIR.** Used-codes = gabungan traffic dengan departure `WA*` **DAN** `WI*` (dua-duanya), karena range overlap antar FIR. Filter satu FIR saja → bentrok.
5. **Pending-set.** Kode yang baru di-assign app tapi pilot belum dial belum muncul di whazzup (masih squawk lama). Simpan kode assign terakhir di memori (dengan TTL ~60s atau sampai terlihat di whazzup) dan anggap kepake, biar tidak dobel-assign.
6. **Normalisasi flight rules.** Whazzup pakai `I`/`V`; DB pakai `IFR`/`VFR`. Map: `I→IFR`, `V→VFR`. Untuk `Y`/`Z` (mixed), default: `Y→IFR`, `Z→VFR` (fase awal) — konfirmasi ke user kalau ketemu.
7. **Guard kode reserved.** Walau data saat ini bersih, tetap exclude `7500/7600/7700/7000/2000/1200/0000` dari pool assign sebagai safety.
8. **Jangan ada `;` di argumen** yang dikirim ke Aurora.

---

## `<algorithm>`

### Matching (input: originICAO, destICAO, flightRules, center)
1. Filter `rules` yang `center` == FIR controller, `flightRules` cocok, `military` cocok.
2. Rule *applicable* bila: ADA token di `origins` yang `originICAO.startsWith(token)` **DAN** ADA token di `destinations` yang `destICAO.startsWith(token)`.
3. Sort applicable by `order` menaik. Urutan ini = prioritas + urutan spillover.

### Assign (on-demand, saat controller klik pesawat)
1. **Used-codes:** fetch whazzup (cache) → filter pilot `departureId` startsWith `WA`/`WI` → kumpulkan `transponder` (zero-pad 4). Gabung dengan **pending-set** + kode reserved.
2. Ambil rules applicable (urut order). Untuk tiap rule:
   - expand range (octal) → set kode kandidat, buang used-codes.
   - kalau ada sisa → ambil **terkecil**, stop.
   - kalau habis → lanjut rule berikutnya (**spillover**).
3. Kalau semua rule habis → balikan error "no code available" (tampilkan ke UI).
4. Kirim `#LBSQK;CALLSIGN;kode` ke Aurora → masukkan kode ke pending-set → balikan kode ke UI.

---

## `<api_endpoints>` (Node → React)

- `GET /api/traffic` → jalankan `#TR`, lalu `#FP` per callsign, filter departure `WA*`/`WI*`. Balikan array: `{ callsign, departure, arrival, flightRules, currentSquawk }`. (`currentSquawk` via `#TRSQK`.)
- `POST /api/assign` body `{ callsign }` → jalankan flow Assign. Balikan `{ callsign, assignedSquawk, ruleOrder, spilledOver }` atau `{ error }`.
- `GET /api/status` → status koneksi Aurora (socket up/down) + umur cache whazzup.
- (Opsional) WebSocket buat push update list traffic tiap poll.

---

## `<tech_stack>`

- **Backend:** Node.js + Express (atau Fastify). `net` (built-in) untuk TCP socket Aurora. `fetch` (Node 18+) untuk whazzup.
- **Frontend:** React + Vite + Tailwind. Tabel traffic + tombol Assign per baris + indikator status koneksi. Tampilkan kode hasil assign & apakah spillover.
- Satu repo, dua folder (`/server`, `/client`), script `dev` jalanin dua-duanya (concurrently).

---

## `<file_structure>` (saran)

```
squawk-designator/
├─ server/
│  ├─ index.js            # express + routes
│  ├─ aurora.js           # TCP client (connect 1130, send/parse commands)
│  ├─ whazzup.js          # fetch + cache + filter WA/WI + used-codes
│  ├─ matcher.js          # matching + octal expand + spillover
│  ├─ pending.js          # pending-set dengan TTL
│  └─ squawk_db.json      # data (dari file yang disediakan)
├─ client/                # React + Vite
│  └─ src/App.jsx
└─ package.json
```

---

## `<task>`

Bangun aplikasi sesuai spesifikasi di atas. Kerjakan bertahap dan tunjukkan hasil tiap fase:

1. **Fase 1 — Engine core (no Aurora):** `matcher.js` (matching + octal expand + spillover) + `whazzup.js` (fetch, filter, used-codes) + unit test pakai case di `<acceptance_criteria>`. Buktikan dedup & spillover jalan tanpa Aurora dulu.
2. **Fase 2 — Aurora TCP:** `aurora.js` connect ke localhost:1130, implement `#TR`/`#FP`/`#TRSQK`/`#LBSQK`. **Log raw response dulu** buat konfirmasi parsing sebelum lanjut.
3. **Fase 3 — API + UI:** endpoint Express + React table + tombol assign.

Tulis kode defensif: whazzup bisa down, Aurora socket bisa putus (auto-reconnect), field bisa nambah.

---

## `<acceptance_criteria>`

Test yang harus lulus:

1. **Octal expand:** range `4550`–`4567` menghasilkan tepat 16 kode, dan **tidak** mengandung `4558`/`4559`.
2. **Zero-pad:** transponder whazzup `234` diperlakukan sebagai `0234`.
3. **Dedup:** kalau `0234` sedang dipakai traffic WA/WI dan masuk range terpilih, kode itu tidak di-assign.
4. **Ascending:** dari pool available, yang dikembalikan adalah kode terkecil.
5. **Spillover:** kalau seluruh range rule prioritas tertinggi habis kepake, app pindah ke rule `order` berikutnya yang applicable.
6. **Cross-FIR:** traffic departure `WI*` ikut mengurangi pool untuk assignment di FIR `WAAF` (dan sebaliknya) untuk kode yang overlap.
7. **Pending-set:** dua assign berturut-turut untuk pesawat berbeda tidak menghasilkan kode yang sama walau whazzup belum ter-update.
8. **Prefix match:** departure `WADD` cocok dengan rule ber-token origin `WAD` (dan `WA`), lalu `order` menentukan pemenang.

---

## Referensi
- Aurora 3rd Party API: https://wiki.ivao.aero/en/home/devops/manuals/Aurora-3rd-parties-documentation
- Whazzup v2 format: https://wiki.ivao.aero/en/home/devops/api/whazuup/file-format-v2
