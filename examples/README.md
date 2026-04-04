# KODE SDK Examples

KODE SDK 使用示例集合。

## 快速开始

```bash
cd examples
npm install

# 配置环境变量
export ANTHROPIC_API_KEY=your-api-key

# 运行示例
npx ts-node getting-started.ts
```

## 环境变量

根据需要运行的示例，配置相应的环境变量：

```bash
# Anthropic (Claude)
export ANTHROPIC_API_KEY=your-key
export ANTHROPIC_BASE_URL=https://api.anthropic.com  # 可选
export ANTHROPIC_MODEL_ID=claude-sonnet-4-20250514   # 可选

# OpenAI
export OPENAI_API_KEY=your-key
export OPENAI_BASE_URL=https://api.openai.com/v1     # 可选
export OPENAI_MODEL_ID=gpt-4o                        # 可选

# Gemini
export GEMINI_API_KEY=your-key
export GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta  # 可选
export GEMINI_MODEL_ID=gemini-2.0-flash              # 可选

# E2B Cloud Sandbox
export E2B_API_KEY=your-key

# PostgreSQL (db-postgres 示例)
export POSTGRES_HOST=localhost
export POSTGRES_PORT=5432
export POSTGRES_DB=kode_agents
export POSTGRES_USER=kode
export POSTGRES_PASSWORD=your-password
```

## 示例列表

| 示例 | 说明 | 运行命令 |
|------|------|----------|
| getting-started | 入门示例 | `npm run getting-started` |
| e2b-usage | E2B 云沙箱 | `npm run e2b -- basic` |
| agent-inbox | Agent 收件箱模式 | `npm run agent-inbox` |
| approval | 权限审批控制 | `npm run approval` |
| room | 多 Agent 协作 | `npm run room` |
| scheduler | 调度器与文件监控 | `npm run scheduler` |
| db-sqlite | SQLite 持久化 | `npm run db-sqlite` |
| db-postgres | PostgreSQL 持久化 | `npm run db-postgres` |
| anthropic | Anthropic Provider | `npm run anthropic` |
| openai | OpenAI Provider | `npm run openai` |
| gemini | Gemini Provider | `npm run gemini` |
| openrouter | OpenRouter 完整示例 | `npm run openrouter` |
| openrouter-stream | OpenRouter 流式输出 | `npm run openrouter-stream` |
| openrouter-agent | OpenRouter Agent 集成 | `npm run openrouter-agent` |
| observability-http | 应用层包装 KODE 观测接口的 HTTP 示例 | `npm run observability-http` |
| nextjs | Next.js API 路由集成 | `npm run nextjs` |

## 观测层 HTTP 示例

这个示例把 HTTP 放在应用层，底层仍然只使用 SDK 提供的 reader/backend 能力。

```bash
# 在仓库根目录运行
npm run example:observability-http

# 或在 examples/ 目录运行
cd examples
npm run observability-http
```

需要的环境变量：

```bash
export KODE_EXAMPLE_PROVIDER=glm  # 可选；当 OPENAI_MODEL_ID 以 glm 开头时也会自动识别
export OPENAI_API_KEY=your-key
export OPENAI_MODEL_ID=glm-5
export OPENAI_BASE_URL=https://open.bigmodel.cn/api/paas/v4/
```

这套约定与 `examples/openai-usage.ts` 保持一致，因此像 GLM 这样的 OpenAI-compatible provider 可以直接复用，不需要再写死 Anthropic 配置。

服务启动后可按下面顺序试用：

```bash
curl http://127.0.0.1:3100/
curl -X POST http://127.0.0.1:3100/agents/demo/send \
  -H 'content-type: application/json' \
  -d '{"prompt":"用一句话总结 KODE 的观测层。"}'
curl http://127.0.0.1:3100/api/observability/agents/agt-observability-http-demo/metrics
curl http://127.0.0.1:3100/api/observability/agents/agt-observability-http-demo/observations/runtime
curl http://127.0.0.1:3100/api/observability/agents/agt-observability-http-demo/observations/persisted
```

## E2B 云沙箱示例

```bash
# 查看帮助
npm run e2b

# 运行基础示例
npm run e2b -- basic

# 运行模板示例
npm run e2b -- template

# 运行 Agent 集成示例
npm run e2b -- agent

# 运行全部
npm run e2b -- all
```

## 目录结构

```
examples/
├── shared/           # 共享工具模块
│   ├── load-env.ts   # 环境变量加载
│   ├── runtime.ts    # Agent 运行时创建
│   └── demo-model.ts # 演示用模型配置
├── tooling/          # 工具相关示例
├── *.ts              # 各功能示例
├── package.json      # 依赖配置
└── tsconfig.json     # TypeScript 配置
```

## 注意事项

1. 运行前确保已配置必要的 API Key
2. 部分示例需要网络访问外部 API
3. db-postgres 示例需要运行 PostgreSQL 数据库
4. E2B 示例需要 E2B 账号和 API Key
5. `observability-http` 示例演示的是“应用层自己包装 SDK 的观测接口并暴露 HTTP”，不是 `Agent` 内置 HTTP 服务，也不是 SDK 核心 feature
