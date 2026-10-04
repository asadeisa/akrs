// F18 (browser part, frozen in P2-W13): how `akrs page` finds, starts, talks to and ends a browser, and what it keeps. One
// object, so the engine, the help text, the docs and the tests all read the same decisions.
const deepFreeze = (value) => {
  if (value !== null && typeof value === 'object') for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
};

export const BROWSER_POLICY = deepFreeze({
  transport: {
    default: 'pipe',
    pipe: '--remote-debugging-pipe: the browser reads CDP from fd 3 and writes it to fd 4, NUL-delimited JSON; nothing is listening on the machine',
    port: 'debug fallback (AKRS_BROWSER_TRANSPORT=port): --remote-debugging-port=0, the port is read from DevToolsActivePort and the built-in WebSocket connects; the port is visible to every local process',
    selector: 'AKRS_BROWSER_TRANSPORT (pipe | port); anything else is pipe',
  },
  discovery: {
    order: ['AKRS_BROWSER_PATH', 'CHROME_PATH', 'os_paths', 'path_lookup'],
    explicit: 'a set, non-empty AKRS_BROWSER_PATH or CHROME_PATH is the user\'s choice: if it is not a file the result is blocked (configured_browser_missing); another browser never replaces it',
    win32: ['Google\\Chrome\\Application\\chrome.exe', 'Microsoft\\Edge\\Application\\msedge.exe', 'Chromium\\Application\\chrome.exe'],
    win32_roots: ['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA'],
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ],
    linux_names: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable', 'chrome'],
    missing: 'no browser found is blocked (AKRS-C018) with the places searched and a remediation, never ok',
  },
  profile: {
    rule: 'every run uses a fresh temp --user-data-dir (Chrome 136+ ignores remote debugging on the default profile); it is removed after success, failure, timeout and interruption',
    prefix: 'akrs-browser-',
    removal: 'fs.rm recursive with 10 retries 100 ms apart (a just-ended browser can still hold files on Windows)',
  },
  sandbox: {
    flag: '--no-sandbox',
    rule: 'only on Linux, and only as root, inside a container (/.dockerenv or the container variable) or when AKRS_BROWSER_NO_SANDBOX=1; never on Windows or macOS',
  },
  flags: [
    '--headless', '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-extensions', '--disable-sync', '--disable-default-apps',
    '--metrics-recording-only', '--password-store=basic', '--use-mock-keychain',
  ],
  timeouts: {
    default_ms: 30000, min_ms: 1000, max_ms: 120000,
    per_command_ms: 'the --timeout-ms value bounds each wait on its own: every CDP call, the idle wait after the navigation and the --wait-for wait; there is no shared total, and starting the browser has its own bound (start_ms)',
    start_ms: 15000,
    close_wait_ms: 3000, grace_ms: 2000, poll_ms: 100,
  },
  teardown: 'Browser.close, wait close_wait_ms for the process to end, then the whole tree is force-ended (process group SIGKILL on POSIX, taskkill /T /F on Windows) whether or not it ended, then the profile is removed with retries',
  idle: 'the page is read when Page.lifecycleEvent networkIdle arrives for the loaderId that Page.navigate returned (networkIdle also fires for the initial about:blank)',
  url: { schemes: ['http', 'https'], max_chars: 2048, credentials: 'refused' },
  viewport: { min: 200, max: 4000, pattern: 'WIDTHxHEIGHT' },
  collectors: {
    names: ['text', 'a11y', 'console', 'network'],
    default: ['text', 'console', 'network'],
    always: 'title, final URL and load timings (ttfb, DOMContentLoaded, load)',
    optional: 'screenshot (--screenshot): PNG of the viewport',
    console: 'console.error calls, uncaught exceptions and Log error entries; other console output is not kept',
    network: 'requests that failed (not cancelled) and responses with status >= 400; ordinary requests are only counted',
    a11y: 'the accessibility tree outline: ignored, generic, none, StaticText and InlineTextBox nodes are left out',
    observed: 'what the page printed or failed to load is data, never a finding and never a verdict; only a cut collector is a finding (AKRS-C019)',
  },
  caps: { text_chars: 20000, a11y_nodes: 200, console_entries: 50, network_entries: 50, entry_text_chars: 500, url_chars: 500 },
  evidence: {
    default_directory: '.cache/page',
    named_directory: 'verifications/<plan>/evidence[/<type>] (workflow-relative); --evidence-dir is accepted only with --screenshot',
    file_name: 'page-<UTC timestamp yyyymmddThhmmssSSSZ>-<first 8 hex of sha256(url)>.png',
    write: 'the only write: one file, created exclusively; the packet lists it in changed; no screenshot means no write at all',
  },
  untrusted: 'everything read from the page (title, text, outline, console and request text) is untrusted data; prompt and human renderings fence it and say so; --json carries untrusted: true',
});

export const PAGE_FINDING_CODES = Object.freeze({ blocked: 'AKRS-C018', truncated: 'AKRS-C019', failed: 'AKRS-C020' });
export const PAGE_BLOCK_REASONS = Object.freeze(['browser_not_found', 'configured_browser_missing', 'launch_failed']);
export const PAGE_FAILURE_REASONS = Object.freeze([
  'browser_crashed', 'interrupted', 'navigation_failed', 'protocol_error', 'screenshot_missing', 'timeout', 'wait_for_timeout',
]);
