# valta-leak

Static analysis for the specific bugs that turn an AI agent into a runaway bill: unbounded retry loops, unbounded `while(true)` agent loops, and system prompts that get re-billed on every loop iteration instead of being sent once.

## What this does — and doesn't do

This is a local, static scanner. It reads your source code and flags three deterministic, well-defined patterns via AST analysis — it does not call any LLM, does not read your API keys, and does not send your code anywhere.

Every dollar figure this tool prints is a **worst-case exposure ceiling**, computed from real, dated model pricing (see [`src/pricing.ts`](./src/pricing.ts) for the exact table and its last-verified date) — never a claimed historical loss. Where an input to that math is an assumption rather than a measured fact (call latency, since a static scanner can't observe a real request), the output says so explicitly. Where a real number is available — the exact token count of a system prompt literal found in your code — it uses that instead of a guess.

## Install

```bash
npx valta-leak ./src
```

Or install globally:

```bash
npm install -g valta-leak
valta-leak ./src
```

## What it checks

| Check | What it flags |
|---|---|
| Hardcoded API keys | A literal `sk-...` / `sk-ant-...` / `sk-proj-...` key committed in source |
| Missing backoff | A `catch` block (or `.catch()`) that retries an LLM SDK call with no exponential backoff or sleep interval — escalated to FAIL when the retry is genuinely self-recursive with no attempt limit |
| Unbounded agent loops | A `while (true)` / `for (;;)` loop (or self-recursive function) calling an LLM SDK method with no hard step/iteration ceiling, timeout, or `AbortController` |
| Token leakage | A system prompt string/template literal declared inside a loop body instead of hoisted out — its real, exact token count (not an estimate) is billed again every iteration |

## Example output

```
[FAIL] Unbounded recursive retry loop calling an LLM SDK method
       -> File: src/agents/researcher.ts:8
       -> Risk: If the API call fails, "researcher" retries itself immediately
                with no exponential backoff or sleep interval — this will fire
                continuously on any transient error.
       -> Maximum Exposure: ~$97.20 / hour
       -> Basis: Assumes ~500 input / 150 output tokens per call and 1.5s
                 latency. Pricing snapshot: 2026-07-12.

[valta-leak] Analysis complete. 1 structural cost vulnerability found (1 unbounded, 0 advisory).
Documentation on mitigating automated loop exposure: https://valta.co
```

## Options

```
valta-leak [dir]      Directory to scan (default: current directory)
  --json               Output findings as JSON instead of a formatted report
```

Exit code is `1` if any FAIL-severity finding was detected, `0` otherwise — safe to wire into CI.

## License

MIT.
