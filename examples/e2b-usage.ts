import './shared/load-env';

import { Agent, E2BSandbox, E2BTemplateBuilder } from '@shareai-lab/kode-sdk';
import { createRuntime } from './shared/runtime';

// ============================================================
// Usage & Configuration Check
// ============================================================
function printUsage() {
  console.log(`
E2B Cloud Sandbox 示例
======================

用法:
  npx ts-node examples/e2b-usage.ts <demo>

可用 Demo:
  basic     - 基础沙箱操作（命令执行、文件读写、glob 搜索）
  template  - 自定义模板构建与使用
  agent     - Agent + E2B 沙箱集成
  all       - 运行全部 Demo

示例:
  npx ts-node examples/e2b-usage.ts basic
  npx ts-node examples/e2b-usage.ts all
`);
}

function checkApiKey(): boolean {
  const apiKey = process.env.E2B_API_KEY;
  if (!apiKey || apiKey === 'replace-with-your-e2b-api-key') {
    console.error(`
错误: 未配置 E2B_API_KEY

请按以下步骤配置:
  1. 访问 https://e2b.dev/dashboard 注册并获取 API Key
  2. 设置环境变量:
     export E2B_API_KEY=your-api-key-here

运行 agent demo 还需要配置 LLM 提供商:
     export ANTHROPIC_API_KEY=your-anthropic-key
     export ANTHROPIC_BASE_URL=https://api.anthropic.com  # 可选，默认官方地址
     export ANTHROPIC_MODEL_ID=claude-sonnet-4-20250514   # 可选
`);
    return false;
  }
  return true;
}

// ============================================================
// Demo 1: Basic E2B Sandbox Usage
// ============================================================
async function demoBasicUsage() {
  console.log('\n=== Demo 1: Basic E2B Sandbox Usage ===\n');

  const sandbox = new E2BSandbox({
    apiKey: process.env.E2B_API_KEY,
    template: 'base',
    timeoutMs: 300_000,
  });
  await sandbox.init();
  console.log(`Sandbox created: ${sandbox.getSandboxId()}`);

  // Execute commands
  const result = await sandbox.exec('python3 -c "print(2 + 2)"');
  console.log(`Python result: ${result.stdout.trim()}`); // "4"

  const shellResult = await sandbox.exec('uname -a');
  console.log(`System: ${shellResult.stdout.trim()}`);

  // File operations
  await sandbox.fs.write('hello.py', 'print("Hello from E2B!")');
  const content = await sandbox.fs.read('hello.py');
  console.log(`File content: ${content}`);

  const execResult = await sandbox.exec('python3 hello.py');
  console.log(`Execute script: ${execResult.stdout.trim()}`);

  // Glob search
  await sandbox.fs.write('src/index.ts', 'console.log("hi")');
  await sandbox.fs.write('src/utils.ts', 'export {}');
  const files = await sandbox.fs.glob('**/*.ts');
  console.log(`Found files: ${files.join(', ')}`);

  // Cleanup
  await sandbox.dispose();
  console.log('Sandbox disposed.\n');
}

// ============================================================
// Demo 2: Custom Template
// ============================================================
async function demoTemplate() {
  console.log('\n=== Demo 2: Custom Template ===\n');

  const alias = 'kode-data-analysis';

  // Check if template exists
  const exists = await E2BTemplateBuilder.exists(alias, {
    apiKey: process.env.E2B_API_KEY,
  });

  if (!exists) {
    console.log('Building custom template...');
    const result = await E2BTemplateBuilder.build(
      {
        alias,
        base: 'python',
        baseVersion: '3.11',
        pipPackages: ['pandas', 'numpy'],
        workDir: '/workspace',
        cpuCount: 2,
        memoryMB: 1024,
      },
      {
        apiKey: process.env.E2B_API_KEY,
        onLog: (log) => console.log(`  [build] ${log}`),
      }
    );
    console.log(`Template built: ${result.templateId}`);
  } else {
    console.log(`Template "${alias}" already exists.`);
  }

  // Use custom template
  const sandbox = new E2BSandbox({
    apiKey: process.env.E2B_API_KEY,
    template: alias,
    workDir: '/workspace',
  });
  await sandbox.init();

  // Verify packages are available
  const check = await sandbox.exec('python3 -c "import pandas; print(pandas.__version__)"');
  console.log(`Pandas version: ${check.stdout.trim()}`);

  await sandbox.dispose();
  console.log('Template demo done.\n');
}

