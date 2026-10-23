## Summary

<!-- Describe the change. Link the issue with `Closes #…`. -->

Closes #

## Release impact

The PR title is a Conventional Commit and decides the release:
- `feat` → minor
- `fix` / `perf` → patch
- anything else → none
- `type!:` or `BREAKING CHANGE:` in the body → major

- [ ] `CHANGELOG.md` updated under `## [Unreleased]` (required for `feat` / `fix` / `perf` / breaking changes)
- [ ] `SECURITY.md` Supported Versions table names the new minor line (`X.Y.x` as `:white_check_mark:`, the previous line as `:x:`) — required for `feat` (minor) and breaking (major) changes, which start a new supported line

## Verification

- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] `npm pack --dry-run`
- [ ] Smoke test (see [CONTRIBUTING.md](CONTRIBUTING.md#pre-merge-smoke-test))
- [ ] Automated tests in `tests/` added or updated for new functionality, behavior changes, or bug fixes; if not applicable, explain why (e.g. docs-only, CI-only,
      chore-only with no runtime impact, or behavior-preserving refactor already covered by existing tests)

## Self-review

- [ ] Are promises, timers, child processes, and abort listeners cleaned up on error, abort, and reload?
- [ ] Does anything write to stdout or swallow errors?
- [ ] Is external input Zod-validated and are URLs scheme-checked?
- [ ] Are credentials origin-bound and written `0o600`?
