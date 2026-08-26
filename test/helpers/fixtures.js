import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

export async function readBase64Fixture(source) {
  const encoded = (await readFile(source, 'utf8')).trim();
  assert.match(encoded, /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
  return Buffer.from(encoded, 'base64');
}
