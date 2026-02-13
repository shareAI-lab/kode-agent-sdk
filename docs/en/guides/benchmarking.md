# Benchmarking Guide

KODE SDK includes an integrated benchmark suite for evaluating LLM model capabilities in agent scenarios. The suite implements two industry-standard methodologies:

- **SWE-bench** (Princeton/OpenAI) — Code bug-fixing: model receives an issue description + source code, generates a fix, tests verify correctness
- **τ-bench** (Sierra Research) — Multi-turn tool-use conversations: model acts as a customer service agent, uses tools, follows policy, and the final database state is evaluated

---

## Prerequisites

1. **Provider configuration** in `.env.test` — at least one provider with `API_KEY` and `MODEL_ID` configured. See [Provider Configuration Guide](./providers.md) for details.

2. **Node.js** with `ts-node` available (included in devDependencies).

3. **(Optional) Docker** — required only for SWE-bench full mode. Mini mode and TAU benchmarks run without Docker.

### Minimal `.env.test` Setup

```ini
# At least one provider is required
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL_ID=claude-sonnet-4-5-20250929

# Optional: additional providers to compare
OPENAI_API_KEY=sk-...
OPENAI_MODEL_ID=gpt-4o

GEMINI_API_KEY=AIza...
GEMINI_MODEL_ID=gemini-2.5-pro
```

---

## Quick Start

```bash
# Run all benchmarks (SWE mini + TAU airline + TAU retail)
npm run test:benchmark

# Run only SWE benchmark
npm run test:benchmark -- --swe-only

# Run SWE full mode (requires Docker)
npm run test:benchmark -- --swe-only --swe-mode=full

# Run only TAU benchmark
npm run test:benchmark -- --tau-only

# Run with a specific provider
npm run test:benchmark -- --provider=anthropic

# Output JSON report
npm run test:benchmark -- --output=json --output-file=results.json
```

> **Note:** Every benchmark run automatically generates an HTML visual report at `tests/tmp/benchmark-report-{timestamp}.html`. Open it in a browser to view detailed results with scores, charts, and per-case breakdowns.

---

## SWE Benchmark

The SWE benchmark evaluates a model's ability to fix bugs in source code. The model receives a bug description and the project files, then generates corrected code that must pass all tests.

### Mini Mode (Default)

Mini mode uses 20 built-in JavaScript bug-fix cases that run locally without Docker. Each case contains:
- A buggy `src.js` file
- A `test.js` file with assertions
- A bug description explaining the expected behavior

```bash
# Run mini-SWE benchmark
npm run test:benchmark -- --swe-only --swe-mode=mini
```

**Example output:**

```
  SWE mini mode: 20 cases

  Running provider: anthropic / claude-sonnet-4-5-20250929
    [anthropic] mini-swe-001: PASS (1772 tokens, 13186ms)
    [anthropic] mini-swe-002: PASS (1246 tokens, 12162ms)
    ...

--- SWE-bench (mini-swe) — 20 instances ---

Provider / Model                     | Resolved |    Rate | Avg Tokens |   Avg ms
-------------------------------------+----------+---------+------------+---------
anthropic / claude-sonnet-4-5-20250… |    20/20 |  100.0% |       1.0k |     7.4k
```

**Core metric:** `Resolved Rate` — the percentage of cases where the model's fix passes all tests.

### Full Mode (Docker)

Full mode uses real SWE-bench instances from open-source repositories. It evaluates model-generated patches using official pre-built SWE-bench Docker images from DockerHub.

```bash
# Run full SWE-bench (requires Docker)
npm run test:benchmark -- --swe-only --swe-mode=full
```

The evaluator:
1. Clones the repository on the host and checks out the specified commit
2. Extracts relevant file paths from the problem statement and hints
3. Reads source files and sends them to the LLM along with the bug description
4. The LLM returns SEARCH/REPLACE blocks for the changed code sections
5. The framework applies the hunks and programmatically generates a unified diff
6. Pulls the official SWE-bench Docker image (`swebench/sweb.eval.x86_64.<instance>:latest`)
7. The container already has the repo at `/testbed` with all dependencies installed in a `testbed` conda environment
8. Applies the patch and runs the repository's test suite

When Docker is not available, it falls back to local git clone + patch application (less reliable due to missing dependencies).

