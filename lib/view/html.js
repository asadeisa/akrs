// The static visual board (P2-W17): a pure function from the akrs.graph/v1 data to one self-contained HTML string. It runs no query, reads no
// file and touches no network; every decision it shows is an attribute already in the graph. See VIEW_POLICY for the security rules.
import { createHash } from 'node:crypto';
import { validateGraph } from '../schemas/navigation.js';
import { ContractValidationError } from '../schemas/validation.js';

const STYLE = `
:root{color-scheme:light dark;--bg:#f7f8fa;--surface:#fff;--ink:#14181f;--muted:#5b6472;--line:#d5dae2;--accent:#2457c5;--ok:#1d7a46;--warn:#9a5b00;--bad:#b3261e;--chip:#eef1f6}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0f1318;--surface:#171c23;--ink:#e8ecf2;--muted:#9aa4b2;--line:#2a323d;--accent:#7aa2f7;--ok:#5fcf8d;--warn:#f0b35a;--bad:#ff8a80;--chip:#222a35}}
:root[data-theme="dark"]{--bg:#0f1318;--surface:#171c23;--ink:#e8ecf2;--muted:#9aa4b2;--line:#2a323d;--accent:#7aa2f7;--ok:#5fcf8d;--warn:#f0b35a;--bad:#ff8a80;--chip:#222a35}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1180px;margin:0 auto;padding:20px 16px 48px}
h1{font-size:1.5rem;margin:0 0 4px}
h2{font-size:1.1rem;margin:28px 0 10px}
.sub{color:var(--muted);margin:0 0 8px}
.empty{color:var(--muted);font-style:italic}
table{border-collapse:collapse;width:100%;background:var(--surface);border:1px solid var(--line);border-radius:8px;overflow:hidden}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:.8rem;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em}
tr:last-child td{border-bottom:0}
.board{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.col{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:10px;min-width:0}
.col h3{margin:0 0 8px;font-size:.9rem}
.col ul{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.card{border:1px solid var(--line);border-radius:6px;padding:8px;background:var(--bg);overflow-wrap:anywhere}
.card strong{display:block}
.chip{display:inline-block;margin:4px 4px 0 0;padding:1px 8px;border-radius:999px;background:var(--chip);color:var(--ink);font-size:.78rem}
.chip.ok{color:var(--ok)}.chip.warn{color:var(--warn)}.chip.bad{color:var(--bad)}
.graph{overflow:auto;background:var(--surface);border:1px solid var(--line);border-radius:8px}
.graph svg{display:block}
.node rect{fill:var(--bg);stroke:var(--line);stroke-width:1.2}
.node.st-ACTIVE rect{stroke:var(--accent);stroke-width:2}
.node.st-DONE rect{stroke:var(--ok)}
.node text{fill:var(--ink);font-size:12px}
.node text.sub{fill:var(--muted);font-size:10px}
.edge{fill:none;stroke:var(--muted);stroke-width:1.2}
.edge.block{stroke:var(--warn);stroke-width:2.4}
.edge.collision{stroke:var(--bad);stroke-width:1.6;stroke-dasharray:5 4}
.arrow{fill:var(--muted)}
.legend{color:var(--muted);font-size:.85rem;margin:8px 0 0}
@media (max-width:700px){.board{grid-template-columns:1fr}th,td{padding:6px}}
`;

