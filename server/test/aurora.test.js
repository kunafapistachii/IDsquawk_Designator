import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { AuroraClient } from '../aurora.js';

// Spins up a fake Aurora TCP server that echoes canned responses, so we can
// validate framing/parsing/reconnect without a live Aurora instance.
function startMockServer(handler) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.setEncoding('ascii');
      let buf = '';
      socket.on('data', (chunk) => {
        buf += chunk;
        let idx;
        // eslint-disable-next-line no-cond-assign
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, '');
          buf = buf.slice(idx + 1);
          handler(socket, line);
        }
      });
      server.emit('client', socket);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('aurora: #CTRL request/response parses controlled airports list', async () => {
  const server = await startMockServer((socket, line) => {
    if (line === '#CTRL') socket.write('#CTRL;WADD;WIII;WARR\r\n');
  });
  const port = server.address().port;
  const client = new AuroraClient({ host: '127.0.0.1', port, reconnectDelayMs: 100 });
  await new Promise((resolve) => { client.on('connected', resolve); client.connect(); });
  const airports = await client.getControlledAirports();
  assert.deepEqual(airports, ['WADD', 'WIII', 'WARR']);
  client.disconnect();
  server.close();
});

test('aurora: #TR request/response parses callsign list', async () => {
  const server = await startMockServer((socket, line) => {
    if (line === '#TR') socket.write('#TR;GIA123;SIA456\r\n');
  });
  const port = server.address().port;
  const client = new AuroraClient({ host: '127.0.0.1', port, reconnectDelayMs: 100 });
  await new Promise((resolve) => { client.on('connected', resolve); client.connect(); });
  const traffic = await client.getTraffic();
  assert.deepEqual(traffic, ['GIA123', 'SIA456']);
  client.disconnect();
  server.close();
});

test('aurora: #FP maps fields per a live-confirmed raw response and preserves raw', async () => {
  const server = await startMockServer((socket, line) => {
    if (line.startsWith('#FP;')) {
      // Real raw sample captured from a live Aurora #FP response
      // (2026-08-02): fields[8]=flight rules (I/V/Y/Z), fields[9]=flight
      // type (S/N/G/M/X) -- reversed from the handoff doc's numbering.
      socket.write('#FP;ETR323;WAAA;RPLC;RCMQ;2049;B763;H;I;S;S;F350;N0470;0600;0311;GURNI G578;DOF/260801\r\n');
    }
  });
  const port = server.address().port;
  const client = new AuroraClient({ host: '127.0.0.1', port, reconnectDelayMs: 100 });
  await new Promise((resolve) => { client.on('connected', resolve); client.connect(); });
  const fp = await client.getFlightPlan('ETR323');
  assert.equal(fp.departure, 'WAAA');
  assert.equal(fp.arrival, 'RPLC');
  assert.equal(fp.alternate, 'RCMQ');
  assert.equal(fp.aircraft, 'B763');
  assert.equal(fp.flightRules, 'I');
  assert.equal(fp.flightType, 'S');
  assert.equal(fp.route, 'GURNI G578');
  assert.equal(fp.remarks, 'DOF/260801');
  assert.ok(fp.raw.includes('ETR323'));
  client.disconnect();
  server.close();
});

test('aurora: @ERR response rejects the matching pending request with the real reason', async () => {
  const server = await startMockServer((socket, line) => {
    if (line.startsWith('#LBSQK;')) {
      const [, callsign, sqk] = line.split(';');
      socket.write(`@ERR;#LBSQK;${callsign};${sqk};Traffic not assumed.\r\n`);
    }
  });
  const port = server.address().port;
  const client = new AuroraClient({ host: '127.0.0.1', port, reconnectDelayMs: 100 });
  await new Promise((resolve) => { client.on('connected', resolve); client.connect(); });
  await assert.rejects(client.setSquawk('GIA229', '5599'), /Traffic not assumed/);
  client.disconnect();
  server.close();
});

test('aurora: #LBSQK sets squawk and #TRSQK reads it back', async () => {
  let stored = '0000';
  const server = await startMockServer((socket, line) => {
    if (line.startsWith('#LBSQK;')) {
      const [, callsign, sqk] = line.split(';');
      stored = sqk;
      socket.write(`#LBSQK;${callsign};${sqk}\r\n`);
    } else if (line.startsWith('#TRSQK;')) {
      const [, callsign] = line.split(';');
      socket.write(`#TRSQK;${callsign};${stored}\r\n`);
    }
  });
  const port = server.address().port;
  const client = new AuroraClient({ host: '127.0.0.1', port, reconnectDelayMs: 100 });
  await new Promise((resolve) => { client.on('connected', resolve); client.connect(); });
  const setResult = await client.setSquawk('GIA123', '4601');
  assert.equal(setResult, '4601');
  const readBack = await client.getSquawk('GIA123');
  assert.equal(readBack, '4601');
  client.disconnect();
  server.close();
});

test('aurora: send() rejects args containing ";"', async () => {
  const server = await startMockServer(() => {});
  const port = server.address().port;
  const client = new AuroraClient({ host: '127.0.0.1', port, reconnectDelayMs: 100 });
  await new Promise((resolve) => { client.on('connected', resolve); client.connect(); });
  assert.throws(() => client.send('LBSQK', ['GIA123', '46;01']), /cannot contain/);
  client.disconnect();
  server.close();
});

test('aurora: send() rejects args containing CR/LF (command injection guard)', async () => {
  const server = await startMockServer(() => {});
  const port = server.address().port;
  const client = new AuroraClient({ host: '127.0.0.1', port, reconnectDelayMs: 100 });
  await new Promise((resolve) => { client.on('connected', resolve); client.connect(); });
  // A malicious/unvalidated callsign smuggling a second command via \r\n.
  assert.throws(() => client.send('FP', ['GIA123\r\n#LBSQK;OTHER;9999']), /cannot contain/);
  assert.throws(() => client.send('FP', ['GIA123\nMORE']), /cannot contain/);
  client.disconnect();
  server.close();
});

test('aurora: request times out gracefully if no matching reply arrives', async () => {
  const server = await startMockServer(() => {}); // never replies
  const port = server.address().port;
  const client = new AuroraClient({ host: '127.0.0.1', port, reconnectDelayMs: 100 });
  await new Promise((resolve) => { client.on('connected', resolve); client.connect(); });
  await assert.rejects(client.request('TR', [], { timeoutMs: 200 }), /timed out/);
  client.disconnect();
  server.close();
});

test('aurora: auto-reconnects after server drops connection', async () => {
  const server = await startMockServer((socket, line) => {
    if (line === '#TR') socket.write('#TR;X1\r\n');
  });
  const port = server.address().port;
  const client = new AuroraClient({ host: '127.0.0.1', port, reconnectDelayMs: 150 });

  let connectCount = 0;
  const connectedOnce = new Promise((resolve) => {
    client.on('connected', () => {
      connectCount++;
      if (connectCount === 1) resolve();
    });
  });
  client.connect();
  await connectedOnce;

  const reconnected = new Promise((resolve) => {
    client.on('connected', () => {
      if (connectCount === 2) resolve();
    });
  });
  client.socket.destroy(); // simulate Aurora dropping us
  await reconnected;

  const traffic = await client.getTraffic();
  assert.deepEqual(traffic, ['X1']);

  client.disconnect();
  server.close();
});
