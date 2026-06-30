# Release Checklist

For maintainers cutting a new AKRS release. Follow top to bottom.

---

## 1. Pre-flight: Documentation Audit

- [ ] README is accurate and all links resolve.
- [ ] `GETTING_STARTED.md` steps still match current behavior.
- [ ] Diagrams render on GitHub (Mermaid blocks valid).
- [ ] No duplicated information across docs (one owner per concept).
- [ ] Folder names referenced in docs match the actual repo.
- [ ] `docs/research/` left untouched (frozen history).

## 2. Examples & Validation

- [ ] Examples under `examples/` are present and described.
- [ ] `docs/validation/` reflects the latest tests (models, results).

## 3. Version & Changelog

- [ ] Decide the bump (MAJOR / MINOR / PATCH) per `VERSIONING.md`.
- [ ] Update `version` in `package.json`.
- [ ] Move the new entries into a dated, versioned section in `CHANGELOG.md`.
- [ ] Update the comparison link at the bottom of `CHANGELOG.md`.

## 4. Package Contents

- [ ] `package.json` `files` field includes only what users need
      (`bin`, `docs/framework`, `docs/guides`, `GETTING_STARTED.md`, `README.md`,
      `LICENSE`, `CHANGELOG.md`).
- [ ] `.npmignore` excludes research, validation internals, dev artifacts.
- [ ] Dry-run the package and inspect contents:
  ```bash
  npm pack --dry-run
  ```
  Confirm: no `node_modules`, no `.git`, no `docs/research/`, no run outputs.

## 5. Install Smoke Test

In a clean temp directory, verify each manager:

```bash
npm install  <path-or-tarball>
pnpm add     <path-or-tarball>
yarn add     <path-or-tarball>
```

- [ ] Package installs with all three.
- [ ] `docs/framework/` is present after install.
- [ ] `GETTING_STARTED.md`, `README.md`, `LICENSE` are present.
- [ ] Metadata (name, version, license, repository) is correct.

## 6. Git & GitHub

- [ ] Working tree clean; only intended files tracked (`git status`).
- [ ] Commit with a clear message.
- [ ] Tag the release:
  ```bash
  git tag -a v<version> -m "AKRS v<version>"
  git push origin main --tags
  ```
- [ ] Create the GitHub Release from the tag; paste the CHANGELOG section.

## 7. Publish

```bash
npm publish --access public
```

- [ ] Confirm the published version on the registry.
- [ ] Install the published version fresh and re-run the smoke test.

## 8. Post-release

- [ ] Open a fresh `## [Unreleased]` section in `CHANGELOG.md`.
- [ ] Update `ROADMAP.md` if priorities shifted.
- [ ] Announce.
