# P0-W05 path-safety fixtures

`case/` is a synthetic cross-platform case-mismatch fixture. The byte-sensitive CRLF,
archived-ledger, and exact-plan-prefix regressions reuse the approved immutable legacy fixtures
under `../legacy/log-crlf`, `../legacy/log-archived`, and `../legacy/features-plan-prefix` by
copying them into dedicated operating-system temporary roots before any mutation test.