const SCRIPT = `
'use strict';
(function () {
  var NS = 'http://www.w3.org/2000/svg';
  var graph = JSON.parse(document.getElementById('akrs-graph').textContent);
  var app = document.getElementById('app');
  var nodes = graph.nodes;
  var byId = {};
  nodes.forEach(function (node) { byId[node.id] = node; });
  var ofType = function (type) { return nodes.filter(function (node) { return node.type === type; }); };
  var plans = ofType('plan');
  var roads = ofType('road');

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function svg(tag, attrs, text) {
    var node = document.createElementNS(NS, tag);
    Object.keys(attrs || {}).forEach(function (key) { node.setAttribute(key, String(attrs[key])); });
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function add(parent, children) {
    children.forEach(function (child) { if (child) parent.appendChild(child); });
    return parent;
  }
  function chip(text, tone) { return el('span', 'chip' + (tone ? ' ' + tone : ''), text); }
  function section(title, body) {
    var holder = el('section');
    add(holder, [el('h2', null, title), body]);
    return holder;
  }
  function empty(text) { return el('p', 'empty', text); }
  function leaseText(lease) { return lease ? (lease.holder || 'no holder') + ' (' + lease.state + ')' : 'none'; }
  function table(heads, rows) {
    var tbl = el('table');
    var head = el('tr');
    heads.forEach(function (name) { head.appendChild(el('th', null, name)); });
    add(tbl, [add(el('thead'), [head])]);
    var body = el('tbody');
    rows.forEach(function (cells) {
      var row = el('tr');
      cells.forEach(function (cell) { row.appendChild(el('td', null, cell)); });
      body.appendChild(row);
    });
    tbl.appendChild(body);
    return tbl;
  }
  var edgesOf = function (type) { return graph.edges.filter(function (edge) { return edge.type === type; }); };
  var blockedBy = {};
  edgesOf('block').forEach(function (edge) { (blockedBy[edge.to] = blockedBy[edge.to] || []).push(edge.from); });
  var collidesWith = {};
  edgesOf('collision').forEach(function (edge) {
    (collidesWith[edge.from] = collidesWith[edge.from] || []).push(edge.to);
    (collidesWith[edge.to] = collidesWith[edge.to] || []).push(edge.from);
  });

  var header = el('header');
  add(header, [
    el('h1', null, 'AKRS board'),
    el('p', 'sub', 'Plans ' + plans.length + ', Roads ' + roads.length + ', Tasks ' + ofType('task').length + ', verifications ' + ofType('verification').length + ', edges ' + graph.edges.length + (graph.touches ? ', touching ' + graph.touches : '')),
  ]);
  app.appendChild(header);

  // Plans: closure and Tester state
  var planRows = plans.map(function (plan) {
    var own = roads.filter(function (road) { return road.plan === plan.id; });
    var done = own.filter(function (road) { return road.status === 'DONE'; }).length;
    return [plan.id, plan.status || '-', plan.tester || '-', done + ' of ' + own.length + ' Roads DONE', leaseText(plan.lease)];
  });
  app.appendChild(section('Plans', plans.length === 0 ? empty('No Plans.') : table(['Plan', 'Closure', 'Tester', 'Progress', 'Tester lease'], planRows)));

  // Board by status
  var board = el('div', 'board');
  ['QUEUED', 'ACTIVE', 'DONE'].forEach(function (status) {
    var column = el('div', 'col');
    var list = el('ul');
    var inColumn = roads.filter(function (road) { return road.status === status; });
    inColumn.forEach(function (road) {
      var card = el('li', 'card');
      add(card, [el('strong', null, road.id)]);
      card.appendChild(chip(road.class || 'unclassified'));
      if (road.plan) card.appendChild(chip('Plan ' + road.plan));
      if (road.needs_split) card.appendChild(chip('needs split', 'warn'));
      if (road.lease) card.appendChild(chip('lease ' + leaseText(road.lease), road.lease.state === 'fresh' ? 'ok' : 'warn'));
      if (blockedBy[road.id]) card.appendChild(chip('blocked by ' + blockedBy[road.id].join(', '), 'warn'));
      if (collidesWith[road.id]) card.appendChild(chip('collides with ' + collidesWith[road.id].join(', '), 'bad'));
      list.appendChild(card);
    });
    add(column, [el('h3', null, status + ' (' + inColumn.length + ')'), inColumn.length === 0 ? empty('none') : list]);
    board.appendChild(column);
  });
  app.appendChild(section('Roads by status', roads.length === 0 ? empty('No Roads.') : board));

  // Dependency graph (layered, inline SVG)
  var layer = {};
  var depsOf = {};
  edgesOf('dep').forEach(function (edge) { (depsOf[edge.from] = depsOf[edge.from] || []).push(edge.to); });
  function layerOf(id, trail) {
    if (layer[id] !== undefined) return layer[id];
    if (trail.indexOf(id) !== -1) return 0;
    var deeper = (depsOf[id] || []).filter(function (dep) { return byId[dep] && byId[dep].type === 'road'; }).map(function (dep) { return layerOf(dep, trail.concat(id)) + 1; });
    layer[id] = deeper.length === 0 ? 0 : Math.max.apply(null, deeper);
    return layer[id];
  }
  roads.forEach(function (road) { layerOf(road.id, []); });
  var rows = {};
  var place = {};
  var BOX_W = 160;
  var BOX_H = 38;
  var GAP_X = 70;
  var GAP_Y = 16;
  var width = 20;
  var height = 20;
  roads.forEach(function (road) {
    var column = layer[road.id];
    rows[column] = rows[column] || 0;
    place[road.id] = { x: 10 + column * (BOX_W + GAP_X), y: 10 + rows[column] * (BOX_H + GAP_Y) };
    rows[column] += 1;
    width = Math.max(width, place[road.id].x + BOX_W + 10);
    height = Math.max(height, place[road.id].y + BOX_H + 10);
  });
  var drawn = el('div', 'graph');
  if (roads.length === 0) {
    drawn = empty('No Roads to draw.');
  } else {
    var canvas = svg('svg', { width: width, height: height, viewBox: '0 0 ' + width + ' ' + height, role: 'img', 'aria-label': 'Dependency graph of ' + roads.length + ' Roads' });
    var defs = svg('defs');
    var marker = svg('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto' });
    marker.appendChild(svg('path', { d: 'M0 0L10 5L0 10z', class: 'arrow' }));
    defs.appendChild(marker);
    canvas.appendChild(defs);
    var link = function (kind, from, to) {
      if (!place[from] || !place[to]) return;
      var a = place[from];
      var b = place[to];
      var path;
      if (kind === 'collision') {
        path = 'M' + (a.x + BOX_W / 2) + ' ' + (a.y + BOX_H / 2) + 'L' + (b.x + BOX_W / 2) + ' ' + (b.y + BOX_H / 2);
      } else {
        // from the dependency (left) to the Road that needs it
        var x1 = a.x + BOX_W;
        var y1 = a.y + BOX_H / 2;
        var x2 = b.x;
        var y2 = b.y + BOX_H / 2;
        path = 'M' + x1 + ' ' + y1 + 'C' + (x1 + 30) + ' ' + y1 + ',' + (x2 - 30) + ' ' + y2 + ',' + x2 + ' ' + y2;
      }
      var line = svg('path', { d: path, class: 'edge ' + kind });
      if (kind !== 'collision') line.setAttribute('marker-end', 'url(#arrow)');
      line.appendChild(svg('title', {}, kind + ': ' + from + ' - ' + to));
      canvas.appendChild(line);
    };
    edgesOf('collision').forEach(function (edge) { link('collision', edge.from, edge.to); });
    edgesOf('dep').forEach(function (edge) { link('dep', edge.to, edge.from); });
    edgesOf('block').forEach(function (edge) { link('block', edge.from, edge.to); });
    roads.forEach(function (road) {
      var spot = place[road.id];
      var group = svg('g', { class: 'node st-' + road.status, transform: 'translate(' + spot.x + ' ' + spot.y + ')' });
      group.appendChild(svg('rect', { width: BOX_W, height: BOX_H, rx: 6 }));
      group.appendChild(svg('text', { x: 8, y: 16 }, road.id));
      group.appendChild(svg('text', { x: 8, y: 30, class: 'sub' }, road.status + ' / ' + (road.class || 'unclassified')));
      group.appendChild(svg('title', {}, road.id + ' ' + road.status));
      canvas.appendChild(group);
    });
    drawn.appendChild(canvas);
  }
  var graphBody = el('div');
  add(graphBody, [drawn, el('p', 'legend', 'Arrows run from a dependency to the Road that needs it. Amber: an unfinished dependency blocks the Road. Dashed red: two unfinished Roads whose declared writes overlap.')]);
  app.appendChild(section('Dependency graph', graphBody));

  // Executor classes
  var classes = {};
  roads.forEach(function (road) { var key = road.class || 'unclassified'; (classes[key] = classes[key] || []).push(road); });
  var classRows = Object.keys(classes).sort().map(function (key) {
    return [key, classes[key].length, classes[key].map(function (road) { return road.id + ' [' + road.status + ']'; }).join(', ')];
  });
  app.appendChild(section('Executor classes', classRows.length === 0 ? empty('No Roads.') : table(['Class', 'Roads', 'Which'], classRows)));

  // Leases
  var leased = nodes.filter(function (node) { return node.lease; });
  app.appendChild(section('Leases', leased.length === 0 ? empty('No lease is held.') : table(['Kind', 'Subject', 'Holder', 'State'], leased.map(function (node) {
    return [node.type, node.id, node.lease.holder || 'no holder', node.lease.state];
  }))));
}());
`;

const ESCAPES = { '<': '\\u003c', '>': '\\u003e', '&': '\\u0026', '\u2028': '\\u2028', '\u2029': '\\u2029' };
const sha256Base64 = (text) => createHash('sha256').update(text, 'utf8').digest('base64');

// The inert JSON the page reads: no character that could close a script element or break a line terminator rule.
export const embedJson = (value) => JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (char) => ESCAPES[char]);

export const BOARD_STYLE = STYLE;
export const BOARD_SCRIPT = SCRIPT;

export function renderBoardHtml(graph) {
  const verdict = validateGraph(graph);
  if (!verdict.ok) throw new ContractValidationError('graph', verdict.issues);
  const policy = [
    "default-src 'none'",
    `script-src 'sha256-${sha256Base64(SCRIPT)}'`,
    `style-src 'sha256-${sha256Base64(STYLE)}'`,
    'img-src data:',
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${policy}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>AKRS board</title>',
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    '<noscript>The AKRS board needs JavaScript to draw itself; the data is in the akrs-graph block below.</noscript>',
    '<main id="app"></main>',
    `<script type="application/json" id="akrs-graph">${embedJson(graph)}</script>`,
    `<script>${SCRIPT}</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
