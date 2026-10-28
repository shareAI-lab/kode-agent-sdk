# Installation

## Requirements

- **Node.js**: 20.18.1–20.x or 22.x–25.x (matches the current native SQLite dependency)
- **npm** (repository commands below use npm; applications can also use pnpm or yarn)

## Install

```bash
npm install @shareai-lab/kode-sdk
```

Or with pnpm/yarn:

```bash
pnpm add @shareai-lab/kode-sdk
yarn add @shareai-lab/kode-sdk
```

## TypeScript application

```bash
npm install --save-dev typescript ts-node @types/node
```

Save as `tsconfig.json` before using `npx ts-node getting-started.ts`:

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

## Source checkout

Run from the repository root. Build before running examples: they resolve the local package's `dist` exports, rather than an older registry release.

```bash
npm ci
npm run typecheck
npm run build
npm run typecheck:examples
npm run example:getting-started -- --mock
```

`./quickstart.sh` installs and builds only. The mock example does not load `.env`, use a key or call a model. The other model examples require provider credentials and network access. SQLite uses `better-sqlite3`; a platform without a matching prebuilt binary needs native build tools. Node 18 is unsupported by the current locked dependencies.

## Environment Variables

The SDK does not load `.env` automatically. Pass the desired key, model and base URL to the provider constructor (or `modelConfig`); the getting-started example does this explicitly. Choose a model available to your provider account.


KODE SDK uses environment variables for API keys and model configuration.

### Anthropic (Default)

<!-- tabs:start -->
#### **Linux / macOS**
```bash
export ANTHROPIC_API_KEY=sk-ant-...
export ANTHROPIC_MODEL_ID=claude-sonnet-4-20250514  # optional
export ANTHROPIC_BASE_URL=https://api.anthropic.com  # optional
```

#### **Windows (PowerShell)**
```powershell
$env:ANTHROPIC_API_KEY="sk-ant-..."
$env:ANTHROPIC_MODEL_ID="claude-sonnet-4-20250514"  # optional
$env:ANTHROPIC_BASE_URL="https://api.anthropic.com"  # optional
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
export OPENAI_MODEL_ID=gpt-4o  # optional
```

#### **Windows (PowerShell)**
```powershell
$env:OPENAI_API_KEY="sk-..."
$env:OPENAI_MODEL_ID="gpt-4o"  # optional
```
<!-- tabs:end -->

### Google Gemini

<!-- tabs:start -->
#### **Linux / macOS**
```bash
export GEMINI_API_KEY=...
export GEMINI_MODEL_ID=gemini-2.0-flash  # optional
```

#### **Windows (PowerShell)**
```powershell
$env:GEMINI_API_KEY="..."
$env:GEMINI_MODEL_ID="gemini-2.0-flash"  # optional
```
<!-- tabs:end -->

## Using .env File

Create a `.env` file in your project root:

```bash
# .env
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL_ID=claude-sonnet-4-20250514
```

Load it in your code:

```typescript
import 'dotenv/config';
// or
import { config } from 'dotenv';
config();
```

## Verify Installation

```typescript
import { Agent, AnthropicProvider, JSONStore } from '@shareai-lab/kode-sdk';

console.log('KODE SDK installed successfully!');
```

## Next Steps

- [Quickstart](./quickstart.md) - Build your first Agent
- [Concepts](./concepts.md) - Understand core concepts