The curated instances are defined in `tests/benchmark/swe/cases/curated-instances.json`.

> **Note:** SWE-bench images are large (several GB each). The first run will take longer as images are downloaded. Subsequent runs reuse cached images. Configure `BENCHMARK_DOCKER_PROXY` if you need a proxy for Docker pulls.

---

## TAU Benchmark

The TAU benchmark (Tool-Agent-User) evaluates a model's ability to handle multi-turn customer service conversations while using tools correctly and following business policies.

### Architecture

```
Orchestrator
├── Agent (model under test) — receives user messages, calls tools, follows policy
├── User Simulator (LLM) — plays the customer role based on a scenario script
└── Environment — executes tool calls, maintains database state
```

**Evaluation:** After the conversation ends, the final database state is compared against the expected state. A task passes only if all expected fields match.

### Available Domains

| Domain | Tasks | Tools | Description |
|--------|-------|-------|-------------|
| `airline` | 5 | 7 | Flight changes, cancellations, baggage inquiries |
| `retail` | 5 | 8 | Returns, exchanges, order status, product search |

### Running TAU Benchmarks

```bash
# Run all TAU domains
npm run test:benchmark -- --tau-only

# Run specific domain
npm run test:benchmark -- --tau-only --tau-domain=airline
npm run test:benchmark -- --tau-only --tau-domain=retail

# Run with multiple trials (for pass^k reliability metric)
npm run test:benchmark -- --tau-only --num-trials=3
```

**Example output:**

```
  TAU domain: airline (5 tasks, 1 trials)

  Running provider: anthropic / claude-sonnet-4-5-20250929
  User simulator:   anthropic / claude-sonnet-4-5-20250929
    [anthropic] airline_001 trial 1/1: PASS (5 turns, 22341 tokens)
    [anthropic] airline_002 trial 1/1: PASS (3 turns, 15280 tokens)
    ...

--- TAU-bench (airline) — 5 tasks, 1 trials ---

Provider / Model                     |  Pass^1 | Avg Tokens
-------------------------------------+---------+-----------
anthropic / claude-sonnet-4-5-20250… |   80.0% |      18.1k
```

### Understanding pass^k

The **pass^k** metric measures reliability across multiple independent trials of the same task:

- **pass^1** = fraction of tasks passed in a single trial
- **pass^k** = fraction of tasks that passed in ALL k independent trials

This captures consistency — a model with 80% pass^1 but 40% pass^3 is unreliable. Use `--num-trials=k` to compute pass^k.

### User Simulator

By default, the same model is used for both the agent and the user simulator. To use a different model for user simulation:

```ini
# In .env.test
BENCHMARK_USER_MODEL=anthropic/claude-sonnet-4-5-20250929
```

Format: `provider/model-id`.

---

## CLI Reference

All flags are passed after `--` to the npm script:

```bash
npm run test:benchmark -- [flags]
```

| Flag | Description | Default |
|------|-------------|---------|
| `--swe-only` | Run only SWE benchmarks | (run both) |
| `--tau-only` | Run only TAU benchmarks | (run both) |
| `--swe-mode=mini\|full` | SWE evaluation mode | `mini` |
| `--tau-domain=airline\|retail\|all` | TAU domain to evaluate | `all` |
| `--provider=NAME` | Run only the specified provider | (all configured) |
| `--num-trials=N` | Number of TAU trials per task (for pass^k) | `1` |
| `--output=table\|json\|html\|both` | Output format | `table` |
| `--output-file=PATH` | JSON/HTML report output path | `benchmark-report.json` |
| `--compare=PATH` | Compare current run against a baseline JSON report | (none) |

---

## Environment Variables

These can be set in `.env.test` alongside provider configuration:

| Variable | Description | Default |
|----------|-------------|---------|
| `BENCHMARK_PROVIDERS` | Comma-separated list of providers to run | (all configured) |
| `BENCHMARK_TIMEOUT_MS` | Timeout per task in milliseconds | `120000` |
| `BENCHMARK_NUM_TRIALS` | Default number of TAU trials | `1` |
| `BENCHMARK_OUTPUT` | Output format | `table` |
| `BENCHMARK_USER_MODEL` | User simulator model (`provider/model`) | (same as agent) |
| `BENCHMARK_DOCKER_PROXY` | HTTP proxy URL for Docker containers and git clone | (none) |

