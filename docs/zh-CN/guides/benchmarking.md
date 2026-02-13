# 基准测试指南

KODE SDK 内置了一套完整的基准测试套件，用于评估不同 LLM 模型在 Agent 场景下的实际表现。该套件实现了两大业界标准方法论：

- **SWE-bench**（Princeton/OpenAI）— 代码缺陷修复：模型接收 issue 描述 + 源代码，生成修复代码，通过测试验证
- **τ-bench**（Sierra Research）— 多轮工具调用对话：模型扮演客服 Agent，使用工具、遵循业务策略，通过数据库状态对比评估

---

## 前置条件

1. **Provider 配置** — 在 `.env.test` 中至少配置一个 provider 的 `API_KEY` 和 `MODEL_ID`。详见 [Provider 配置指南](./providers.md)。

2. **Node.js** — 需要 `ts-node`（已包含在 devDependencies 中）。

3. **（可选）Docker** — 仅 SWE-bench full 模式需要。Mini 模式和 TAU 基准测试不依赖 Docker。

### 最小 `.env.test` 配置

```ini
# 至少配置一个 provider
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL_ID=claude-sonnet-4-5-20250929

# 可选：配置更多 provider 进行对比
OPENAI_API_KEY=sk-...
OPENAI_MODEL_ID=gpt-4o

GEMINI_API_KEY=AIza...
GEMINI_MODEL_ID=gemini-2.5-pro
```

---

## 快速开始

```bash
# 运行全部基准测试（SWE mini + TAU airline + TAU retail）
npm run test:benchmark

# 仅运行 SWE 基准测试
npm run test:benchmark -- --swe-only

# 运行 SWE full 模式（需要 Docker）
npm run test:benchmark -- --swe-only --swe-mode=full

# 仅运行 TAU 基准测试
npm run test:benchmark -- --tau-only

# 指定单个 provider
npm run test:benchmark -- --provider=anthropic

# 输出 JSON 报告
npm run test:benchmark -- --output=json --output-file=results.json
```

> **提示：** 每次运行基准测试时会自动生成 HTML 可视化报告，位于 `tests/tmp/benchmark-report-{timestamp}.html`。在浏览器中打开即可查看带评分、图表和逐条明细的详细报告。

---

## SWE 基准测试

SWE 基准测试评估模型修复代码缺陷的能力。模型接收 bug 描述和项目文件，生成修复后的代码，通过运行测试来验证正确性。

### Mini 模式（默认）

Mini 模式使用 20 个内置的 JavaScript 缺陷修复用例，在本地运行，无需 Docker。每个用例包含：
- 含有 bug 的 `src.js` 文件
- 包含断言的 `test.js` 测试文件
- 描述预期行为的 bug 说明

```bash
# 运行 mini-SWE 基准测试
npm run test:benchmark -- --swe-only --swe-mode=mini
```

**示例输出：**

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

**核心指标：** `Resolved Rate` — 模型修复代码后通过全部测试的用例比例。

### Full 模式（Docker）

Full 模式使用真实开源仓库的 SWE-bench 实例。通过官方预构建的 SWE-bench Docker 镜像进行评估。

```bash
# 运行 full SWE-bench（需要 Docker）
npm run test:benchmark -- --swe-only --swe-mode=full
```

评估流程为：
1. 在主机上克隆仓库并 checkout 到指定 commit
2. 从问题描述和提示中提取相关文件路径
3. 读取源文件，连同 bug 描述一起发送给 LLM
4. LLM 返回 SEARCH/REPLACE 格式的代码修改块
5. 框架应用修改并程序化生成 unified diff
6. 拉取官方 SWE-bench Docker 镜像（`swebench/sweb.eval.x86_64.<instance>:latest`）
7. 容器内已包含仓库（位于 `/testbed`）和预装所有依赖的 `testbed` conda 环境
8. 在容器中应用 patch 并运行测试套件

Docker 不可用时，回退到本地 git clone + patch 应用方式（由于缺少依赖，可靠性较低）。

精选实例定义在 `tests/benchmark/swe/cases/curated-instances.json` 中。

> **注意：** SWE-bench 镜像较大（每个数 GB）。首次运行时下载镜像需要较长时间，后续运行会复用本地缓存。如需代理下载，请配置 `BENCHMARK_DOCKER_PROXY`。

---

## TAU 基准测试

TAU 基准测试（Tool-Agent-User）评估模型在多轮客服对话中正确使用工具并遵循业务策略的能力。

### 架构

```
编排器 (Orchestrator)
├── Agent（被测模型）— 接收用户消息，调用工具，遵循策略
├── User Simulator（LLM 模拟用户）— 按场景脚本扮演客户
└── Environment（环境）— 执行工具调用，维护数据库状态
```

**评估方式：** 对话结束后，将最终数据库状态与预期状态对比。所有预期字段匹配则该任务通过。

### 可用领域

| 领域 | 任务数 | 工具数 | 描述 |
|------|--------|--------|------|
| `airline` | 5 | 7 | 航班改签、取消、行李查询 |
| `retail` | 5 | 8 | 退货、换货、订单状态、商品搜索 |

