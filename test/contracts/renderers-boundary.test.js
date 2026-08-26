import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as core from '../../lib/core/index.js';
import { createCompleteEvent } from '../../lib/core/packet.js';
import { renderJson } from '../../lib/renderers/json.js';
import { renderJsonl } from '../../lib/renderers/jsonl.js';

const packet = JSON.parse(await readFile(
  new URL('../fixtures/packet-envelope/valid-packet.json', import.meta.url),
  'utf8',
));
const event = JSON.parse(await readFile(
  new URL('../fixtures/packet-envelope/valid-event.json', import.meta.url),
  'utf8',
));
const knownCommands = ['road-details', 'road-update'];

async function javascriptFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return javascriptFiles(path);
    return entry.isFile() && entry.name.endsWith('.js') ? [path] : [];
  }));
  return nested.flat();
}

test('JSON renderer emits exactly one stable packet with a trailing newline', () => {
  const output = renderJson(packet, { knownCommands });
  assert.equal(output, `${JSON.stringify(packet, null, 2)}\n`);
  assert.equal(output.includes('\u001b['), false);
  assert.equal(output.includes('✓'), false);
});

test('JSONL renderer emits one compact validated event per line', () => {
  const complete = createCompleteEvent({
    packet,
    sequence: 2,
    providers: { now: () => '2026-08-25T10:30:02.000Z' },
    knownCommands,
  });
  assert.equal(
    renderJsonl([event, complete], { knownCommands }),
    `${JSON.stringify(event)}\n${JSON.stringify(complete)}\n`,
  );
  assert.throws(() => renderJsonl([event], { knownCommands }), /terminal event/);
  assert.throws(
    () => renderJsonl([{ ...event, sequence: 2 }, complete], { knownCommands }),
    /sequence/,
  );
});

test('public core entry is importable without the legacy CLI adapter', () => {
  assert.equal(typeof core.createPacket, 'function');
  assert.equal(typeof core.createCompleteEvent, 'function');
  assert.equal(typeof core.discoverRoots, 'function');
  assert.equal(typeof core.commandManifest, 'object');
});

test('lib modules do not import the CLI or terminal-only modules', async () => {
  const libRoot = fileURLToPath(new URL('../../lib/', import.meta.url));
  const forbidden = ['bin/akrs.js', 'node:readline', 'node:tty', 'node:process'];

  for (const path of await javascriptFiles(libRoot)) {
    const source = await readFile(path, 'utf8');
    for (const specifier of forbidden) {
      assert.equal(source.includes(specifier), false, `${path} imports ${specifier}`);
    }
  }
});
