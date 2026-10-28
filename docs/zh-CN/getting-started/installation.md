# 安装配置

## 环境要求

- **Node.js**: 20.18.1–20.x 或 22.x–25.x（与当前原生 SQLite 依赖一致）
- **npm** 或 **pnpm** 或 **yarn**

## 安装

```bash
npm install @shareai-lab/kode-sdk
```

或使用 pnpm/yarn：

```bash
pnpm add @shareai-lab/kode-sdk
yarn add @shareai-lab/kode-sdk
```

## TypeScript 项目

```bash
npm install --save-dev typescript ts-node @types/node
```

先保存 `tsconfig.json`，再运行 `npx ts-node getting-started.ts`：

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "Node16",
    "moduleResolution": "node16",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  }
}
```

## 源码 checkout

以下命令在仓库根目录运行。先构建再运行示例；示例解析本地包的 `dist` 导出，不会使用较旧的 registry 版本。

```bash
npm ci
npm run typecheck
npm run build
npm run typecheck:examples
npm run example:getting-started -- --mock
```

`./quickstart.sh` 只负责安装和构建。mock 示例不加载 `.env`、不使用密钥、不调用模型；其他模型示例需要 Provider 凭据和网络。SQLite 使用 `better-sqlite3`，平台没有匹配的预编译二进制时需要原生构建工具。当前锁定依赖不支持 Node 18。

## 环境变量配置

SDK 不会自动加载 `.env`。将密钥、模型和地址显式传给 Provider 构造函数或 `modelConfig`；模型 ID 请选用账号实际可用的模型。

KODE SDK 使用环境变量配置 API 密钥和模型。

### Anthropic（默认）

<!-- tabs:start -->
#### **Linux / macOS**
```bash
export ANTHROPIC_API_KEY=sk-ant-...
export ANTHROPIC_MODEL_ID=claude-sonnet-4-20250514  # 可选
export ANTHROPIC_BASE_URL=https://api.anthropic.com  # 可选
```

#### **Windows (PowerShell)**
```powershell
$env:ANTHROPIC_API_KEY="sk-ant-..."
$env:ANTHROPIC_MODEL_ID="claude-sonnet-4-20250514"  # 可选
$env:ANTHROPIC_BASE_URL="https://api.anthropic.com"  # 可选
```

#### **Windows (CMD)**
```cmd
set ANTHROPIC_API_KEY=sk-ant-...
set ANTHROPIC_MODEL_ID=claude-sonnet-4-20250514
```
<!-- tabs:end -->

### OpenAI

<!-- tabs:start -->
#### **Linux / macOS**
```bash
export OPENAI_API_KEY=sk-...
export OPENAI_MODEL_ID=gpt-4o  # 可选
```

#### **Windows (PowerShell)**
```powershell
$env:OPENAI_API_KEY="sk-..."
$env:OPENAI_MODEL_ID="gpt-4o"  # 可选
```
<!-- tabs:end -->

### Google Gemini

<!-- tabs:start -->
#### **Linux / macOS**
```bash
export GEMINI_API_KEY=...
export GEMINI_MODEL_ID=gemini-2.0-flash  # 可选
```

#### **Windows (PowerShell)**
```powershell
$env:GEMINI_API_KEY="..."
$env:GEMINI_MODEL_ID="gemini-2.0-flash"  # 可选
```
<!-- tabs:end -->

## 使用 .env 文件

在项目根目录创建 `.env` 文件：

```bash
# .env
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL_ID=claude-sonnet-4-20250514
```

在代码中加载：

```typescript
import 'dotenv/config';
// 或
import { config } from 'dotenv';
config();
```

## 验证安装

```typescript
import { Agent, AnthropicProvider, JSONStore } from '@shareai-lab/kode-sdk';

console.log('KODE SDK 安装成功！');
```

## 下一步

- [快速上手](./quickstart.md) - 创建第一个 Agent
- [核心概念](./concepts.md) - 理解核心概念
