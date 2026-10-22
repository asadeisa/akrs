// P2-W17: the frozen decisions of `view`, the static visual board. Documentation and closed vocabularies that the tests pin down.
const deepFreeze = (value) => {
  if (value !== null && typeof value === 'object') for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
};

export const VIEW_SCHEMA = 'akrs.view/v1';
export const VIEW_DIRECTORY = '.cache/view';
export const VIEW_FILE = 'index.html';
export const VIEW_SECTIONS = Object.freeze(['board', 'executors', 'graph', 'leases', 'plans']);

export const VIEW_POLICY = deepFreeze({
  output: 'One self-contained HTML file, <workflow>/.cache/view/index.html (derived_write: the cache is excluded from snapshots and from the audit). The bytes depend only on the graph data, so the same workflow gives the same file; an identical file is not rewritten (noop-style outcome unchanged).',
  source: 'The page is rendered from the akrs.graph/v1 data alone (renderBoardHtml receives that one object and runs no query of its own). The handler builds the graph with the same function `graph` uses, so the page and `graph --json` can never disagree.',
  sections: 'Plans (closure and Tester state), a board of the Roads by status (QUEUED, ACTIVE, DONE), the dependency graph (inline SVG, dep, block and collision edges), executor classes (Roads per class) and leases (Road and Plan leases with holder and fresh or stale state).',
  security: 'The graph is embedded once as inert JSON (a script of type application/json) with < > & U+2028 and U+2029 escaped, so a closing script tag cannot appear in it. Every value reaches the page through textContent or setAttribute on elements the script creates; innerHTML, outerHTML, insertAdjacentHTML, document.write, eval, Function, inline event handlers and dynamic import are never used. A Content-Security-Policy meta tag allows nothing but this page\'s own inline style and script (by sha256), and default-src none forbids every network request.',
  offline: 'The file references no external URL, font, image, stylesheet or script and starts no request (no fetch, XMLHttpRequest, WebSocket, EventSource or beacon). The only URL-like string is the SVG namespace identifier, which is a name, not a request. A test loads the page in a real browser and checks that nothing was requested and nothing was blocked.',
  theme: 'Light and dark follow prefers-color-scheme through CSS variables; the layout works from phone width; every status carries a text label as well as a colour.',
  package: 'No new dependency, no build step, no template engine: the renderer is a pure function returning a string.',
});
