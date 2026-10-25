## Summary

<!-- What does this PR change, and why? Describe any user-visible changes. -->

Fixes #<!-- issue number, if this PR resolves one -->

## Validation

<!-- How did you check the change? Include commands run or manual steps. -->

## Checklist

See [CONTRIBUTING.md](https://github.com/hivecommons/rationguard/blob/main/CONTRIBUTING.md) for details.
Do not report security vulnerabilities in a public PR. Follow [SECURITY.md](https://github.com/hivecommons/rationguard/blob/main/SECURITY.md) instead.

- [ ] `npm run lint`, `npm run build` and `npm test` pass locally
- [ ] If code paths changed: `npm run test:coverage` meets the gate (99% lines / 95% branches / 100% functions)
- [ ] If `.github/`, the `files` field in `package.json`, CLI subcommands/flags/`--cli` values, `ExcuseCategory`, a README heading or a CLI invocation in the docs changed: `npm run test:workflows` passes
- [ ] If shipped code (`src/**/*.ts` other than tests, or `dependencies` in `package.json`) changed: a line is added under `## Unreleased` in `CHANGELOG.md`
- [ ] Behavior changes include tests
- [ ] Commits are signed off (`git commit -s`)
