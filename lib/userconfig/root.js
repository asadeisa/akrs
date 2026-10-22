// The user-config root resolver (F21). Pure: the environment, the platform and the home directory are inputs.
import { homedir as osHomedir } from 'node:os';
import path from 'node:path';
import { CliUsageError } from '../core/errors.js';
import { normalizeAbsolutePath } from '../core/roots.js';
import { CONFIG_DIRECTORY, CONFIG_HOME_ENV } from './policy.js';

const flavourOf = (platform) => (platform === 'win32' ? path.win32 : path.posix);
const usable = (value) => typeof value === 'string' && value !== '';

// -> { root (native path), display (normalized with /), source }
export function resolveConfigRoot({ env = process.env, platform = process.platform, homedir = osHomedir() } = {}) {
  const flavour = flavourOf(platform);
  const override = env[CONFIG_HOME_ENV];
  if (usable(override)) {
    if (override.includes('\0') || !flavour.isAbsolute(override)) {
      throw new CliUsageError(`${CONFIG_HOME_ENV} must be an absolute path to a directory (got ${JSON.stringify(override)})`);
    }
    const root = flavour.normalize(override);
    return Object.freeze({ root, display: normalizeAbsolutePath(root), source: 'AKRS_CONFIG_HOME' });
  }
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA;
    if (usable(base) && flavour.isAbsolute(base)) {
      const root = flavour.join(base, CONFIG_DIRECTORY);
      return Object.freeze({ root, display: normalizeAbsolutePath(root), source: 'LOCALAPPDATA' });
    }
    const root = flavour.join(homedir, 'AppData', 'Local', CONFIG_DIRECTORY);
    return Object.freeze({ root, display: normalizeAbsolutePath(root), source: 'home' });
  }
  const base = env.XDG_CONFIG_HOME;
  if (usable(base) && flavour.isAbsolute(base)) {
    const root = flavour.join(base, CONFIG_DIRECTORY);
    return Object.freeze({ root, display: normalizeAbsolutePath(root), source: 'XDG_CONFIG_HOME' });
  }
  const root = flavour.join(homedir, '.config', CONFIG_DIRECTORY);
  return Object.freeze({ root, display: normalizeAbsolutePath(root), source: 'home' });
}
