# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install --ignore-scripts   # Install dependencies
npm run build                  # Build all packages (tui → ai → agent → coding-agent)
npm run check                  # Biome lint/format + pinned-dep + ts-import + shrinkwrap + type checks
./test.sh                      # Run all tests without API keys (safe default)
./pi-test.sh                   # Run pi from sources (works from any directory)
```

Running a specific test (from the package root, e.g. `packages/coding-agent`):

```bash
node ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts
```

**Never** run `npm run build` or `npm test` unless the user asks. **Never** run `vitest` directly at the repo root — use `./test.sh` instead to avoid triggering e2e tests that need live API keys.

After any code change (not docs), run `npm run check` and fix all errors, warnings, and infos before committing.

## Architecture

This is a TypeScript monorepo (`npm workspaces`) with four core packages built in dependency order:

- **`packages/tui`** — Terminal UI library with differential rendering, keybindings, stdin buffering, autocomplete, and a kill ring. No dependencies on the other packages.
- **`packages/ai`** — Unified multi-provider LLM API (OpenAI, Anthropic, Google, Mistral, Bedrock, etc.). Exposes `streamSimple`, `Transport`, and a model registry. `models.generated.ts` is auto-generated — edit `scripts/generate-models.ts` instead.
- **`packages/agent`** — Provider-agnostic agent runtime: `Agent`, `runAgentLoop`, tool calling, session state, and a harness for integration tests. Depends on `pi-ai`.
- **`packages/coding-agent`** — The `pi` CLI. Depends on all three packages above. Contains:
  - `src/core/` — Session management, tools (Bash, Read, Edit, Write, Find, Grep, Ls), compaction, extension system, skills, slash commands, settings, keybindings, and the system prompt.
  - `src/modes/interactive/` — TUI interactive mode (the full terminal UI).
  - `src/modes/rpc/` — JSON-L RPC server mode for programmatic access.
  - `src/modes/print-mode.ts` — Non-interactive `-p` prompt mode.
  - `src/cli/` — Argument parsing, startup UI, config selector, session picker.
  - `test/suite/` — Integration test suite using `test/suite/harness.ts` + the faux provider (no real API calls or keys).

Extensions live under `packages/coding-agent/examples/extensions/` and are loaded at runtime via `src/core/extensions/`.

## Key Constraints

- **Erasable TypeScript only** in `packages/*/src`, `packages/*/test`, and `packages/coding-agent/examples`: no `enum`, `namespace`/`module`, parameter properties, `import =`, `export =`. Node runs in strip-only mode.
- **No inline imports** (`await import()` or dynamic type imports). Top-level imports only.
- **No `any`** unless absolutely necessary.
- **Pinned exact versions** for all direct external deps. Hydrate with `npm install --ignore-scripts`; never run lifecycle scripts.
- **Lockfile changes** require `PI_ALLOW_LOCKFILE_CHANGE=1` to commit (pre-commit hook blocks them otherwise).
- `packages/coding-agent/npm-shrinkwrap.json` is regenerated with `node scripts/generate-coding-agent-shrinkwrap.mjs`. New deps with lifecycle scripts need an explicit allowlist entry there.
- **Keybindings** must go into `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS` — never hardcoded key checks.

## Testing

- Suite tests under `packages/coding-agent/test/suite/` use `harness.ts` + faux provider. No real providers, no API keys, no paid tokens.
- Issue-specific regressions go in `test/suite/regressions/<issue-number>-<short-slug>.test.ts`.
- Ad-hoc scripts: write to `/tmp`, run, then delete. Don't embed multi-line scripts in bash.

## Git and Commits

Multiple pi sessions may run concurrently in this working directory. Always stage explicit paths (`git add <path1> <path2>`), never `git add -A` or `git add .`. Check `git status` before committing to confirm you only stage your own files. `packages/ai/src/models.generated.ts` may always accompany your changes.

Commit message format: `{feat,fix,docs}[(ai,tui,agent,coding-agent)]: <message>`.

Never run: `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git commit --no-verify`.

## Changelog

Each package has `CHANGELOG.md`. New entries go under `## [Unreleased]` only. Released version sections are immutable. Format:
- Internal: `Fixed foo ([#123](https://github.com/earendil-works/pi-mono/issues/123))`
- External: `Added X ([#456](...) by [@user](https://github.com/user))`
