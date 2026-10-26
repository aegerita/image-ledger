# Image Ledger project instructions

Use the Caveman and Ponytail skills. Keep changes small and reports concise.

## Documentation and source

- Write for the reader's next task. README owns installation, everyday use, and user-facing limits. CONTRIBUTING.md owns developer setup and the source map. TESTING.md owns test procedures. Avoid repeating them across files.
- Document current behavior. Keep plans in Linear and dated evidence in `docs/smoke-tests/`; neither is a current test result.
- Keep `src/main.ts` focused on registration, capture/recovery in `src/captures.ts`, image data in `src/images/`, and host integration in `src/obsidian/`. Each owner keeps its related state and behavior; avoid forwarding methods and layers that only shorten files.
- Use readable blocks and one operation per statement. Do not pack callbacks, validation, or state changes into dense one-line expressions.
- Keep descriptions, commands, and examples brief and concrete. Update the relevant guide when behavior changes.
- Preserve unrelated working-tree changes.

## Verification

- Run `npm test` for code changes. Use `npm run test:obsidian` for live plugin/UI verification through CLI/API calls and programmatic DOM handlers.
- Read TESTING.md before changing the runner. Preserve its 90-second deadline, bounded waits, canonical path checks, generated-vault marker, build/fixture/plugin validation, nonce checks, and JSON receipts.
- All tests use fresh generated synthetic vaults. Never test or install test builds in `/Users/aegerita/Coding/Journal`, or copy personal notes, settings, or credentials into fixtures. Preserve the generated-vault-only trust step.
- Do not repeat successful checks without a new change, failure, or unresolved concern.

## No computer use

Do not use computer-use tools or native GUI automation: screenshots, coordinate clicks, simulated keyboard/mouse input, accessibility/AppleScript UI scripting, or Finder/clipboard gestures. Direct CLI/API calls and programmatic DOM handlers are allowed.

If the API is unavailable or the runner fails, diagnose or repair the bounded runner, or report `FAIL` / `NOT RUN` with the blocker and retained receipt. Never fall back to native UI automation or extend the deadline for it.

Generated paste/drop events do not prove native OS clipboard conversion or Finder gestures. Leave those boundaries unverified; extend API or unit coverage where possible.
