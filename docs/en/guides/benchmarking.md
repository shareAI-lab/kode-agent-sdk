# Benchmarking

KODE SDK benchmark runner now has a single entry command and supports three targets:

- `swe`: SWE-bench-Verified only
- `tb2`: Terminal Bench 2.0 only
- `both`: run both in one command

## Prerequisites

1. Install dependencies:

```bash
npm ci
```

2. Create `.env.test` (or export env vars directly):

```bash
ANTHROPIC_API_KEY=...
ANTHROPIC_MODEL_ID=claude-sonnet-4-20250514

OPENAI_API_KEY=...
OPENAI_MODEL_ID=glm-5

GEMINI_API_KEY=...
GEMINI_MODEL_ID=gemini-3-pro-preview
```

3. Runtime tools:
- SWE-bench-Verified: Docker is required
- TB2: `harbor`, `uvx`, or Docker (runner decides by `--tb2-runner`)

## Unified Command

```bash
npm run test:benchmark -- [flags]
```

### Common examples

Run both SWE + TB2 in one command:

```bash
npm run test:benchmark -- \
  --benchmark=both \
  --tb2-model=openai/glm-5 \
  --output=json \
  --output-file=tests/tmp/benchmark-report.json
```

Run only SWE-bench-Verified:

```bash
npm run test:benchmark -- \
  --benchmark=swe \
  --provider=anthropic \
  --output=json \
  --output-file=tests/tmp/swe-report.json
```

Run only TB2:

```bash
npm run test:benchmark -- \
  --benchmark=tb2 \
  --tb2-model=openai/glm-5 \
  --tb2-agent=oracle \
  --tb2-runner=docker \
  --tb2-jobs-dir=./tests/tmp/jobs \
  --output=json \
  --output-file=tests/tmp/tb2-report.json
```

## Flags

| Flag | Description | Default |
|---|---|---|
| `--benchmark=swe\|tb2\|both` | Which benchmark(s) to run | `both` |
| `--provider=...` | SWE provider filter (`anthropic`, `openai`, `gemini`, etc.) | all discovered |
| `--tb2-model=provider/model` | TB2 model id | `BENCHMARK_TB2_MODEL` or `openai/$OPENAI_MODEL_ID` |
| `--tb2-agent=...` | TB2 agent (`oracle`, etc.) | `oracle` |
| `--tb2-dataset=...` | TB2 dataset id | `terminal-bench@2.0` |
| `--tb2-runner=auto\|harbor\|uvx\|docker` | TB2 execution backend | `auto` |
| `--tb2-python=3.12` | Python version for `uvx` runner | `3.12` |
| `--tb2-jobs-dir=PATH` | TB2 jobs directory | `tests/tmp/jobs` |
| `--tb2-env-file=PATH` | Env file passed to TB2 runner | auto-detect `.env.test` |
| `--tb2-docker-image=IMAGE` | Docker image for TB2 docker runner | `ghcr.io/astral-sh/uv:python3.12-bookworm` |
| `--output=table\|json` | Output mode | `table` |
| `--output-file=PATH` | JSON output file path (when `--output=json`) | `benchmark-report.json` |
| `--compare=PATH` | Compare against baseline JSON report | unset |

## Output

With `--output=json`, one report contains both sections:

```json
{
  "timestamp": "2026-02-25T08:31:16.000Z",
  "sdk_version": "2.7.3",
  "swe": [
    {
      "provider": { "id": "openai", "model": "glm-5" },
      "summary": { "dataset": "swe-bench-verified", "total": 12, "resolved": 10, "rate": 0.8333, "avg_tokens": 17500, "avg_duration_ms": 166000 }
    }
  ],
  "tb2": {
    "dataset": "terminal-bench@2.0",
    "agent": "oracle",
    "model": "openai/glm-5",
    "passed": 0,
    "total": 89,
    "rate": 0.0
  }
}
```

## Notes

- SWE-bench is fixed to **SWE-bench-Verified**. There is no mini/full mode switch anymore.
- TB2 uses official Harbor run flow (`harbor run -d terminal-bench@2.0 -m ... -a ...`) under the selected runner.
- If Docker image pulls are slow, set `BENCHMARK_DOCKER_PROXY`.
