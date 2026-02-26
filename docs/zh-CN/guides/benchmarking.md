# Benchmarking

KODE SDK 的 benchmark 入口已统一为一个命令，支持三种目标：

- `swe`：只跑 SWE-bench-Verified
- `tb2`：只跑 Terminal Bench 2.0
- `both`：一次命令同时跑两者

## 前置条件

1. 安装依赖：

```bash
npm ci
```

2. 准备 `.env.test`（或直接导出环境变量）：

```bash
ANTHROPIC_API_KEY=...
ANTHROPIC_MODEL_ID=claude-sonnet-4-20250514

OPENAI_API_KEY=...
OPENAI_MODEL_ID=glm-5

GEMINI_API_KEY=...
GEMINI_MODEL_ID=gemini-3-pro-preview
```

3. 运行依赖：
- SWE-bench-Verified：必须有 Docker
- TB2：`harbor`、`uvx` 或 Docker（由 `--tb2-runner` 决定）

## 统一命令

```bash
npm run test:benchmark -- [参数]
```

### 常用示例

一次命令同时跑 SWE + TB2：

```bash
npm run test:benchmark -- \
  --benchmark=both \
  --tb2-model=openai/glm-5 \
  --output=json \
  --output-file=tests/tmp/benchmark-report.json
```

只跑 SWE-bench-Verified：

```bash
npm run test:benchmark -- \
  --benchmark=swe \
  --provider=anthropic \
  --output=json \
  --output-file=tests/tmp/swe-report.json
```

只跑 TB2：

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

## 参数说明

| 参数 | 含义 | 默认值 |
|---|---|---|
| `--benchmark=swe\|tb2\|both` | 选择要跑的 benchmark | `both` |
| `--provider=...` | SWE provider 过滤（`anthropic`、`openai`、`gemini` 等） | 自动发现全部 |
| `--tb2-model=provider/model` | TB2 模型 ID | `BENCHMARK_TB2_MODEL` 或 `openai/$OPENAI_MODEL_ID` |
| `--tb2-agent=...` | TB2 agent（如 `oracle`） | `oracle` |
| `--tb2-dataset=...` | TB2 数据集 ID | `terminal-bench@2.0` |
| `--tb2-runner=auto\|harbor\|uvx\|docker` | TB2 运行后端 | `auto` |
| `--tb2-python=3.12` | `uvx` runner 的 Python 版本 | `3.12` |
| `--tb2-jobs-dir=PATH` | TB2 作业目录 | `tests/tmp/jobs` |
| `--tb2-env-file=PATH` | 传给 TB2 runner 的环境文件 | 自动探测 `.env.test` |
| `--tb2-docker-image=IMAGE` | TB2 docker runner 镜像 | `ghcr.io/astral-sh/uv:python3.12-bookworm` |
| `--output=table\|json` | 输出格式 | `table` |
| `--output-file=PATH` | JSON 输出文件（当 `--output=json`） | `benchmark-report.json` |
| `--compare=PATH` | 与历史 JSON 报告做对比 | 未设置 |

## 输出格式

使用 `--output=json` 时，单个报告同时包含 SWE 和 TB2：

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

## 说明

- SWE 已固定为 **SWE-bench-Verified**，不再有 mini/full 模式参数。
- TB2 走官方 Harbor 流程（`harbor run -d terminal-bench@2.0 -m ... -a ...`），由 runner 包装执行。
- 若 Docker 拉取镜像慢，可设置 `BENCHMARK_DOCKER_PROXY`。
