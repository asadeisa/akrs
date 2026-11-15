# create-akrs

Start [AKRS](https://github.com/asadeisa/akrs) in the current project with one short command:

```bash
npm create akrs
```

It runs `akrs init` from [`akrs-framework`](https://www.npmjs.com/package/akrs-framework), the same as
`npx akrs-framework init`: the framework doctrine is copied into `docs/akrs/`.

Arguments after `--` go to `akrs init`:

```bash
npm create akrs -- --force                  # replace the copied doctrine
npm create akrs -- --scaffold --plan P1     # create the minimal v2 workflow (Plan tier)
```

Once `akrs-framework` is installed in the project (`npm install akrs-framework`), the CLI is also
available as `npx akrs <command>`.

This package only starts the framework; the CLI and the documentation live in
[`akrs-framework`](https://www.npmjs.com/package/akrs-framework). MIT licensed.