CLI flags override environment variables when both are set.

---

## Historical Comparison

Save a baseline report and compare future runs against it to detect regressions:

```bash
# 1. Save a baseline
npm run test:benchmark -- --output=json --output-file=baseline.json

# 2. Later, compare a new run against the baseline
npm run test:benchmark -- --compare=baseline.json
```

The comparison output shows changes in key metrics with direction indicators:

```
================================================================================
Benchmark Comparison
================================================================================
  Baseline:  baseline.json
  Current:   (current run)

--- SWE Comparison ---

Metric                                 |   Baseline |    Current |        Delta | Dir
---------------------------------------------------------------------------------
anthropic/claude-sonnet-4-5 [rate]     |     100.0% |     100.0% |            = |
anthropic/claude-sonnet-4-5 [resolved] |      20/20 |      20/20 |            = |
anthropic/claude-sonnet-4-5 [tokens]   |       1.0k |        986 |          -45 | ^

  No regressions detected.
```

- `^` = improvement (higher rate, lower tokens/latency)
- `v` = regression (lower rate, higher tokens/latency)
- Exit code is `1` if regressions are detected

---

## JSON Report Format

When using `--output=json` or `--output=both`, a JSON report is written:

```json
{
  "timestamp": "2026-02-12T10:30:00.000Z",
  "sdk_version": "2.7.3",
  "swe": [{
    "provider": { "id": "anthropic", "model": "claude-sonnet-4-5-20250929", "apiKey": "***" },
    "summary": {
      "dataset": "mini-swe",
      "total": 20,
      "resolved": 20,
      "rate": 1.0,
      "avg_tokens": 1031,
      "avg_duration_ms": 7420
    },
    "results": [
      { "instance_id": "mini-swe-001", "resolved": true, "tokens_used": 1772, "duration_ms": 13186 }
    ]
  }],
  "tau": [{
    "provider": { "id": "anthropic", "model": "claude-sonnet-4-5-20250929", "apiKey": "***" },
    "summary": {
      "domain": "airline",
      "total_tasks": 5,
      "num_trials": 1,
      "pass_at_k": [0.8],
      "avg_tokens": 18100
    },
    "results": [
      { "task_id": "airline_001", "trial_pass_rates": [true], "tokens_used": 22341 }
    ]
  }]
}
```

API keys are automatically redacted to `"***"` in the output.

---

## HTML Visual Report

Every benchmark run automatically generates a self-contained HTML report at `tests/tmp/benchmark-report-{timestamp}.html` (this directory is in `.gitignore`). The report includes:

- **Overall Score** — A weighted composite score (0–100) displayed as a circular progress ring:
  - SWE Resolved Rate × 60% + TAU Pass^1 × 40%
  - If only one benchmark type runs, it gets 100% weight
  - Color-coded: green (≥90 Excellent), yellow (≥70 Good), orange (≥50 Fair), red (<50 Poor)
- **Configuration Summary** — SDK version, providers, SWE mode, TAU domain, timeout, trials
- **SWE Results** — Summary table, resolved rate bar chart, and expandable per-case details (pass/fail, tokens, duration)
- **TAU Results** — Summary table with Pass^k columns, pass rate bar chart, and expandable per-task trial details

### Viewing the Report

```bash
# Run benchmarks (HTML report is generated automatically)
npm run test:benchmark -- --provider=anthropic

# Serve with Python's built-in HTTP server
cd tests/tmp && python3 -m http.server 8080
# Open http://localhost:8080/benchmark-report.html
```

The report is a single file with all CSS inlined — no external dependencies. You can also open it directly in a browser via `file://` protocol.

---

## Project Structure

