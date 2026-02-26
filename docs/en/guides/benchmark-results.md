# Benchmark Results (Confirmed)

Last updated: 2026-02-26

## SWE-bench-Verified

| Provider / Model | Instances | Resolved | Rate | Avg Tokens | Avg Duration |
|---|---:|---:|---:|---:|---:|
| openai / glm-5 | 12 | 12/12 | 100.0% | 17.2k | 134.5k ms |

Source: local full run log (`2026-02-25__21-06-21`).

## Terminal Bench 2.0

| Agent / Model | Passed | Parseable | Unknown | Rate (parseable) | Notes |
|---|---:|---:|---:|---:|---|
| oracle / glm-5 | 1 | 31 | 58 | 3.2% | From the same full run; many tasks ended with runtime/timeout errors. |

## Reproduce

```bash
npm run test:benchmark -- \
  --benchmark=both \
  --tb2-model=openai/glm-5 \
  --tb2-agent=oracle \
  --tb2-runner=uvx \
  --tb2-jobs-dir=./tests/tmp/jobs \
  --output=json \
  --output-file=tests/tmp/benchmark-report.json
```

The JSON report includes both `swe` and `tb2` sections.
