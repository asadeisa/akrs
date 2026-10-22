# Minimal example

The smallest v2 workflow, exactly what `akrs init --scaffold` writes (no-Plan tier: Road `R1`, Task `T1`,
a verification contract, `state.json` and the rendered `STATE.md`) plus two executors recorded with
`akrs executor set`, so that `akrs validate` has nothing left to ask.

```text
akrs validate --root examples/minimal --workflow-root examples/minimal/akrs
```

Every file under `akrs/` is written by the CLI: change a Road with `akrs road update`, the State with
`akrs state set`, and never by hand (a hand-edited file is reported as unverified).

See what each role would be handed (both are read-only queries):

```text
akrs road-details R1 --role worker --root examples/minimal --workflow-root examples/minimal/akrs
akrs test-details R1 --root examples/minimal --workflow-root examples/minimal/akrs
```

A test keeps `validate` clean and compares both packets (JSON, prompt and human renderings) to
committed goldens (`test/fixtures/examples-minimal/expected.json`).

To create your own: `akrs init --scaffold` (add `--plan <id>` for the Plan tier). A test keeps this
folder byte-identical to that output; it is regenerated with `AKRS_REGENERATE_EXAMPLE=1 npm test`.
