# Assistant eval

Runs the real assistant code (chat controller, turn machine, tool runner, system prompt, OpenRouter client) in Node
against a real model, over 25 scenarios. The engine is fake and deterministic (4 transfers, 1.1 GB free); every
engine action is recorded, never real. Search uses the real providers over Node's `fetch`.

Setup: create `.env.local` (gitignored) at the repo root with `OPENROUTER_API_KEY=<your key>`.

```
npm run eval:assistant                       # all 25
node scripts/eval-assistant/run.js --only 1,5,9
node scripts/eval-assistant/run.js --fake    # scripted model, canned search, no network, no key
node scripts/eval-assistant/run.js --only 16,19,22 --model openai/gpt-5-nano   # a subset on another model
node scripts/eval-assistant/run.js --gap 8   # seconds between model requests (default 4)
MAGLEV_EVAL_MODEL=openai/gpt-5-nano node scripts/eval-assistant/run.js   # same as --model; the flag wins
```

Default model is `meta-llama/llama-3.3-70b-instruct:free`. Free models allow about 20 requests a minute and about
50 a day on accounts under $10 credit, so requests are spaced 4 s apart and a 429 is retried once, then the
scenario is marked `rate_limited`. Each scenario costs about 2 to 5 requests (one per model step; follow-up scenarios use more), so a full run of
25 uses roughly 60 to 100. A free account's daily cap can run out part-way: run a subset with `--only`. The count
is printed at the end.

`rate_limited` means the model refused requests with a 429 even after the retry (or the chat showed "Rate
limited"). That scenario is not scored: its checks are skipped and it is counted as "rate limited", not as a
failure. Re-run those ids later with `--only`.

Output: `scripts/eval-assistant/out/<timestamp>/` with `<id>.json` (all chat items, tool calls with args and result
truncated to 2 KB, engine actions, checks, request count, latency) and `summary.md`. The key is never written.

Scenario 10 runs with 20 GB free. With 1.1 GB free and an unfinished download, the app refuses every add for space.
Fake search rows go through the real tool runner and scorer; a scenario can set its own rows with `fixture`. Checks live in `scenarios.js`; the same file holds the scripted answers used by `--fake`.
