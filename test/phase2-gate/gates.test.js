// P2-W11 release gate, part 2: the gates that need the checkout rather than the tarball. Every other gate is proved by the test file the
// gate report names; these close the holes between them.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { discoverBrowser } from '../../lib/browser/discovery.js';
import { assertActionable } from './support.js';

const TEST_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SKIPPED_FIXTURES = /(?:^|\/)(?:legacy|schemas|canonical|road-schema-invalid|memory-unknown|path-safety|packet-envelope)(?:\/|$)/;

// A1 section 9 / P2-W11: the real-browser smoke tests skip where no browser is installed. Skipping is honest on a developer machine, but on
// CI it would hide a lost browser, so there a missing browser is a failure.
test('on CI a Chromium-family browser is present, so the real-browser smoke tests run instead of being skipped', { skip: process.env.CI ? false : 'enforced on CI only (CI is not set)' }, () => {
  const found = discoverBrowser({ platform: process.platform, env: process.env });
  assert.equal(found.ok, true, `no browser on CI: ${JSON.stringify(found)}`);
});

async function jsonFiles(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const key = relative(TEST_ROOT, path).split('\\').join('/');
    if (SKIPPED_FIXTURES.test(key)) continue;
    if (entry.isDirectory()) found.push(...await jsonFiles(path));
    else if (entry.name.endsWith('.json')) found.push(path);
  }
  return found;
}

function* packetsIn(value) {
  if (Array.isArray(value)) {
    for (const entry of value) yield* packetsIn(entry);
  } else if (value !== null && typeof value === 'object') {
    if (value.schema_version === 'akrs.packet/v2' && typeof value.status === 'string') yield value;
    for (const entry of Object.values(value)) yield* packetsIn(entry);
  }
}

// AX gate 5 over the committed fixtures. The installed-tarball gate applies the same rule to every packet it receives (support.js run()).
test('AX gate 5: every packet in every committed fixture has runnable next commands, and a packet that is not ok says what to do', async () => {
  const files = [
    ...await jsonFiles(join(TEST_ROOT, 'fixtures')),
    ...await jsonFiles(join(TEST_ROOT, 'mcp', 'golden')),
  ];
  let packets = 0;
  let notOk = 0;
  for (const file of files) {
    let document;
    try {
      document = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      continue;
    }
    for (const packet of packetsIn(document)) {
      packets += 1;
      if (packet.status !== 'ok' && packet.status !== 'noop') notOk += 1;
      assertActionable(packet, `${relative(TEST_ROOT, file)} ${packet.command}`);
    }
  }
  assert.ok(packets >= 25, `the sweep reached ${packets} packets`);
  assert.ok(notOk >= 10, `the sweep reached ${notOk} packets that are not ok`);
});
