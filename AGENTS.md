# Image Ledger project instructions

Use the Caveman and Ponytail skills. Keep changes small and reports concise.

## Default verification

- Run `npm test` for unit/filesystem checks when code changes require them.
- The default live smoke test is `npm run test:obsidian`. It builds the current plugin, creates a fresh synthetic vault, and exercises the loaded Obsidian app through CLI/API calls and real DOM handlers.
- Read `TESTING.md` before changing the runner. Keep its 90-second deadline, bounded readiness waits, canonical vault-path checks, plugin/build/fixture validation, nonce checks, and JSON receipts.
- Do not repeat successful checks without a new change, failure, or unresolved concern that justifies another run.

## No computer use

Do not use computer-use tools or native GUI automation for this project. This includes screenshot-driven control, coordinate clicks, simulated keyboard/mouse input, accessibility/AppleScript UI scripting, and Finder/clipboard gestures. Direct CLI/API calls and programmatic DOM handlers in the bounded smoke runner are allowed.

If the CLI/API is unavailable or the runner fails, diagnose or repair the bounded API runner, or report `FAIL` / `NOT RUN` with the actual blocker and retained receipt. Never fall back to computer use, propose a native UI fallback, or extend the test budget to retry GUI actions.

Generated paste/drop events do not prove native OS clipboard conversion or Finder gesture behavior. Report those boundaries as unverified; do not use them as a reason to start computer use. Extend API or unit coverage where possible.

## Isolation and project context

All tests must use fresh generated synthetic vaults. Never test or install test builds in `/Users/aegerita/Coding/Journal`, or copy its personal notes, settings, or credentials into a test vault. Keep the runner's verified generated-vault-only trust step.

Linear is the planning authority. Preserve unrelated working-tree changes. Dated smoke reports and archived architecture documents are historical evidence, not current procedures; this file and `TESTING.md` define the current testing policy.
