// Input normalization (F16, Q26): every channel (stdin, --input file, MCP input_path) becomes identical
// text: one UTF-8 BOM stripped (a second one is rejected), CRLF tolerated (normalized to LF); UTF-16, invalid UTF-8, NUL, >1 MiB rejected.
import { MAX_INPUT_BYTES } from './strict-json.js';

// UTF-16 text without a BOM is mostly ASCII with a NUL in every other byte (one parity of positions).
function looksLikeUtf16(bytes) {
  if (bytes.length < 2 || bytes.length % 2 !== 0) return false;
  const zeros = [0, 0];
  bytes.forEach((byte, index) => {
    if (byte === 0) zeros[index % 2] += 1;
  });
  const half = bytes.length / 2;
  return zeros.some((count) => count * 2 >= half);
}

const failure = (code, message) => ({ ok: false, text: '', issues: [{ path: '$', code, message }] });

export function normalizeInput(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('normalizeInput requires a byte buffer');
  if (bytes.length > MAX_INPUT_BYTES) return failure('too_large', `input exceeds ${MAX_INPUT_BYTES} bytes`);
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    return failure('invalid_encoding', 'UTF-16 input is not supported; use UTF-8');
  }
  if (bytes.indexOf(0) !== -1) {
    return failure('nul_byte', looksLikeUtf16(bytes)
      ? 'NUL bytes are not allowed (possibly UTF-16 without a BOM; use UTF-8)'
      : 'NUL bytes are not allowed');
  }
  const isBom = (offset) => bytes[offset] === 0xef && bytes[offset + 1] === 0xbb && bytes[offset + 2] === 0xbf;
  const hasBom = isBom(0);
  if (hasBom && isBom(3)) return failure('bom', 'more than one UTF-8 BOM at the start of the input');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(hasBom ? 3 : 0));
  } catch {
    return failure('invalid_encoding', 'input is not valid UTF-8');
  }
  return { ok: true, text: text.replaceAll('\r\n', '\n'), issues: [] };
}
