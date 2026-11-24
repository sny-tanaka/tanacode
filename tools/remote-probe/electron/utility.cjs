// utilityProcess の中で動かす小さなサーバー。HTTP・WebSocket を 127.0.0.1 の空いたポートで待ち受け、
// WebAuthn のライブラリ（@simplewebauthn/server）が読み込めて動くかを確かめて、main に知らせる
const http = require('node:http');
const { WebSocketServer } = require('ws');

async function main() {
  const { generateRegistrationOptions } = await import('@simplewebauthn/server');
  const options = await generateRegistrationOptions({ rpName: 'tanacode の確かめ', rpID: 'localhost', userName: 'probe' });

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('utilityProcess から');
  });
  const wss = new WebSocketServer({ server, path: '/ws', perMessageDeflate: false });
  wss.on('connection', (ws) => ws.on('message', (data) => ws.send(data.toString())));
  server.listen(0, '127.0.0.1', () => {
    process.parentPort.postMessage({ port: server.address().port, webauthn: { ok: true, challengeLength: options.challenge.length, rpId: options.rp.id } });
  });
  process.parentPort.on('message', (event) => process.parentPort.postMessage({ echo: event.data.echo, from: 'utility' }));
}

main().catch((error) => process.parentPort.postMessage({ error: String(error?.stack ?? error) }));
