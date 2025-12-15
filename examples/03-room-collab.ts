import './shared/load-env';

import {
  Agent,
  AgentConfig,
  AgentPool,
  MonitorErrorEvent,
  MonitorToolExecutedEvent,
  Room,
} from '../src';
import { createRuntime } from './shared/runtime';

function configFor(templateId: string): AgentConfig {
  return {
    templateId,
    sandbox: { kind: 'local', workDir: './workspace', enforceBoundary: true, watchFiles: false },
  };
}

async function main() {
  const modelId = process.env.ANTHROPIC_MODEL_ID || 'claude-sonnet-4.5-20250929';

  const deps = createRuntime(({ templates, registerBuiltin }) => {
    registerBuiltin('fs', 'todo');

    templates.bulkRegister([
      {
        id: 'planner',
        systemPrompt: 'You are the tech planner. Break work into tasks and delegate via @mentions.',
        tools: ['todo_read', 'todo_write'],
        model: modelId,
        runtime: {
          todo: { enabled: true, reminderOnStart: true, remindIntervalSteps: 15 },
          subagents: { templates: ['executor'], depth: 1 },
        },
      },
      {
        id: 'executor',
        systemPrompt: 'You are an engineering specialist. Execute tasks sent by the planner.',
        tools: ['fs_read', 'fs_write', 'fs_edit', 'todo_read', 'todo_write'],
        model: modelId,
        runtime: { todo: { enabled: true, reminderOnStart: false } },
      },
    ]);
  });

  const pool = new AgentPool({ dependencies: deps, maxAgents: 10 });
  const room = new Room(pool);

  const planner = await pool.create('agt-planner', configFor('planner'));
  const dev = await pool.create('agt-dev', configFor('executor'));

  room.join('planner', planner.agentId);
  room.join('dev', dev.agentId);

  // 绑定监控
  const bindMonitor = (agent: Agent) => {
    agent.on('error', (event: MonitorErrorEvent) => {
      console.error(`[${agent.agentId}] error`, event.message);
    });
    agent.on('tool_executed', (event: MonitorToolExecutedEvent) => {
      console.log(`[${agent.agentId}] tool ${event.call.name} ${event.call.durationMs ?? 0}ms`);
    });
  };

  bindMonitor(planner);
  bindMonitor(dev);

  console.log('\n[planner -> room] Kick-off');
  await room.say('planner', 'Hi team, let us audit the repository README. @dev 请负责执行。');

  console.log('\n[dev -> planner] Acknowledge');
  await room.say('dev', '收到，我会列出 README 权限与事件说明。');

  console.log('\nCreating fork for alternative plan');
  const fork = await planner.fork();
  bindMonitor(fork);
  await fork.send('这是分叉出来的方案备选，请记录不同的 README 修改建议。');

  console.log('\nCurrent room members:', room.getMembers());
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