```
tests/benchmark/
├── run-benchmark.ts          # Entry point
├── config.ts                 # CLI + env config loading
├── types.ts                  # Shared type definitions
├── reporter.ts               # Table + JSON output
├── html-reporter.ts          # HTML visual report generator
├── compare.ts                # Historical report comparison
│
├── swe/                      # SWE-bench module
│   ├── index.ts              # Module entry (mini + full mode routing)
│   ├── dataset.ts            # Case/instance loading
│   ├── harness.ts            # Model interaction (mini mode)
│   ├── evaluator.ts          # Local test execution (mini mode)
│   ├── docker-evaluator.ts   # Docker/git evaluation (full mode)
│   └── cases/
│       ├── mini-cases.json       # 20 JavaScript bug-fix cases
│       └── curated-instances.json # SWE-bench instance definitions
│
└── tau/                      # TAU-bench module
    ├── index.ts              # Module entry (domain discovery + orchestration)
    ├── orchestrator.ts       # Agent ↔ User ↔ Environment message loop
    ├── user-simulator.ts     # LLM-based user simulation
    ├── environment.ts        # Generic DB + tool dispatch
    ├── evaluator.ts          # DB state comparison + pass^k
    └── domains/
        ├── airline/
        │   ├── policy.md     # Business rules
        │   ├── database.ts   # Initial data (users, flights, reservations)
        │   ├── tools.ts      # Tool definitions (Anthropic API format)
        │   ├── handlers.ts   # Tool implementation logic
        │   └── tasks.json    # 5 evaluation tasks
        └── retail/
            ├── policy.md     # Return/exchange/shipping policies
            ├── database.ts   # Initial data (customers, products, orders)
            ├── tools.ts      # Tool definitions
            ├── handlers.ts   # Tool implementation logic
            └── tasks.json    # 5 evaluation tasks
```

---

## Adding Custom Test Cases

### Adding Mini-SWE Cases

Add new entries to `tests/benchmark/swe/cases/mini-cases.json`:

```json
{
  "id": "mini-swe-021",
  "description": "Describe the bug and expected behavior clearly.",
  "files": {
    "src.js": "// buggy source code\nmodule.exports = { myFunc };\n",
    "test.js": "const { myFunc } = require('./src');\n// assertions...\nconsole.log('All tests passed');\n"
  },
  "test_command": "node test.js"
}
```

Requirements:
- `src.js` must contain the buggy code (the model should not modify test files)
- `test.js` must exit with code 0 on success, non-zero on failure
- The bug should be a single, clear defect with an unambiguous fix

### Adding TAU Domains

To add a new domain (e.g., `telecom`):

1. Create `tests/benchmark/tau/domains/telecom/`:
   - `policy.md` — business rules the agent must follow
   - `database.ts` — export `getInitialDatabase()` with typed data
   - `tools.ts` — export tool definitions in Anthropic API format
   - `handlers.ts` — export `getTelecomHandlers()` returning tool implementations
   - `tasks.json` — evaluation tasks with `user_scenario` and `expected_db`

2. Update `tests/benchmark/tau/index.ts`:
   - Add imports for the new domain
   - Add a `case 'telecom':` in `loadDomain()`
   - Add `'telecom'` to the candidates list in `getAvailableDomains()`
   - Add a role entry in `DOMAIN_ROLES`

### Adding TAU Tasks

Add entries to a domain's `tasks.json`:

```json
{
  "task_id": "retail_006",
  "user_scenario": "You are [name] (customer ID: [id]). Describe what the user wants...",
  "expected_db": {
    "orders": [
      { "order_id": "ORD001", "status": "returned" }
    ]
  },
  "max_turns": 10
}
```

The `expected_db` uses partial matching — only specified fields are checked, and records are matched by their primary key field (any field ending in `_id`).

---

## Best Practices

1. **Start with mini mode** — it's fast, free of Docker dependencies, and provides quick feedback
2. **Use `--provider` to test one model at a time** during development
3. **Save baseline reports** before SDK upgrades to catch regressions
4. **Set `--num-trials=3` or higher** for TAU benchmarks when evaluating reliability
5. **Use a separate user simulator model** (via `BENCHMARK_USER_MODEL`) to avoid self-play bias
6. **Keep API keys in `.env.test`** — the JSON report automatically redacts them

---

## References

- [SWE-bench](https://github.com/SWE-bench/SWE-bench) — Official repository + evaluation harness
- [SWE-bench Verified](https://openai.com/index/introducing-swe-bench-verified/) — Human-verified subset
- [SWE-bench Leaderboard](https://www.swebench.com/original.html)
- [τ-bench](https://github.com/sierra-research/tau-bench) — Original version
- [τ²-bench](https://github.com/sierra-research/tau2-bench) — Extended version with telecom domain
- [τ-bench Paper](https://arxiv.org/abs/2406.12045) — Methodology details
- [τ-bench Leaderboard](https://taubench.com)
- [Provider Configuration](./providers.md) — Setting up model providers