### 运行 TAU 基准测试

```bash
# 运行全部 TAU 领域
npm run test:benchmark -- --tau-only

# 运行指定领域
npm run test:benchmark -- --tau-only --tau-domain=airline
npm run test:benchmark -- --tau-only --tau-domain=retail

# 多次试验（计算 pass^k 可靠性指标）
npm run test:benchmark -- --tau-only --num-trials=3
```

**示例输出：**

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

### 理解 pass^k 指标

**pass^k** 衡量模型在多次独立试验中的可靠性：

- **pass^1** = 单次试验中通过的任务比例
- **pass^k** = 在 k 次独立试验中全部通过的任务比例

该指标反映一致性 — 如果模型 pass^1 = 80% 但 pass^3 = 40%，说明其表现不稳定。使用 `--num-trials=k` 来计算 pass^k。

### 用户模拟器

默认情况下，agent 和用户模拟器使用相同的模型。如需使用不同模型模拟用户：

```ini
# 在 .env.test 中设置
BENCHMARK_USER_MODEL=anthropic/claude-sonnet-4-5-20250929
```

格式：`provider/model-id`。

---

## CLI 参数参考

所有参数通过 `--` 传递给 npm script：

```bash
npm run test:benchmark -- [参数]
```

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--swe-only` | 仅运行 SWE 基准测试 | （全部运行） |
| `--tau-only` | 仅运行 TAU 基准测试 | （全部运行） |
| `--swe-mode=mini\|full` | SWE 评估模式 | `mini` |
| `--tau-domain=airline\|retail\|all` | TAU 评估领域 | `all` |
| `--provider=NAME` | 仅运行指定 provider | （全部已配置） |
| `--num-trials=N` | TAU 每个任务的试验次数（用于 pass^k） | `1` |
| `--output=table\|json\|html\|both` | 输出格式 | `table` |
| `--output-file=PATH` | JSON/HTML 报告输出路径 | `benchmark-report.json` |
| `--compare=PATH` | 与基线 JSON 报告对比 | （无） |

---

## 环境变量

可在 `.env.test` 中与 provider 配置一起设置：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `BENCHMARK_PROVIDERS` | 逗号分隔的 provider 列表 | （全部已配置） |
| `BENCHMARK_TIMEOUT_MS` | 每个任务超时时间（毫秒） | `120000` |
| `BENCHMARK_NUM_TRIALS` | TAU 默认试验次数 | `1` |
| `BENCHMARK_OUTPUT` | 输出格式 | `table` |
| `BENCHMARK_USER_MODEL` | 用户模拟器模型（`provider/model`） | （与 agent 相同） |
| `BENCHMARK_DOCKER_PROXY` | Docker 容器和 git clone 使用的 HTTP 代理 URL | （无） |

CLI 参数优先级高于环境变量。

---

## 历史结果对比

保存基线报告，后续运行时与其对比，检测性能退化：

```bash
# 1. 保存基线
npm run test:benchmark -- --output=json --output-file=baseline.json

# 2. 后续运行时，与基线对比
npm run test:benchmark -- --compare=baseline.json
```

对比输出展示关键指标的变化及方向标识：

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

- `^` = 改善（更高通过率、更少 token/延迟）
- `v` = 退化（更低通过率、更多 token/延迟）
- 检测到退化时退出码为 `1`

---

## JSON 报告格式

使用 `--output=json` 或 `--output=both` 时输出 JSON 报告：

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

API 密钥在输出中自动脱敏为 `"***"`。

---

## HTML 可视化报告

每次运行基准测试时会自动在 `tests/tmp/benchmark-report-{timestamp}.html` 生成一份自包含的 HTML 报告（该目录已被 `.gitignore` 忽略）。报告包含：

- **综合评分** — 加权综合评分（0–100），以圆环进度条展示：
  - SWE 通过率 × 60% + TAU Pass^1 × 40%
  - 如果只运行了一种基准测试，则该项占 100% 权重
  - 按分数自动标色：绿色（≥90 优秀）、黄色（≥70 良好）、橙色（≥50 一般）、红色（<50 较差）
- **配置摘要** — SDK 版本、provider 列表、SWE 模式、TAU 领域、超时设置、试验次数
- **SWE 结果** — 汇总表格、通过率条形图、可展开的逐 case 明细（通过/失败、token 数、耗时）
- **TAU 结果** — 带 Pass^k 列的汇总表格、通过率条形图、可展开的逐 task 试验明细

### 查看报告

```bash
# 运行基准测试（HTML 报告自动生成）
npm run test:benchmark -- --provider=anthropic

# 使用 Python 内置 HTTP 服务器
cd tests/tmp && python3 -m http.server 8080
# 打开 http://localhost:8080/benchmark-report.html
```

报告是单文件格式，所有 CSS 均内联，无外部依赖。也可以直接通过 `file://` 协议在浏览器中打开。

---

## 项目结构

