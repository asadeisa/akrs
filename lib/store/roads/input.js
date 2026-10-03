// The input channels of the writers: `--input <path>` (contained in the repository, normally a draft) and stdin.
// Both normalize to identical text (one BOM stripped, CRLF tolerated, 1 MiB cap, no duplicate keys) before the
// closed schema sees the document. Failures are issue lists in the validators' `{ path, code, message }` shape.
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { MAX_INPUT_BYTES, normalizeInput, parseStrictJson } from '../canonical/index.js';
import { PathSafetyError, createPathService } from '../path-service.js';
import { isDraftName } from './paths.js';
import { DRAFT_DIRECTORY } from './policy.js';

const JSON_EXTENSION = '.json';
const isBytes = (value) => value instanceof Uint8Array;
const failure = (code, message, extra = {}) => ({
  ok: false, missing: false, issues: [{ path: '$', code, message }], file: null, draft: null, ...extra,
});

// Repository-relative form of the `--input` value: forward slashes, one leading ./ dropped, and an absolute path
// accepted only when it lies inside the repository. Returns null when it does not.
function toRepositoryPath(service, repositoryRoot, value) {
  let text = value.replaceAll('\\', '/');
  const absolute = isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value);
  if (absolute) {
    for (const base of [resolve(repositoryRoot), service.repository_root]) {
      const inside = relative(base, resolve(value));
      if (inside !== '' && inside !== '..' && !inside.startsWith('..') && !isAbsolute(inside)) return inside.replaceAll('\\', '/');
    }
    return null;
  }
  if (text.startsWith('./')) text = text.slice(2);
  return text;
}

// The draft name when `file` is exactly <workflow>/drafts/<name>.json, otherwise null.
export function draftNameOf(workflowRelative, file) {
  const prefix = `${workflowRelative === '' ? '' : `${workflowRelative}/`}${DRAFT_DIRECTORY}/`;
  if (!file.startsWith(prefix) || !file.endsWith(JSON_EXTENSION)) return null;
  const name = file.slice(prefix.length, -JSON_EXTENSION.length);
  return isDraftName(name) ? name : null;
}

function parseDocument(bytes, extra) {
  const normalized = normalizeInput(bytes);
  if (!normalized.ok) return failure(normalized.issues[0].code, normalized.issues[0].message, extra);
  const parsed = parseStrictJson(normalized.text);
  if (!parsed.ok) return { ok: false, missing: false, issues: parsed.issues, file: null, draft: null, ...extra };
  if (parsed.value === null || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    return failure('invalid_type', 'the document must be a JSON object', extra);
  }
  return { ok: true, document: parsed.value, bytes: Buffer.from(bytes), issues: [], ...extra, missing: false };
}

// channel: { inputPath } | { stdin }.
// ok:   { ok: true, document, bytes, file, draft, draftName }
// fail: { ok: false, missing, issues, file, draft, draftName }; `missing` marks an input file that is not there
//       (a retry whose draft was consumed is resolved through the journal before this becomes a usage error).
export async function readAuthoringInput({ repositoryRoot, workflowRoot, channel }) {
  if (channel === null || typeof channel !== 'object') throw new TypeError('channel is required');
  const hasPath = channel.inputPath !== undefined;
  const hasStdin = channel.stdin !== undefined;
  if (hasPath === hasStdin) throw new TypeError('channel needs exactly one of inputPath or stdin');
  const none = { file: null, draft: null, draftName: null };

  if (hasStdin) {
    if (!isBytes(channel.stdin)) throw new TypeError('channel.stdin must be a byte buffer');
    return parseDocument(channel.stdin, none);
  }
  if (typeof channel.inputPath !== 'string') throw new TypeError('channel.inputPath must be a string');
  const service = await createPathService({ repositoryRoot, workflowRoot });
  const unsafe = (message) => failure('invalid_path', message, none);
  if (channel.inputPath === '') return unsafe('--input needs a path inside the repository');
  const requested = toRepositoryPath(service, repositoryRoot, channel.inputPath);
  if (requested === null) return unsafe(`${channel.inputPath} is outside the repository`);

  let resolved;
  try {
    resolved = await service.resolveRepositoryPath(requested);
  } catch (error) {
    if (!(error instanceof PathSafetyError)) throw error;
    return unsafe(error.message);
  }
  if (!resolved.case_matches) {
    return unsafe(`${requested} differs in case from the file system entry ${resolved.actual_relative_path}`);
  }
  const file = resolved.actual_relative_path;
  const draftName = draftNameOf(service.workflow_relative_path, file);
  const named = { file, draft: draftName === null ? null : file, draftName };
  if (!resolved.exists) {
    return failure('not_found', `${file} does not exist`, { ...named, missing: true });
  }
  const metadata = await lstat(resolved.filesystem_path);
  if (!metadata.isFile()) return failure('not_file', `${file} is not a regular file`, named);
  if (metadata.size > MAX_INPUT_BYTES) return failure('too_large', `${file} exceeds ${MAX_INPUT_BYTES} bytes`, named);
  return parseDocument(await readFile(resolved.filesystem_path), named);
}
