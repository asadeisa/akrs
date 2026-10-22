// Handler of `view` (P2-W17): builds the graph with the same function `graph` uses, renders the static board from that data alone and writes
// the one cache file. The only write is <workflow>/.cache/view/index.html (derived_write).
import { createPacket } from '../core/packet.js';
import { buildGraphData } from '../store/navigation/graph.js';
import { readWorkflowModel } from '../store/navigation/model.js';
import { commandSnapshot } from '../store/snapshots/index.js';
import { VIEW_SCHEMA, renderBoardHtml, writeBoard } from '../view/index.js';
import { DESKTOP_NEXT_COMMAND_BUILDERS } from '../userconfig/next-commands.js';
import { knownCommandsOf, resolveRoots, rootArgsOf } from './authoring.js';

export async function createViewPacket(parameters) {
  const { input, manifest, providers } = parameters;
  const roots = resolveRoots(parameters);
  const base = { repositoryRoot: roots.repository_root, workflowRoot: roots.workflow_root };
  const rootArgs = rootArgsOf(input.flags);
  const model = await readWorkflowModel({ ...base, env: process.env, rootArgs });
  const graph = buildGraphData(model);
  const written = await writeBoard({ ...base, html: renderBoardHtml(graph) });
  const { snapshot } = await commandSnapshot('view', base);
  return createPacket({
    command: 'view',
    status: written.outcome === 'written' ? 'ok' : 'noop',
    root: roots.repository_root,
    snapshot: { before: snapshot, after: snapshot },
    data: {
      kind: 'view', packet_version: VIEW_SCHEMA, outcome: written.outcome, path: written.path, bytes: written.bytes, sha256: written.sha256, nodes: graph.nodes.length, edges: graph.edges.length,
    },
    changed: written.outcome === 'written' ? [written.path] : [],
    nextCommands: DESKTOP_NEXT_COMMAND_BUILDERS.view({ phase: 'written', rootArgs }),
    providers,
    knownCommands: knownCommandsOf(manifest),
  });
}
