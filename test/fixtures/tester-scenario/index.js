// P2-W14 fixture: the tiny app answers as the scenario tests expect (the app itself lives in app.js).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { APP, freePort } from '../../scenario/support.js';

test('the fixture app serves its pages, its JSON and its failures, and stops when asked', async () => {
  const port = await freePort();
  const child = spawn(process.execPath, [APP, String(port)], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    await once(child.stdout, 'data');
    const get = (path, init) => fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual', ...init });
    assert.equal((await get('/health')).status, 200);
    assert.deepEqual(await (await get('/api/reservations')).json(), { items: [{ id: 1, name: 'Ada' }], total: 1, paid: true });
    assert.equal((await get('/boom')).status, 500);
    assert.equal((await get('/moved')).status, 302);
    assert.match(await (await get('/')).text(), /Reservations/);
    assert.deepEqual(await (await get('/echo', { method: 'POST', body: 'x', headers: { 'x-token': 't' } })).json(), { method: 'POST', body: 'x', token: 't' });
  } finally {
    child.kill();
  }
});
