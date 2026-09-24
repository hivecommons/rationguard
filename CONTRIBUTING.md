# Contributing to rationguard

Thanks for helping improve rationguard. This project follows the Hive Commons contribution conventions used across the organization.

## Local setup

Prerequisites:

- Node.js 18 or newer
- npm

Install dependencies and build from source:

```bash
npm ci
npm run build
```

Run the standard checks before opening a PR:

```bash
npm run lint
npm run build
npm test
```

The package ships compiled files from `dist/`, but `dist/` is generated and intentionally not committed. `npm publish` runs `npm run build` through `prepublishOnly`.

## Development notes

- Source lives under `src/` and is TypeScript ESM.
- Add or update tests for behavior changes. Tests compile to `dist/` and are discovered with `node --test dist/*.test.js`.
- Keep changes focused: security fixes, behavior changes, docs, and refactors should be separate PRs when practical.
- Do not commit secrets, local credentials, generated `dist/` output, or machine-specific files.

## Commits and DCO

All commits must be signed off for the Developer Certificate of Origin (DCO):

```bash
git commit -s
```

This adds a `Signed-off-by:` trailer confirming you have the right to contribute the work.

## Pull requests

Before submitting:

1. Rebase on the latest `main`.
2. Run `npm run lint`, `npm run build`, and `npm test`.
3. Use a clear PR title, preferably with the repository convention: ✨ feature, 🐛 bug fix, 📖 docs, 🌱 infra/tests, or ⚠️ breaking.
4. Link related issues with `Fixes #123` when the PR fully resolves them.

Maintainers review PRs for correctness, tests, security impact, and compatibility with the CLI behavior documented in `README.md`.
