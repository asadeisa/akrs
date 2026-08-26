import assert from 'node:assert/strict';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export function normalizeRepoPath(value) {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

export function assertNormalizedRepoPath(value) {
  assert.equal(value, normalizeRepoPath(value), `path is not normalized: ${value}`);
  const portableAbsolute = isAbsolute(value) || /^[A-Za-z]:\//.test(value) || value.startsWith('//');
  assert.equal(portableAbsolute, false, `path must be repository-relative: ${value}`);
  assert.equal(value.split('/').includes('..'), false, `path escapes its root: ${value}`);
}

export function assertPathWithin(root, candidate) {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const fromRoot = relative(resolvedRoot, resolvedCandidate);
  const escapes = fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot);

  assert.equal(escapes, false, `path escapes temporary root: ${resolvedCandidate}`);
  return resolvedCandidate;
}

export function pathWithin(root, ...segments) {
  return assertPathWithin(root, resolve(root, ...segments));
}
