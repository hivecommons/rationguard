# Security Policy

The rationguard maintainers take the security of this project seriously.
Thank you for helping keep rationguard and its users safe by disclosing
vulnerabilities responsibly.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
pull requests, or discussions.** Public reports expose users to the very
weakness being reported before a fix is available.

Instead, use **private vulnerability reporting**:

1. Go to this repository's **Security** tab.
2. Click **Report a vulnerability** (GitHub's private security advisory flow).
3. Provide a description of the issue and how to reproduce it.

If private reporting is unavailable to you for any reason, contact a repository
maintainer directly rather than opening a public issue.

Please include, as much as you can:

- The affected component (CLI command, watcher, checker, learner, etc.),
  branch, and commit (or published npm version).
- A description of the vulnerability and its potential impact — for example,
  whether it could cause an unintended rebuttal to be injected into an agent
  session, or expose data from `.rationguard/custom-excuses.json`.
- Step-by-step instructions to reproduce it.
- Any proof-of-concept, logs, or configuration that help us confirm it.

## What to Expect

- **Acknowledgement:** we aim to acknowledge your report within **5 business
  days**.
- **Assessment:** we will investigate, confirm the issue, and keep you informed
  of our progress.
- **Fix and disclosure:** we will work on a fix and coordinate a disclosure
  timeline with you. We ask that you give us a reasonable opportunity to
  remediate before any public disclosure.
- **Credit:** with your permission, we are happy to credit you for the report.

## Scope

Reports about the code published in this repository and the
`@hivecommons/rationguard` npm package are in scope. This includes the CLI,
the `check`/`Watcher` programmatic API, and how rationguard integrates with
[`@hivecommons/pluk`](https://www.npmjs.com/package/@hivecommons/pluk) event
streams and tmux sessions. When in doubt, report it privately and let us
triage — we would rather hear about a non-issue than miss a real one.

## Who Responds

Reports are handled by the Hive Commons maintainers for this repository.

Thank you for contributing to the security of rationguard.
