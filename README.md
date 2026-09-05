# Agent Rules Linter

Agent Rules Linter is a small, dependency-free Node.js CLI for checking repository-local instruction files used by AI coding agents.

It currently focuses on:

- `CLAUDE.md`
- `AGENTS.md`

The goal is to make instruction-file maintenance visible in the same way as a lightweight code check: size, likely broken local paths, and repeated Markdown headings.

## Install and run

Requires Node.js 18 or newer.

```text
npm install
npx agent-rules-linter
```

With explicit files:

```text
agent-rules-linter CLAUDE.md AGENTS.md
```

When no files are supplied, the CLI checks `CLAUDE.md` and `AGENTS.md` in the current directory if they exist.

## Example output

```text
Agent Rules Linter
Result: FAIL; 1 warning(s)
Failure threshold: error

Scanned files (1):
- CLAUDE.md: 412 bytes, 23 lines, ~103 tokens (estimate)

Findings (2):
- WARNING [duplicate-heading] CLAUDE.md:18 — Duplicate heading: Testing (first seen at line 7)
- ERROR [broken-path] CLAUDE.md:21 — Local path does not exist: docs/missing.md
```

The token figure is an explainable approximation based on character count divided by four. It is not an exact provider token count.

Markdown output is available on stdout:

```text
agent-rules-linter --format markdown CLAUDE.md
```

Or write a Markdown report:

```text
agent-rules-linter --output report.md CLAUDE.md
```

## Rules and thresholds

Default per-file thresholds are:

- maximum 300 lines
- maximum approximately 3,000 tokens

Change them with `--max-lines` and `--max-tokens`. Size findings are warnings by default; use `--size-severity error` to make them errors.

The path check uses a conservative heuristic for relative paths, common repository directories, and file-like paths. It resolves references relative to the current working directory. URLs, shell flags, Markdown anchors, and version-like numbers are ignored. A path that exists is not reported.

Headings are compared after trimming whitespace, collapsing whitespace, and case-normalizing. Semantic duplicate detection is not attempted.

## Exit codes

- `0`: no finding at or above the configured failure threshold
- `1`: a finding reached the threshold
- `2`: invalid CLI input, missing target, or another CLI error

The default is `--fail-on error`, so warnings are shown but do not fail CI. Use `--fail-on warning` to fail on warnings too.

## CI example

The CLI can be called from an existing Node.js workflow without a dedicated Marketplace Action:

```yaml
- name: Check agent instruction files
  run: npx agent-rules-linter --fail-on warning
```

## Limitations

This MVP does not provide semantic correctness, contradiction detection, security scanning, automatic rewriting or splitting, an LLM integration, a dashboard, telemetry, or a hosted service. The path check is intentionally heuristic and may miss references or require a small amount of configuration in unusual repositories.

## Development

```text
npm test
```

## License

MIT. See [LICENSE](LICENSE).
