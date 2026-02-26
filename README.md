# copilot-api-next

> [!WARNING]
> This is a reverse-engineered proxy of GitHub Copilot API. It is not supported by GitHub, and may break unexpectedly. Use at your own risk.

> [!WARNING]
> **GitHub Security Notice:**
> Excessive automated or scripted use of Copilot (including rapid or bulk requests, such as via automated tools) may trigger GitHub’s abuse-detection systems.
> You may receive a warning from GitHub Security, and further anomalous activity could result in temporary suspension of your Copilot access.
>
> GitHub prohibits use of their servers for excessive automated bulk activity or any activity that places undue burden on their infrastructure.
>
> Please review:
> - [GitHub Acceptable Use Policies](https://docs.github.com/site-policy/acceptable-use-policies/github-acceptable-use-policies#4-spam-and-inauthentic-activity-on-github)
> - [GitHub Copilot Terms](https://docs.github.com/site-policy/github-terms/github-terms-for-additional-products-and-features#github-copilot)
>
> Use this proxy responsibly to avoid account restrictions.

Turn your GitHub Copilot subscription into an **OpenAI / Anthropic API** compatible server. Works seamlessly with [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and any tool that speaks the OpenAI or Anthropic protocol.

> [!NOTE]
> [中文文档](./README.zh-CN.md)

## Features

- **Multi-protocol** — OpenAI (`/chat/completions`, `/responses`, `/models`, `/embeddings`) + Anthropic (`/v1/messages`) with full streaming
- **Smart routing & billing optimization** — Auto-selects best Copilot backend per model; subagent detection, compact/warmup routing, tool_result merging to minimize premium quota usage
- **Auto token management** — GitHub OAuth Device Flow + Copilot token auto-refresh
- **Secure & configurable** — Optional API key auth, rate limiting, `--small-fast-model` for lightweight requests
- **Lightweight & portable** — ~70 kB bundle, Node.js ≥ 24, auto-detects writable home dir (serverless-friendly)

## Quick Start

### Install & Run

```bash
# Install dependencies
pnpm install

# Start the server (production)
pnpm start

# Or install globally from npm
npm install -g @ziuchen/copilot-api-next
copilot-api-next start
```

On first launch, you'll be guided through GitHub OAuth Device Flow to authenticate.

### Development

```bash
pnpm run dev                  # Watch mode (tsdown --watch + auto-run)
pnpm run build                # Build with tsdown
pnpm run lint                 # ESLint
pnpm run typecheck             # TypeScript check
```

## Usage

### Start the Server

```bash
copilot-api-next start [options]
```

| Option | Alias | Default | Description |
|--------|-------|---------|-------------|
| `--port` | `-p` | `4141` | Port to listen on |
| `--verbose` | `-v` | `false` | Enable verbose logging |
| `--account-type` | `-a` | `individual` | Copilot plan (`individual`, `business`, `enterprise`) |
| `--rate-limit` | `-r` | — | Minimum seconds between requests |
| `--wait` | `-w` | `false` | Wait instead of 429 when rate-limited |
| `--github-token` | `-g` | — | Provide GitHub token directly |
| `--show-token` | | `false` | Show tokens in log output |
| `--api-key` | | — | API key(s) for authentication (repeat for multiple) |
| `--small-fast-model` | | — | Model for lightweight tasks (warmup, compact). Saves premium quota |

### Authentication

```bash
# First-time setup (also happens on `start` if not logged in)
copilot-api-next auth

# Force re-authenticate
copilot-api-next auth --force
```

### API Key Protection

Protect your endpoint with one or more API keys:

```bash
copilot-api-next start --api-key sk-my-secret-key
copilot-api-next start --api-key key1 --api-key key2
```

Clients authenticate via:
- `Authorization: Bearer <key>` (OpenAI compatible)
- `x-api-key: <key>` (Anthropic compatible)

When no `--api-key` is provided, the server runs in open mode (no auth required).

### Small-Fast-Model

Route warmup and compact (context summarization) requests to a cheaper model:

```bash
copilot-api-next start --small-fast-model gpt-4o-mini
```

When `--small-fast-model` is set and the target model is available, those lightweight requests use it instead of the premium model. When not set, all requests use the original model.

### Use with Claude Code

```bash
export ANTHROPIC_BASE_URL=http://localhost:4141
export ANTHROPIC_AUTH_TOKEN=dummy    # or your --api-key if set
claude
```

### Use with OpenCode

```bash
export OPENAI_BASE_URL=http://localhost:4141/v1
export OPENAI_API_KEY=dummy          # or your --api-key if set
opencode
```

### API Endpoints

| Endpoint | Method | Protocol | Description |
|----------|--------|----------|-------------|
| `/` | GET | — | Health check |
| `/chat/completions` | POST | OpenAI | Chat completions |
| `/models` | GET | OpenAI | List available models |
| `/embeddings` | POST | OpenAI | Text embeddings |
| `/responses` | POST | OpenAI | Responses API (native forwarding) |
| `/v1/chat/completions` | POST | OpenAI | Chat completions (v1 prefix) |
| `/v1/models` | GET | OpenAI | List models (v1 prefix) |
| `/v1/embeddings` | POST | OpenAI | Embeddings (v1 prefix) |
| `/v1/responses` | POST | OpenAI | Responses API (v1 prefix) |
| `/v1/messages` | POST | Anthropic | Messages API (streaming & non-streaming) |
| `/usage` | GET | Custom | Copilot quota usage |
| `/token` | GET | Custom | Current Copilot token |

## Improvements over [ericc-ch/copilot-api](https://github.com/ericc-ch/copilot-api)

This project is a clean-room reimplementation inspired by the original `ericc-ch/copilot-api` and its forks. Key improvements:

### API Key Authentication

Added `--api-key` option to protect the server from unauthorized access. Supports multiple keys, both OpenAI (`Bearer`) and Anthropic (`x-api-key`) header formats, and uses constant-time comparison to prevent timing attacks. When no keys are configured, the server remains open for backward compatibility.

### Simplified Architecture

- Removed manual approval system (`--manual`) — not practical for automated clients
- Removed clipboard integration (`clipboardy`) and interactive model selection (`--claude-code`)
- Removed HTTP proxy support (`undici` / `proxy-from-env`) — can be handled at the OS level
- Removed token counting dependency (`gpt-tokenizer`) — reduces bundle size
- No `tiny-invariant` or `zod` dependencies — plain TypeScript suffices

### Cleaner Codebase

- Flat, minimal file structure with clear separation of concerns
- All routes registered directly in `server.ts` instead of scattered sub-routers
- Zero lint warnings, zero type errors out of the box
- Modern tooling: `tsdown` for building, flat ESLint config

### Leaner Bundle

~70 kB total bundle (vs. significantly larger in the original due to `gpt-tokenizer`, `zod`, `undici`, etc.)

### Smart Routing & Billing Optimization

Ported from [caozhiyuan/copilot-api](https://github.com/caozhiyuan/copilot-api) `all` branch:

- **3-way smart routing** for `/v1/messages`: automatically routes to native Messages API, Responses API, or Chat Completions based on model `supported_endpoints`
- **Responses API** (`/responses`, `/v1/responses`): native forwarding with stream ID synchronization for @ai-sdk/openai compatibility
- **Subagent marker detection**: parses `__SUBAGENT_MARKER__` from Claude Code to avoid consuming premium request credits
- **Compact/warmup optimization**: detects context summarization and warmup requests, routes to `--small-fast-model` when set
- **Tool result merging**: merges `tool_result` + `text` blocks to avoid duplicate billing from skill invocations
- **Codex phase support**: handles `commentary` / `final_answer` phases for gpt-5.3-codex
- **API version upgrade**: Copilot v0.37.6, API v2025-10-01, `openai-intent: conversation-agent`

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | [Node.js](https://nodejs.org) ≥ 24 |
| Framework | [Hono](https://hono.dev) |
| HTTP Server | [srvx](https://srvx.unjs.io) |
| CLI | [citty](https://github.com/unjs/citty) |
| Build | [tsdown](https://github.com/nicolo-ribaudo/tsdown) |
| Lint | [ESLint](https://eslint.org) + [typescript-eslint](https://typescript-eslint.io) |

## License

MIT
