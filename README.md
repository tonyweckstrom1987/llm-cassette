**English** | [Suomi](README.fi.md)

# llm-cassette

[![CI](https://github.com/tonyweckstrom1987/llm-cassette/actions/workflows/ci.yml/badge.svg)](https://github.com/tonyweckstrom1987/llm-cassette/actions/workflows/ci.yml) ![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

Record the responses of your LLM calls once and replay them in tests. Tests become fast, free and stable in CI, and they need no API key.

Record/replay for `fetch`-based LLM clients (VCR-style). It wraps `fetch`, stores responses in a JSON file, and replays them in tests. Default mode is `replay`, which never touches the network. Request headers (e.g. `Authorization`) are never stored.

**Tech:** TypeScript, Node.js 22/24, vitest. No runtime dependencies.

## Installation

```bash
npm install --save-dev @tonyweckstrom/llm-cassette
```

Node 22.12+ or 24. No runtime dependencies. (The name is scoped because `llm-cassette` is already published on npm by someone else: it is a different tool.)

## Usage

```ts
import { cassetteFetch } from "@tonyweckstrom/llm-cassette";

const fetchWithCassette = cassetteFetch({ path: "test/cassettes/general.json" });

// Give this to your LLM client as its fetch function:
const res = await fetchWithCassette("https://litellm.local/v1/chat/completions", {
  method: "POST",
  headers: { authorization: `Bearer ${process.env.LLM_API_KEY}` },
  body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "Hi" }] }),
});
```

Recording needs `record` mode (the default `replay` mode throws `CassetteMissError` when there is no recording). After that, runs replay the recorded responses:

```bash
LLM_CASSETTE_MODE=record npm test   # once, with a real key: records into the cassette
npm test                            # normally: replays, no network
```

Commit the cassette files to the repository. CI then replays the same responses at no cost.

## Modes

| Mode | What it does |
| --- | --- |
| `replay` (default) | Replays the recording. If there is no recording, throws `CassetteMissError`. Never uses the network. |
| `record` | Calls the real `fetch` and records the response. Replaces earlier recordings of the same request and keeps the others. |
| `auto` | Replays if a recording exists, otherwise calls the real `fetch` and records. Handy during development; in CI use `replay`. |

The mode is chosen with the `mode` option or the `LLM_CASSETTE_MODE` environment variable. Without either, the mode is `replay`, so a forgotten setting never causes paid calls.

## Options

| Option | Meaning |
| --- | --- |
| `path` | Path of the cassette file (JSON). The directory is created if needed. |
| `mode` | `replay`, `record` or `auto` (see above). |
| `fetch` | The real `fetch` used for recording (default `globalThis.fetch`). |
| `ignoreBodyKeys` | Top-level fields of the JSON body that are left out when identifying a request (e.g. `["user"]` if the value changes from run to run). |

## How a request is identified

A recording is found by the HTTP method, the URL and the JSON body. The order of JSON fields does not matter. Headers do not matter, so changing the API key does not break recordings. If the same request has been recorded several times (e.g. a retry), the responses are replayed in the recorded order and the last one repeats after that.

## Security

- Request headers (e.g. `Authorization`) are **never stored** and are not used to compute the identifier. Of the responses, only `content-type` is stored.
- The request body (the prompt) **is stored**, so that the cassette can be read and reviewed. Do not put secrets or personal data in test prompts.
- Review the cassette before committing: response bodies are not filtered.

## Alternatives and why this one

Situation on 16 October 2026. There are other tools for recording and replaying LLM calls:

- Another developer's npm package named `llm-cassette` (called llm-vcr in its README) records and replays LLM calls in tests, supports streaming and fuzzy request matching, and hooks into tests globally (it uses the `msw` library).
- [`@copilotkit/aimock`](https://www.npmjs.com/package/@copilotkit/aimock) is broad mock infrastructure for testing AI applications: a local server that answers on behalf of many providers, plus recording and replay.
- [`@pollyjs/core`](https://www.npmjs.com/package/@pollyjs/core) is general-purpose HTTP recording and replay (not LLM-specific).

llm-cassette is deliberately small and explicit, if you need just one thing: replaying recorded responses for a `fetch`-based LLM client without a network. The differences:

- **No global hooking:** you pass `cassetteFetch` to your client as its `fetch` function. Nothing changes by itself.
- **Zero runtime dependencies**, and the whole implementation is a single source file.
- **Safe default:** the default mode is `replay`, which never uses the network, so a forgotten setting cannot cause paid calls.
- **Headers are not stored** (e.g. `Authorization`) and are not used to compute the identifier.

If you need streaming (`stream: true`) or fuzzy matching, use one of the tools above: this tool does not support them.

## Limitations

- Only a string body (JSON) is supported in requests. Streaming (`stream: true`) is not supported: the response body is read in full and replayed at once.
- Network errors (e.g. a dropped connection) are not recorded. HTTP error responses (e.g. 429, 503) are recorded with their status, so you can use them to test fallback-model and retry logic.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
```
