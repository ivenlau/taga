# Release gates

Inspect the versioned gate manifest and current evidence:

```sh
taga release manifest --milestone=M2 --json
taga release check --milestone=M2 --json
```

Live Agent evidence is produced by `taga agent verify --agent=<id> --yes`. Platform, resilience, security, and performance evidence is recorded only after the corresponding command has actually passed:

```sh
taga release record --gate=platform-linux --status=passed --artifact="pnpm run test" --details="Ubuntu suite passed" --yes
```

M2 budgets retain the M1 local baseline: rebuild 10,000 memories in under 5 seconds and FTS search p95 under 250 ms. Ingestion must remain incremental, cursor-based, and bounded to configured source limits. Release evidence contains identifiers, command names, counts, and sanitized summaries only; raw private Evidence bodies are excluded.

Gemini is outside M2 scope and is represented as a non-required gate.

M3 is the CLI default. It requires measured proactive metrics plus explicit real cross-Agent and platform evidence:

```sh
taga release reuse --source-agent=codex --consumer-agent=claude-code --evidence=<id> --memory=<id> --artifact=CLAUDE.md --yes
taga release record --gate=platform-macos-m3 --status=passed --artifact="macOS compatibility suite" --details="launchd or foreground fallback passed" --yes
taga release check --json
```

The deterministic M3 fixture validates formulas and contracts but does not substitute for installed-Agent or real macOS evidence. Gemini, team sync, graph projection, Pro backend, and L3 automatic execution are reported as excluded or deferred scope.

```sh
node dist/scripts/prepare-m3-release-fixture.js .tmp-m3-release
taga release check --brain=.tmp-m3-release --json
```

The second command is expected to keep real cross-Agent and platform gates blocked until their evidence is recorded.

For a disposable release-validation Brain, build first and run:

```sh
node dist/scripts/prepare-m2-release-fixture.js .tmp-m2-release
```

This creates deterministic Memory/procedure/garden fixtures only. It does not synthesize live Agent, platform, resilience, security, or performance evidence.
