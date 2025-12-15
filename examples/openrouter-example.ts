import './shared/load-env';

import {
  Agent,
  ControlPermissionRequiredEvent,
  MonitorErrorEvent,
  MonitorToolExecutedEvent,
} from '../src';
import { createRuntime } from './shared/runtime';

async function main() {
  const modelId = process.env.ANTHROPIC_MODEL_ID || 'anthropic/claude-haiku-4.5';

  const deps = createRuntime(({ templates, registerBuiltin }) => {
    registerBuiltin('fs', 'bash', 'todo');

    templates.register({
      id: 'repo-assistant',
      systemPrompt: 'You are the repo teammate. Be concise and actionable.',
      model: modelId,
      tools: ['fs_read', 'fs_write', 'fs_edit', 'fs_glob', 'bash_run', 'todo_read', 'todo_write'],
      runtime: {
        todo: { enabled: true, reminderOnStart: true, remindIntervalSteps: 20 },
        metadata: { exposeThinking: false },
      },
    });
  });

  const { modelFactory, ...restDeps } = deps;
  const agent = await Agent.create(
    {
      templateId: 'repo-assistant',
      sandbox: { kind: 'local', workDir: './workspace', enforceBoundary: true },
      metadata: { toolTimeoutMs: 45_000, maxToolConcurrency: 3 },
      modelConfig: {
        apiKey: process.env.ANTHROPIC_API_KEY,
        baseUrl: "https://openrouter.ai/api/v1",
        model: "anthropic/claude-haiku-4.5",
        provider: "openrouter"
      }
    },
    restDeps
  );

  // UI: 订阅 Progress 流
  (async () => {
    for await (const envelope of agent.subscribe(['progress'])) {
      console.log("envelope", envelope)
      switch (envelope.event.type) {
        case 'text_chunk':
          process.stdout.write(envelope.event.delta);
          break;
        case 'tool:start':
          console.log(`\n[tool] ${envelope.event.call.name} start`);
          break;
        case 'tool:end':
          console.log(`\n[tool] ${envelope.event.call.name} end`);
          break;
        case 'tool:error':
          console.warn(`\n[tool:error] ${envelope.event.error}`);
          break;
        case 'done':
          console.log('\n[progress] done at seq', envelope.bookmark?.seq);
          return;
      }
    }
  })().catch((error) => console.error('progress stream error', error));

  // Control: 审批回调（示例中简单拒绝 bash）
  agent.on('permission_required', async (event: ControlPermissionRequiredEvent) => {
    if (event.call.name === 'bash_run') {
      await event.respond('deny', { note: 'Demo inbox denies bash_run by default.' });
    }
  });

  // Monitor: 审计
  agent.on('tool_executed', (event: MonitorToolExecutedEvent) => {
    console.log('[audit]', event.call.name, `${event.call.durationMs ?? 0}ms`);
  });

  agent.on('error', (event: MonitorErrorEvent) => {
    console.error('[monitor:error]', event.phase, event.message, event.detail || '');
  });

  await agent.send('请总结项目目录，并列出接下来可以执行的两个 todo。');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
