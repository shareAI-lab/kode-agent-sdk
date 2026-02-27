# Benchmarking

KODE SDK benchmark runner now has a single entry command and supports multiple targets:

- `swe`: SWE-bench-Verified only
- `tau`: TAU-bench only
- `tb2`: Terminal Bench 2.0 only
- `both`: run SWE + TAU + TB2
- `all`: alias of `both` (compatibility)

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
- TAU-bench: `tau2` or `uvx` is required (official TAU2 harness)
- TB2: `harbor`, `uvx`, or Docker (runner decides by `--tb2-runner`)

## Unified Command

```bash
npm run test:benchmark -- [flags]
```

### Common examples

Run SWE + TAU + TB2 in one command:

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

Run only TAU-bench (official TAU2 script + dataset):

```bash
npm run test:benchmark -- \
  --benchmark=tau \
  --provider=openai \
  --tau-domain=airline \
  --num-trials=1 \
  --output=json \
  --output-file=tests/tmp/tau-report.json
```

## Flags

| Flag | Description | Default |
|---|---|---|
| `--benchmark=swe\|tau\|tb2\|both\|all` | Which benchmark(s) to run (`both`=`all`) | `both` |
| `--provider=...` | Provider filter for SWE/TAU (`anthropic`, `openai`, `gemini`, etc.) | all discovered |
| `--tau-domain=airline\|retail\|telecom\|all` | TAU domain filter | `airline` |
| `--num-trials=N` | TAU trials per task (Pass^k) | `1` |
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

With `--output=json`, one report may contain `swe`, `tau`, and `tb2` sections depending on `--benchmark`.

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
- TAU now runs with the official **TAU2** harness (`tau2 run ...`) from Sierra.
- TAU default domain is `airline` for faster CI/local feedback. Use `--tau-domain=all` when you need full coverage.
- TAU user simulator can be configured with `BENCHMARK_USER_MODEL=provider/model`.
- TB2 uses official Harbor run flow (`harbor run -d terminal-bench@2.0 -m ... -a ...`) under the selected runner.
- TAU/TB2 token stats are extracted from official result files when available; if a runner/agent does not emit usage, it is shown as `N/A`.
- If Docker image pulls are slow, set `BENCHMARK_DOCKER_PROXY`.
