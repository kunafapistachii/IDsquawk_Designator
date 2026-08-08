import net from 'node:net';
import { EventEmitter } from 'node:events';

const DEFAULT_PORT = 1130;
const DEFAULT_HOST = 'localhost';
const DEFAULT_RECONNECT_DELAY_MS = 3000;
const DEFAULT_TIMEOUT_MS = 5000;

// Aurora replies are treated as opaque strings split on ';'. The doc warns
// IVAO can add fields at any time, so callers must index defensively and
// never assume a fixed field count.
function splitPacket(line) {
  const body = line.startsWith('#') ? line.slice(1) : line;
  return body.split(';');
}

export class AuroraClient extends EventEmitter {
  constructor({
    host = DEFAULT_HOST,
    port = DEFAULT_PORT,
    reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS,
    logRaw = false,
  } = {}) {
    super();
    this.host = host;
    this.port = port;
    this.reconnectDelayMs = reconnectDelayMs;
    this.logRaw = logRaw;
    this.socket = null;
    this.connected = false;
    this.buffer = '';
    this.pending = []; // FIFO of {command, callsign, resolve, reject, timer}
    this._stopped = false;
  }

  connect() {
    this._stopped = false;
    this._openSocket();
  }

  _openSocket() {
    const socket = net.createConnection({ host: this.host, port: this.port });
    this.socket = socket;

    socket.on('connect', () => {
      this.connected = true;
      this.emit('connected');
    });

    socket.setEncoding('ascii');
    socket.on('data', (chunk) => this._onData(chunk));

    socket.on('error', (err) => {
      this.emit('error', err);
    });

    socket.on('close', () => {
      this.connected = false;
      this.emit('disconnected');
      this._rejectAllPending(new Error('Aurora socket closed'));
      if (!this._stopped) {
        setTimeout(() => this._openSocket(), this.reconnectDelayMs);
      }
    });
  }

  disconnect() {
    this._stopped = true;
    this.socket?.destroy();
  }

  _onData(chunk) {
    this.buffer += chunk;
    let idx;
    // eslint-disable-next-line no-cond-assign
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const rawLine = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      if (rawLine.length === 0) continue;
      if (this.logRaw) {
        // eslint-disable-next-line no-console
        console.log('[aurora:raw]', JSON.stringify(rawLine));
      }
      this.emit('raw', rawLine);
      this._handleLine(rawLine);
    }
  }

  _handleLine(rawLine) {
    // Doc identifiers: '#' = communication message, '@' = error result.
    // Error format observed live: "@ERR;#LBSQK;CALLSIGN;VALUE;Reason text."
    // Previously unhandled: errors matched nothing in `pending`, so a
    // rejected command just sat there until it timed out, hiding the real
    // reason (e.g. "Traffic not assumed.") behind a generic timeout error.
    if (rawLine.startsWith('@')) {
      const errFields = rawLine.split(';');
      const echoedCommand = (errFields[1] ?? '').replace(/^#/, '');
      const callsign = errFields[2] ?? null;
      const reason = errFields[errFields.length - 1] || errFields[0];
      const matchIdx = this.pending.findIndex((p) => {
        if (p.command !== echoedCommand) return false;
        if (p.callsign != null && callsign !== p.callsign) return false;
        return true;
      });
      if (matchIdx >= 0) {
        const p = this.pending.splice(matchIdx, 1)[0];
        clearTimeout(p.timer);
        p.reject(new Error(`Aurora rejected ${echoedCommand}: ${reason}`));
      }
      return;
    }

    const fields = splitPacket(rawLine);
    const command = fields[0];
    const matchIdx = this.pending.findIndex((p) => {
      if (p.command !== command) return false;
      if (p.callsign != null && fields[1] !== p.callsign) return false;
      return true;
    });
    if (matchIdx >= 0) {
      const p = this.pending.splice(matchIdx, 1)[0];
      clearTimeout(p.timer);
      p.resolve({ raw: rawLine, fields });
    }
    // No pending match: still emitted via 'raw' above for passive listeners
    // (e.g. unsolicited errors, commands from other clients).
  }

  _rejectAllPending(err) {
    for (const p of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending = [];
  }

  // Sends `#CMD;arg1;arg2\r\n`. Throws if any arg contains ';' (protocol delimiter).
  send(command, args = []) {
    for (const arg of args) {
      // ';' breaks field framing; \r or \n breaks line framing and lets a
      // single arg (e.g. an unvalidated callsign from the HTTP API) inject
      // a second Aurora command onto this connection.
      if (/[;\r\n]/.test(String(arg))) {
        throw new Error(`Aurora arg cannot contain ';', CR, or LF: ${arg}`);
      }
    }
    if (!this.connected || !this.socket) {
      throw new Error('Aurora socket not connected');
    }
    const packet = args.length > 0 ? `#${command};${args.join(';')}\r\n` : `#${command}\r\n`;
    this.socket.write(packet, 'ascii');
  }

  // Sends a command and resolves with the first reply whose echoed command
  // (and callsign, if provided) matches. Rejects on timeout or disconnect.
  request(command, args = [], { callsign = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
      let entry;
      const timer = setTimeout(() => {
        const idx = this.pending.indexOf(entry);
        if (idx >= 0) this.pending.splice(idx, 1);
        reject(new Error(`Aurora request timed out: ${command}`));
      }, timeoutMs);
      entry = { command, callsign, resolve, reject, timer };
      this.pending.push(entry);
      try {
        this.send(command, args);
      } catch (err) {
        clearTimeout(timer);
        const idx = this.pending.indexOf(entry);
        if (idx >= 0) this.pending.splice(idx, 1);
        reject(err);
      }
    });
  }

  async getTraffic() {
    const { fields } = await this.request('TR');
    // #TR;CS1;CS2;...
    return fields.slice(1).filter(Boolean);
  }

  async getFlightPlan(callsign) {
    const { raw, fields } = await this.request('FP', [callsign], { callsign });
    // Field layout confirmed against a live Aurora #FP response (raw dump,
    // 2026-08-02): fields[8] is the flight rules letter (I/V/Y/Z) and
    // fields[9] is flight type (S/N/G/M/X) — the reverse of what the
    // handoff doc's index numbering implied. Real traffic sample:
    // #FP;ETR323;WAAA;RPLC;RCMQ;2049;B763;H;I;S;S;F350;...
    //  [0]  [1]    [2]  [3]  [4]  [5]  [6] [7][8][9]
    return {
      raw,
      fields,
      callsign: fields[1] ?? callsign,
      departure: fields[2] ?? null,
      arrival: fields[3] ?? null,
      alternate: fields[4] ?? null,
      aircraft: fields[6] ?? null,
      flightRules: fields[8] ?? null,
      flightType: fields[9] ?? null,
      route: fields[15] ?? null,
      remarks: fields[16] ?? null,
    };
  }

  async getSquawk(callsign) {
    const { fields } = await this.request('TRSQK', [callsign], { callsign });
    // #TRSQK;CALLSIGN;SQK
    return fields[2] ?? null;
  }

  async setSquawk(callsign, squawk) {
    const { fields } = await this.request('LBSQK', [callsign, squawk], { callsign });
    return fields[2] ?? squawk;
  }

  async getSelectedTraffic() {
    const { fields } = await this.request('SELTFC');
    return fields.slice(1).filter(Boolean);
  }

  async getControlledAirports() {
    const { fields } = await this.request('CTRL');
    // #CTRL;ICAO1;ICAO2;ICAO3;...
    return fields.slice(1).filter(Boolean);
  }
}
