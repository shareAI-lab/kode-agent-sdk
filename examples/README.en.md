# KODE SDK Examples

A collection of KODE SDK usage examples.

## Quick Start

```bash
# From the repository root; examples need no separate dependency installation
npm ci
npm run build
npm run example:getting-started -- --mock

# Real model (makes actual API requests)
export ANTHROPIC_API_KEY=your-api-key
npm run example:getting-started
```

Requires Node.js 20.18.1–20.x or 22.x–25.x. `--mock` does not load `.env`, read credentials or use the network. Build first, then run `npm run typecheck:examples` to check all examples. Commands in the table below run from `examples/`, using the root installation and local package. Corresponding `example:*` scripts also run from the root.

## Environment Variables

Configure the required environment variables based on the examples you want to run:

```bash
# Anthropic (Claude)
export ANTHROPIC_API_KEY=your-key
export ANTHROPIC_BASE_URL=https://api.anthropic.com  # optional
export ANTHROPIC_MODEL_ID=claude-sonnet-4-20250514   # optional

# OpenAI
export OPENAI_API_KEY=your-key
export OPENAI_BASE_URL=https://api.openai.com/v1     # optional
export OPENAI_MODEL_ID=gpt-4o                        # optional

# Gemini
export GEMINI_API_KEY=your-key
export GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta  # optional
export GEMINI_MODEL_ID=gemini-2.0-flash              # optional

# E2B Cloud Sandbox
export E2B_API_KEY=your-key

# PostgreSQL (for db-postgres example)
export POSTGRES_HOST=localhost
export POSTGRES_PORT=5432
export POSTGRES_DB=kode_agents
export POSTGRES_USER=kode
export POSTGRES_PASSWORD=your-password
```

## Examples

| Example | Description | Command |
|---------|-------------|---------|
| getting-started | Getting started guide | `npm run getting-started` |
| opensandbox | OpenSandbox self-hosted sandbox | `npm run opensandbox` |
| e2b-usage | E2B cloud sandbox | `npm run e2b -- basic` |
| agent-inbox | Agent inbox pattern | `npm run agent-inbox` |
| approval | Permission approval control | `npm run approval` |
| room | Multi-agent collaboration | `npm run room` |
| scheduler | Scheduler and file watching | `npm run scheduler` |
| db-sqlite | SQLite persistence | `npm run db-sqlite` |
| db-postgres | PostgreSQL persistence | `npm run db-postgres` |
| anthropic | Anthropic Provider | `npm run anthropic` |
| openai | OpenAI Provider | `npm run openai` |
| gemini | Gemini Provider | `npm run gemini` |
| openrouter | OpenRouter example | `npm run openrouter` |
| openrouter-stream | OpenRouter streaming | `npm run openrouter-stream` |
| openrouter-agent | OpenRouter Agent integration | `npm run openrouter-agent` |
| nextjs | Next.js API route integration | `npm run nextjs` |

## E2B Cloud Sandbox Example

```bash
# Show help
npm run e2b

# Run basic example
npm run e2b -- basic

# Run template example
npm run e2b -- template

# Run Agent integration example
npm run e2b -- agent

# Run all
npm run e2b -- all
```

## Directory Structure

```
examples/
├── shared/           # Shared utility modules
│   ├── load-env.ts   # Environment variable loader
│   ├── runtime.ts    # Agent runtime creator
│   └── demo-model.ts # Demo model configuration
├── tooling/          # Tool-related examples
├── *.ts              # Feature examples
├── package.json      # Dependencies
└── tsconfig.json     # TypeScript configuration
```

## Notes

1. Ensure required API keys are configured before running
2. Some examples require network access to external APIs
3. The db-postgres example requires a running PostgreSQL database
4. E2B examples require an E2B account and API key
