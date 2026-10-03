// Runtime floor check. Conservative syntax on purpose: this module must parse on any Node that can
// load ESM so an unsupported Node gets a clear message instead of a SyntaxError from the real CLI.
export var MINIMUM_NODE_VERSION = '22.17.0';

function parseVersion(value) {
  if (typeof value !== 'string') return null;
  var match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function atLeast(actual, minimum) {
  for (var index = 0; index < 3; index += 1) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
  }
  return true;
}

export function checkNodeVersion(versionString) {
  var actual = parseVersion(versionString);
  if (actual && atLeast(actual, parseVersion(MINIMUM_NODE_VERSION))) {
    return { ok: true, message: '' };
  }
  var found = actual
    ? 'v' + actual.join('.')
    : JSON.stringify(typeof versionString === 'string' ? versionString : String(versionString));
  return {
    ok: false,
    message: 'akrs requires Node.js >=' + MINIMUM_NODE_VERSION + '; found ' + found
      + '. Upgrade Node.js and retry.\n',
  };
}

// postinstall must never break the host project's install: it still reports, but exits 0.
function isPostinstall(argv) {
  return Array.isArray(argv) && argv[0] === 'postinstall';
}

export function refusalExitCode(argv) {
  return isPostinstall(argv) ? 0 : 2;
}

export function failureExitCode(argv) {
  return isPostinstall(argv) ? 0 : 4;
}

export function formatInternalError(error) {
  var text = error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
  text = text.replace(/\s+/g, ' ').trim();
  return 'akrs: internal error: ' + (text === '' ? 'unknown error' : text) + '\n';
}
