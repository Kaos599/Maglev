# Assistant eval

Runs the real assistant code (chat controller, turn machine, tool runner, system prompt, OpenRouter client) in Node
against a real model, over 15 scenarios. The engine is fake and deterministic (4 transfers, 1.1 GB free); every
engine action is recorded, never real. Search uses the real providers over Node's `fetch`.

Setup: create `.env.local` (gitignored) at the repo root with `OPENROUTER_API_KEY=<your key>`.

```
npm run eval:assistant                       # all 15
node scripts/eval-assistant/run.js --only 1,5,9
node scripts/eval-assistant/run.js --fake    # scripted model, canned search, no network, no key
MAGLEV_EVAL_MODEL=openai/gpt-5-nano node scripts/eval-assistant/run.js
```

Default model is `meta-llama/llama-3.3-70b-instruct:free`. Free models allow about 20 requests a minute and about
50 a day on accounts under $10 credit, so requests are spaced 4 s apart and a 429 is retried once, then the
scenario is marked `rate_limited`. A full run uses roughly 30 to 45 requests. The count is printed at the end.

Output: `scripts/eval-assistant/out/<timestamp>/` with `<id>.json` (all chat items, tool calls with args and result
truncated to 2 KB, engine actions, checks, request count, latency) and `summary.md`. The key is never written.

Scenario 10 runs with 20 GB free. With 1.1 GB free and an unfinished download, the app refuses every add for space.
Scenario 15 is record only. Checks live in `scenarios.js`; the same file holds the scripted answers used by `--fake`.