// ============================================================
// Demo 3: Agent + E2B Integration
// ============================================================
async function demoAgentIntegration() {
  console.log('\n=== Demo 3: Agent + E2B Integration ===\n');

  const modelId = process.env.ANTHROPIC_MODEL_ID || 'claude-sonnet-4-5-20250929';

  // Create E2B sandbox
  const sandbox = new E2BSandbox({
    apiKey: process.env.E2B_API_KEY,
    template: 'base',
    timeoutMs: 600_000,
  });
  await sandbox.init();
  console.log(`Sandbox ready: ${sandbox.getSandboxId()}`);

  // Create agent with E2B sandbox
  const deps = createRuntime(({ templates, registerBuiltin }) => {
    registerBuiltin('fs', 'bash', 'todo');
    templates.register({
      id: 'e2b-coder',
      systemPrompt:
        'You are a coding assistant. You can execute code in a cloud sandbox. ' +
        'Use bash_run to run commands. Keep answers concise.',
      tools: ['bash_run', 'fs_read', 'fs_write', 'todo_read', 'todo_write'],
      model: modelId,
    });
  });

  const agent = await Agent.create(
    {
      templateId: 'e2b-coder',
      sandbox,
    },
    deps
  );

  // Subscribe to progress events
  const streamPromise = (async () => {
    for await (const envelope of agent.subscribe(['progress'])) {
      if (envelope.event.type === 'text_chunk') {
        process.stdout.write(envelope.event.delta);
      }
      if (envelope.event.type === 'done') {
        console.log('\n--- done ---');
        break;
      }
    }
  })();

  // Send a coding task
  await agent.send('Write a Python script that prints the first 10 Fibonacci numbers, save it as fib.py, then run it.');

  await streamPromise;

  // 启动一个简单的 HTTP 服务演示端口暴露
  console.log('\n启动 HTTP 服务 (端口 8080)...');
  sandbox.exec('python3 -m http.server 8080 &').catch(() => {});
  await new Promise((r) => setTimeout(r, 1500)); // 等待服务启动

  const url = sandbox.getHostUrl(8080);
  console.log(`访问地址: ${url}`);

  // 等待用户确认后再清理
  console.log('\n按回车键退出并销毁沙箱...');
  await new Promise<void>((resolve) => {
    process.stdin.setRawMode?.(false);
    process.stdin.resume();
    process.stdin.once('data', () => {
      process.stdin.pause();
      resolve();
    });
  });

  // Cleanup
  await sandbox.dispose();
  console.log('Agent + E2B demo done.\n');
}

// ============================================================
// Main
// ============================================================
async function main() {
  const demo = process.argv[2];

  // 始终显示用法说明
  printUsage();

  // 无参数时仅显示用法
  if (!demo) {
    return;
  }

  // 验证 demo 参数
  const validDemos = ['basic', 'template', 'agent', 'all'];
  if (!validDemos.includes(demo)) {
    console.error(`错误: 未知的 demo "${demo}"，请使用 basic/template/agent/all\n`);
    return;
  }

  // 检查 API Key
  if (!checkApiKey()) {
    process.exit(1);
  }

  console.log(`运行: ${demo}\n`);

  switch (demo) {
    case 'basic':
      await demoBasicUsage();
      break;
    case 'template':
      await demoTemplate();
      break;
    case 'agent':
      await demoAgentIntegration();
      break;
    case 'all':
      await demoBasicUsage();
      await demoTemplate();
      await demoAgentIntegration();
      break;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
