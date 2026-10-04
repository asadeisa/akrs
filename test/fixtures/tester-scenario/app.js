// The tiny HTTP app the P2-W14 scenario tests launch: `node app.js <port> [--child <pid-file>]`. Started with no port (as
// `node --test` does when it walks this directory) it exits at once, so it is a harmless "test" there.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const [portText, flag, pidFile] = process.argv.slice(2);
const port = Number(portText);

const PAGES = {
  '/': '<!doctype html><title>Demo</title><h1>Reservations</h1><button id="save" onclick="document.getElementById(\'out\').textContent=\'Saved!\'">Save</button><p id="out"></p>',
  '/form': '<!doctype html><title>Form</title><label>Name <input id="name"></label><button onclick="document.getElementById(\'out\').textContent=\'Hello \'+document.getElementById(\'name\').value">Greet</button><p id="out"></p>',
  '/clean': '<!doctype html><title>Clean</title><h1>All good</h1>',
  '/errors': '<!doctype html><title>Errors</title><h1>Broken</h1><script>console.error("fixture-boom")</script>',
};

if (Number.isInteger(port) && port > 0) {
  const server = createServer((request, response) => {
    const path = request.url.split('?')[0];
    if (path === '/favicon.ico') {
      response.writeHead(204);
      response.end();
    } else if (path === '/health') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('ok');
    } else if (path === '/api/reservations') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ items: [{ id: 1, name: 'Ada' }], total: 1, paid: true }));
    } else if (path === '/boom') {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end('boom');
    } else if (path === '/moved') {
      response.writeHead(302, { location: 'http://example.invalid/elsewhere' });
      response.end();
    } else if (path === '/echo' && request.method !== 'GET') {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ method: request.method, body: Buffer.concat(chunks).toString('utf8'), token: request.headers['x-token'] ?? null }));
      });
    } else if (PAGES[path] !== undefined) {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(PAGES[path]);
    } else {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('missing');
    }
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`fixture app listening on ${port}`);
    if (flag === '--child') {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      writeFileSync(pidFile, String(child.pid));
    }
  });
}