```
tests/benchmark/
├── run-benchmark.ts          # 入口文件
├── config.ts                 # CLI + 环境变量配置加载
├── types.ts                  # 共享类型定义
├── reporter.ts               # 表格 + JSON 输出
├── html-reporter.ts          # HTML 可视化报告生成器
├── compare.ts                # 历史报告对比
│
├── swe/                      # SWE-bench 模块
│   ├── index.ts              # 模块入口（mini + full 模式路由）
│   ├── dataset.ts            # 用例/实例加载
│   ├── harness.ts            # 模型交互（mini 模式）
│   ├── evaluator.ts          # 本地测试执行（mini 模式）
│   ├── docker-evaluator.ts   # Docker/git 评估（full 模式）
│   └── cases/
│       ├── mini-cases.json       # 20 个 JavaScript 缺陷修复用例
│       └── curated-instances.json # SWE-bench 实例定义
│
└── tau/                      # TAU-bench 模块
    ├── index.ts              # 模块入口（领域发现 + 编排）
    ├── orchestrator.ts       # Agent ↔ User ↔ Environment 消息循环
    ├── user-simulator.ts     # 基于 LLM 的用户模拟
    ├── environment.ts        # 通用 DB + 工具分发
    ├── evaluator.ts          # DB 状态对比 + pass^k 计算
    └── domains/
        ├── airline/
        │   ├── policy.md     # 业务规则
        │   ├── database.ts   # 初始数据（用户、航班、预订）
        │   ├── tools.ts      # 工具定义（Anthropic API 格式）
        │   ├── handlers.ts   # 工具实现逻辑
        │   └── tasks.json    # 5 个评估任务
        └── retail/
            ├── policy.md     # 退换货/配送策略
            ├── database.ts   # 初始数据（客户、商品、订单）
            ├── tools.ts      # 工具定义
            ├── handlers.ts   # 工具实现逻辑
            └── tasks.json    # 5 个评估任务
```

---

## 添加自定义测试用例

### 添加 Mini-SWE 用例

在 `tests/benchmark/swe/cases/mini-cases.json` 中添加新条目：

```json
{
  "id": "mini-swe-021",
  "description": "清晰描述 bug 和预期行为。",
  "files": {
    "src.js": "// 有 bug 的源代码\nmodule.exports = { myFunc };\n",
    "test.js": "const { myFunc } = require('./src');\n// 断言...\nconsole.log('All tests passed');\n"
  },
  "test_command": "node test.js"
}
```

要求：
- `src.js` 必须包含有 bug 的代码（模型不应修改测试文件）
- `test.js` 成功时退出码为 0，失败时非 0
- bug 应该是单一、明确的缺陷，有唯一的修复方案

### 添加 TAU 领域

添加新领域（例如 `telecom`）：

1. 创建 `tests/benchmark/tau/domains/telecom/`：
   - `policy.md` — Agent 必须遵循的业务规则
   - `database.ts` — 导出 `getInitialDatabase()` 并定义类型
   - `tools.ts` — 导出 Anthropic API 格式的工具定义
   - `handlers.ts` — 导出 `getTelecomHandlers()` 返回工具实现
   - `tasks.json` — 包含 `user_scenario` 和 `expected_db` 的评估任务

2. 更新 `tests/benchmark/tau/index.ts`：
   - 添加新领域的导入
   - 在 `loadDomain()` 中添加 `case 'telecom':`
   - 在 `getAvailableDomains()` 的候选列表中添加 `'telecom'`
   - 在 `DOMAIN_ROLES` 中添加角色描述

### 添加 TAU 任务

在领域的 `tasks.json` 中添加条目：

```json
{
  "task_id": "retail_006",
  "user_scenario": "你是 [姓名]（客户 ID：[id]）。描述用户想要什么...",
  "expected_db": {
    "orders": [
      { "order_id": "ORD001", "status": "returned" }
    ]
  },
  "max_turns": 10
}
```

`expected_db` 使用部分匹配 — 只检查指定的字段，记录通过主键字段（以 `_id` 结尾的字段）进行匹配。

---

## 最佳实践

1. **从 mini 模式开始** — 速度快、无 Docker 依赖、能快速获得反馈
2. **开发时使用 `--provider` 逐个测试模型**
3. **SDK 升级前保存基线报告** 用于回归检测
4. **评估可靠性时设置 `--num-trials=3` 或更高** 用于 TAU 基准测试
5. **使用独立的用户模拟器模型**（通过 `BENCHMARK_USER_MODEL`）避免自对弈偏差
6. **将 API 密钥放在 `.env.test` 中** — JSON 报告会自动脱敏

---

## 参考链接

- [SWE-bench](https://github.com/SWE-bench/SWE-bench) — 官方仓库 + 评估 harness
- [SWE-bench Verified](https://openai.com/index/introducing-swe-bench-verified/) — 人工验证子集
- [SWE-bench 排行榜](https://www.swebench.com/original.html)
- [τ-bench](https://github.com/sierra-research/tau-bench) — 原始版本
- [τ²-bench](https://github.com/sierra-research/tau2-bench) — 扩展版本（含 telecom 域）
- [τ-bench 论文](https://arxiv.org/abs/2406.12045) — 方法论详述
- [τ-bench 排行榜](https://taubench.com)
- [Provider 配置指南](./providers.md) — 模型 provider 配置
