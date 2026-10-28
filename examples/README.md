# KODE SDK Examples

KODE SDK 使用示例集合。

## 快速开始

```bash
# 在仓库根目录安装并构建，不需要单独安装 examples 的依赖
npm ci
npm run build
npm run example:getting-started -- --mock

# 真实模型（会产生实际 API 请求）
export ANTHROPIC_API_KEY=your-api-key
npm run example:getting-started
```

需要 Node.js 20.18.1–20.x 或 22.x–25.x。`--mock` 不加载 `.env`、不读取凭据、不联网。先构建，再运行 `npm run typecheck:examples` 检查所有示例。下面的表格命令在 `examples/` 目录运行，复用根目录安装的工具和本地包；也可以使用根目录相应的 `example:*` 脚本。

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
| opensandbox | OpenSandbox 自托管沙箱 | `npm run opensandbox` |
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
| nextjs | Next.js API 路由集成 | `npm run nextjs` |

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
