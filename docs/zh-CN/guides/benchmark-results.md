# Benchmark 结果（已确认）

最后更新：2026-02-26

## SWE-bench-Verified

| Provider / Model | 实例数 | 通过数 | 通过率 | 平均 Tokens | 平均耗时 |
|---|---:|---:|---:|---:|---:|
| openai / glm-5 | 12 | 12/12 | 100.0% | 17.2k | 134.5k ms |

来源：本地完整运行日志（`2026-02-25__21-06-21`）。

## Terminal Bench 2.0

| Agent / Model | 通过数 | 可判定 | Unknown | 通过率（仅可判定） | 备注 |
|---|---:|---:|---:|---:|---|
| oracle / glm-5 | 1 | 31 | 58 | 3.2% | 与上面同一次完整运行；大量任务以 runtime/timeout 结束。 |

## 复现命令

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

输出 JSON 同时包含 `swe` 和 `tb2` 两个分区。
