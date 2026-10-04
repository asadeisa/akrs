// Browser discovery (F18): a deterministic candidate list per OS. It reads only the environment and the file system.
import { statSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { BROWSER_POLICY } from './policy.js';

const isFile = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};
const setValue = (env, name) => (typeof env[name] === 'string' && env[name] !== '' ? env[name] : null);
const EXPLICIT = ['AKRS_BROWSER_PATH', 'CHROME_PATH'];

// -> [{ source, path }] in search order
export function browserCandidates({ platform = process.platform, env = process.env } = {}) {
  const list = [];
  for (const name of EXPLICIT) if (setValue(env, name) !== null) list.push({ source: name, path: env[name] });
  const { discovery } = BROWSER_POLICY;
  if (platform === 'win32') {
    for (const variable of discovery.win32_roots) {
      const base = setValue(env, variable);
      if (base === null) continue;
      for (const relative of discovery.win32) list.push({ source: 'os_paths', path: win32.join(base, relative) });
    }
  } else if (platform === 'darwin') {
    for (const path of discovery.darwin) list.push({ source: 'os_paths', path });
  } else if (platform === 'linux') {
    const directories = (setValue(env, 'PATH') ?? '').split(':').filter((entry) => entry !== '');
    for (const name of discovery.linux_names) for (const directory of directories) list.push({ source: 'path_lookup', path: posix.join(directory, name) });
  }
  return list;
}

const REMEDIATION = 'Install Chrome, Edge or Chromium, or set AKRS_BROWSER_PATH to the browser executable.';

// -> { ok: true, path, source, tried } | { ok: false, reason, tried, remediation, variable? }
export function discoverBrowser({ platform = process.platform, env = process.env, exists = isFile } = {}) {
  const tried = [];
  for (const candidate of browserCandidates({ platform, env })) {
    tried.push(candidate);
    if (exists(candidate.path)) return { ok: true, path: candidate.path, source: candidate.source, tried };
    if (EXPLICIT.includes(candidate.source)) {
      return {
        ok: false, reason: 'configured_browser_missing', variable: candidate.source, tried,
        remediation: `${candidate.source} is set to ${candidate.path}, which is not a file. Fix the variable or unset it to let AKRS search for a browser.`,
      };
    }
  }
  return { ok: false, reason: 'browser_not_found', tried, remediation: REMEDIATION };
}
