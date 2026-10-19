# valta-leak

A small static scanner that looks for code patterns that can turn an LLM agent into a surprise bill: retry loops with no backoff, agent loops with no ceiling, and big system prompts that get re-sent on every iteration.

It runs locally on your source code. It does not call any LLM, does not read your API keys, and does not send your code anywhere.

```
npx valta-leak ./src
```

## Why this exists

A `while (true)` agent loop that waits for the model to say "done" works fine until the day the model never says it. A `catch` block that immediately calls the API again works fine until the provider has a bad hour. Both cost nothing in testing and a lot in production, and neither is visible in a code review unless someone is looking for it.

valta-leak looks for those specific shapes and tells you where they are.

## Install

```
npx valta-leak ./src
```

Or install it globally:

```
npm install -g valta-leak
valta-leak ./src
```

Requires Node 18 or newer.

## What it checks

| Check | What it flags |
| --- | --- |
| Unbounded agent loop | A `while (true)` or `for (;;)` loop that calls an LLM SDK method and shows no step limit, timeout, or `AbortController` in the loop body. |
| Retry with no backoff | A `catch` block (or `.catch()` handler) that retries an LLM SDK call with no `setTimeout`, `sleep`, `delay`, or backoff. Reported as FAIL when the function calls itself recursively; reported as WARN when it just makes a second call inline. |
| Large system prompt in a loop | A static system prompt of 300+ tokens declared inside a loop, so it is sent and billed again on every iteration. The token count is measured from the actual text. |
| Hardcoded API key | A literal `sk-...`, `sk-ant-...`, or `sk-proj-...` string in source. |

## Example output

```
[FAIL] Unbounded recursive retry loop calling an LLM SDK method
       -> File: src/agents/researcher.ts:8
       -> Risk: If the API call fails, "researcher" retries itself immediately
                with no exponential backoff or sleep interval.
       -> Maximum Exposure: ~$97.20 / hour
       -> Basis: Assumes ~500 input / 150 output tokens per call and 1.5s
                 latency. Pricing snapshot: 2026-07-12.

[valta-leak] Analysis complete. 1 structural cost vulnerability found.
```

## About the dollar figures

The "Maximum Exposure" number is a worst-case ceiling, not a prediction and not a measurement of any real loss. It is calculated as:

```
cost per call  x  calls per hour at an assumed latency
```

- Token counts per call are assumptions (about 500 input and 150 output) unless the tool can measure a real number, which it can only do for a static system prompt.
- Latency is an assumption, because a static scanner cannot observe a real request.
- Prices come from a dated table in [`src/pricing.ts`](src/pricing.ts). Every finding prints the snapshot date. If the model name in your code isn't in the table, the tool uses a mid-range fallback price and says so in the output.

Read the number as "roughly how bad could this get if it ran flat out," not as "this is what it costs you."

## Options

```
valta-leak [dir]      Directory to scan (default: current directory)
  --json              Output findings as JSON instead of a formatted report
```

In the default output mode the exit code is `1` if any FAIL finding was detected and `0` otherwise, so it can be used as a CI check. node_modules, dist, build, and .next are skipped.

## Limitations

Please read these before trusting a result.

- **JavaScript and TypeScript only.** Python agents (LangChain, CrewAI and so on) are not scanned.
- **It only recognizes a few call shapes:** `.messages.create(...)`, `.chat.completions.create(...)` and `.completions.create(...)`. Other SDKs and wrappers, such as the Vercel AI SDK, LangChain's `.invoke`, Gemini's `.generateContent`, or raw `fetch` calls, are not detected yet.
- **It only recognizes two loop shapes:** `while (true)` and `for (;;)`. Loops like `while (!done)`, `do...while`, and recursion-based agents are not covered.
- **It is a heuristic, not a proof.** Whether a loop is "bounded" is decided by looking for patterns in the loop's text, such as a `maxSteps` style name, a step comparison, or an `AbortController`. This means:
  - a normal tool-use loop that exits when the model stops calling tools can be flagged even though it terminates in practice, and
  - a limit that exists somewhere the tool can't see, such as in a wrapper or a shared helper, can be missed.
- **Tests, examples and fixtures are scanned too,** so you may want to point it at your `src` directory rather than the repo root.
- **The pricing table is a snapshot** and will lag behind provider changes. Pull requests that update it are welcome.

If you get a false positive or a miss, please open an issue with a minimal snippet. That is the most useful thing you can do for this project right now.

## Development

```
git clone https://github.com/Valta-hq/valta-leak
cd valta-leak
npm install
npm run build
npm test
```

The detectors live in `src/detectors/`, and the test fixtures are in `test/fixtures/`.

## What this is part of

valta-leak is made by the team behind [Valta](https://valta.co), which enforces spend limits on AI agents at runtime instead of finding the risky code beforehand. You do not need Valta to use this tool, and valta-leak does not talk to it.

## License

MIT
