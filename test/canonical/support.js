const LEAF = { keys: ['path', 'lines', 'why'], arrays: { lines: { kind: 'ordered', nullable: true } }, objects: {} };
const WRITE = { keys: ['path', 'class', 'action'], arrays: {}, objects: {} };

export const SAMPLE_SPEC = {
  keys: ['schema', 'id', 'deps', 'reads', 'writes', 'checks', 'nested', 'note'],
  arrays: {
    deps: { kind: 'set' },
    reads: { kind: 'ordered', item: LEAF },
    writes: { kind: 'set', sortKey: 'path', item: WRITE },
    checks: { kind: 'ordered' },
  },
  objects: { nested: { keys: ['a', 'b'], arrays: {}, objects: {} } },
};
