// `log` (P2-W09): the segmented closure ledger as a chronology, exactly as recorded. Never rewritten, never repaired.
import { LOG_SCHEMA } from './policy.js';

// filters: { kind: null | 'plan' | 'road', subject: null | id, limit: null | integer >= 1 }
export function buildLogData(model, filters) {
  const all = model.closures;
  const matching = all.filter((record) => (filters.kind === null || record.kind === filters.kind) && (filters.subject === null || record.subject === filters.subject));
  const shown = filters.limit === null ? matching : matching.slice(Math.max(0, matching.length - filters.limit));
  return {
    kind: 'log',
    packet_version: LOG_SCHEMA,
    total: matching.length,
    shown: shown.length,
    empty: matching.length === 0,
    filters: { kind: filters.kind, subject: filters.subject, limit: filters.limit },
    entries: shown.map((record) => ({
      segment: record.segment, line: record.line, id: record.id, ts: record.ts, kind: record.kind, subject: record.subject, outcome: record.outcome,
      deviations: record.deviations, operation: record.operation, verified: record.meta_state === 'declared',
    })),
  };
}
