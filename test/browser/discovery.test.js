// P2-W13: browser discovery (F18). The candidate list is deterministic per OS and an explicit choice is never replaced.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserCandidates, discoverBrowser } from '../../lib/browser/discovery.js';

const win = { platform: 'win32', env: { PROGRAMFILES: 'C:\\Program Files', 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' } };
const mac = { platform: 'darwin', env: {} };
const linux = { platform: 'linux', env: { PATH: '/usr/local/bin:/usr/bin' } };

test('the order is AKRS_BROWSER_PATH, CHROME_PATH, per-OS paths, then the PATH on Linux', () => {
  const list = browserCandidates({ ...linux, env: { ...linux.env, AKRS_BROWSER_PATH: '/a/chrome', CHROME_PATH: '/b/chrome' } });
  assert.deepEqual(list.slice(0, 2), [{ source: 'AKRS_BROWSER_PATH', path: '/a/chrome' }, { source: 'CHROME_PATH', path: '/b/chrome' }]);
  assert.equal(list[2].source, 'path_lookup');
});

test('Windows lists Chrome, Edge and Chromium under the program directories', () => {
  const paths = browserCandidates(win).map(({ path }) => path);
  assert.ok(paths.includes('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'));
  assert.ok(paths.includes('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'));
  assert.ok(paths.includes('C:\\Users\\a\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'));
  assert.deepEqual(browserCandidates(win), browserCandidates(win));
});

test('macOS lists the application bundles', () => {
  assert.deepEqual(browserCandidates(mac).map(({ path }) => path), [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ]);
});

test('Linux looks the known names up in every PATH directory, names first', () => {
  const paths = browserCandidates(linux).map(({ path }) => path);
  assert.deepEqual(paths.slice(0, 2), ['/usr/local/bin/google-chrome', '/usr/bin/google-chrome']);
  assert.ok(paths.includes('/usr/bin/chromium'));
  assert.ok(paths.includes('/usr/bin/microsoft-edge'));
});

test('the first existing candidate wins and the search is reported', () => {
  const found = discoverBrowser({ ...linux, exists: (path) => path === '/usr/bin/chromium' });
  assert.equal(found.ok, true);
  assert.deepEqual([found.path, found.source], ['/usr/bin/chromium', 'path_lookup']);
});

test('no browser is blocked with the places that were searched, never ok', () => {
  const found = discoverBrowser({ ...linux, exists: () => false });
  assert.deepEqual([found.ok, found.reason], [false, 'browser_not_found']);
  assert.ok(found.tried.length > 0);
  assert.match(found.remediation, /AKRS_BROWSER_PATH/);
});

test('a configured path that is not a file is blocked and never replaced by another browser', () => {
  const found = discoverBrowser({ ...linux, env: { ...linux.env, AKRS_BROWSER_PATH: '/nope/chrome' }, exists: (path) => path === '/usr/bin/chromium' });
  assert.deepEqual([found.ok, found.reason, found.variable], [false, 'configured_browser_missing', 'AKRS_BROWSER_PATH']);
  const second = discoverBrowser({ ...linux, env: { ...linux.env, CHROME_PATH: '/nope/chrome' }, exists: () => false });
  assert.deepEqual([second.reason, second.variable], ['configured_browser_missing', 'CHROME_PATH']);
});

test('an empty variable counts as unset', () => {
  const found = discoverBrowser({ ...linux, env: { ...linux.env, AKRS_BROWSER_PATH: '' }, exists: (path) => path === '/usr/bin/google-chrome' });
  assert.equal(found.path, '/usr/bin/google-chrome');
});
