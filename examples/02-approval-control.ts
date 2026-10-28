import './shared/load-env';

import {
  Agent,
  LocalSandbox,
  ControlPermissionDecidedEvent,
  ControlPermissionRequiredEvent,
  MonitorErrorEvent,
  MonitorToolExecutedEvent,
  ToolCall,
} from '@shareai-lab/kode-sdk';
import { createRuntime } from './shared/runtime';

async function main() {
  const modelId = process.env.ANTHROPIC_MODEL_ID || 'claude-sonnet-4-5-20250929';

  const deps = createRuntime(({ templates, registerBuiltin }) => {
    registerBuiltin('fs', 'bash', 'todo');

    templates.register({
      id: 'secure-runner',
      systemPrompt: 'You are a cautious operator. Always respect approvals.',
      tools: ['fs_read', 'fs_write', 'bash_run', 'bash_logs', 'todo_read', 'todo_write'],
      model: modelId,
      permission: {
        mode: 'approval',
        requireApprovalTools: ['bash_run'],
      },
      runtime: {
        todo: { enabled: true, reminderOnStart: true },
        metadata: { exposeThinking: false },
      },
    });
  });

  const sandbox = new LocalSandbox({ workDir: './workspace', enforceBoundary: true });
  try {
    const agent = await Agent.create(
      {
        templateId: 'secure-runner',
        sandbox,
        overrides: {
          hooks: {
            preToolUse(call: ToolCall) {
              if (call.name === 'bash_run' && typeof (call.args as { cmd?: string })?.cmd === 'string') {
                if (/rm -rf|sudo/.test(call.args.cmd)) {
                  return { decision: 'deny', reason: '命令命中禁用关键字' };
                }
              }
              return undefined;
            },
          },
        },
      },
      deps
    );

    // 模拟审批队列
    agent.on('permission_required', (event: ControlPermissionRequiredEvent) => {
      console.log('\n[approval] pending for', event.call.name, event.call.inputPreview);

      setTimeout(async () => {
        const shouldApprove = event.call.name === 'bash_run' && /ls/.test(JSON.stringify(event.call.inputPreview));
        const decision = shouldApprove ? 'allow' : 'deny';
        await event.respond(decision, { note: `automated: ${decision}` });
        console.log('[approval] decision', decision);
      }, 1500);
    });

    agent.on('permission_decided', (event: ControlPermissionDecidedEvent) => {
      console.log('[approval:decided]', event.callId, event.decision, event.note || '');
    });

    agent.on('tool_executed', (event: MonitorToolExecutedEvent) => {
      console.log('[tool_executed]', event.call.name, event.call.durationMs ?? 0, 'ms');
    });

    agent.on('error', (event: MonitorErrorEvent) => {
      console.error('[monitor:error]', event.phase, event.message);
    });

    console.log('> Requesting safe command');
    await agent.chat('在 workspace 下列出文件，并生成下一步 todo。');

    console.log('\n> Requesting dangerous command');
    await agent.chat('执行命令: rm -rf /');
  } finally {
    await sandbox.dispose();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
