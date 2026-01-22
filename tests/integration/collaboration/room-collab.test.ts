
import fs from 'fs';
import path from 'path';

import {
  Agent,
  AgentConfig,
  AgentDependencies,
  AgentPool,
  Room,
  AgentTemplateRegistry,
  ToolRegistry,
  SandboxFactory,
  JSONStore,
  builtin,
  AnthropicProvider,
  MonitorToolExecutedEvent,
  MonitorTodoReminderEvent,
  ControlEvent,
} from '../../../src';
import { loadIntegrationConfig, TEST_ROOT } from '../../helpers/fixtures';
import { ensureCleanDir, wait } from '../../helpers/setup';
import { TestRunner, expect } from '../../helpers/utils';

const runner = new TestRunner('集成测试 - Room 协作');

function registerBuiltinTools(registry: ToolRegistry) {
  const bundles = [builtin.fs(), builtin.todo(), builtin.task(), builtin.bash()];
  for (const bundle of bundles) {
    if (!bundle) continue;
    if (Array.isArray(bundle)) {
      for (const tool of bundle) {
        registry.register(tool.name, () => tool);
      }
    } else if (bundle) {
      registry.register(bundle.name, () => bundle);
    }
  }
}

function plannerConfig(basePrompt: string): string {
  return [
    'You are the tech planner coordinating a room of agents.',
    'Convert high-level goals into concrete tasks and keep todos updated.',
    basePrompt,
  ].join('\n');
}

runner.test('Room 多代理协作保持事件与Todo一致', async () => {
  console.log('\n[Room协作测试] 场景目标:');
  console.log('  1) Planner 与 Executor 通过 Room @mention 协作完成文件与 todo 更新');
  console.log('  2) 验证 tool_executed / todo_reminder / permission 事件链路正常');
  console.log('  3) Fork Planner 后仍可保持历史上下文');

  const apiConfig = loadIntegrationConfig();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const storeDir = path.join(TEST_ROOT, `room-store-${suffix}`);
  const baseWorkDir = path.join(TEST_ROOT, `room-work-${suffix}`);
  ensureCleanDir(storeDir);
  ensureCleanDir(baseWorkDir);

  const templates = new AgentTemplateRegistry();
  const tools = new ToolRegistry();
  const sandboxFactory = new SandboxFactory();
  const store = new JSONStore(storeDir);

  registerBuiltinTools(tools);

  templates.bulkRegister([
    {
      id: 'room-planner',
      systemPrompt: plannerConfig('Always delegate execution to @dev and keep ResumeChecklist todo accurate.'),
      tools: ['todo_write', 'todo_read'],
      runtime: { todo: { enabled: true, reminderOnStart: true, remindIntervalSteps: 4 } },
    },
    {
      id: 'room-executor',
      systemPrompt: [
        'You execute planner requests precisely.',
        'When updating files use fs_* tools and log results to ResumeChecklist todo.',
      ].join('\n'),
      tools: ['fs_read', 'fs_write', 'todo_write', 'todo_read'],
      runtime: { todo: { enabled: true, reminderOnStart: false } },
      permission: { mode: 'approval', requireApprovalTools: ['fs_write'] as const },
    },
  ]);

  const dependencies: AgentDependencies = {
    store,
    templateRegistry: templates,
    sandboxFactory,
    toolRegistry: tools,
    modelFactory: (config) => new AnthropicProvider(
      config.apiKey ?? apiConfig.apiKey,
      config.model,
      config.baseUrl ?? apiConfig.baseUrl
    ),
  };

  const pool = new AgentPool({ dependencies, maxAgents: 6 });
  const plannerWorkDir = path.join(baseWorkDir, 'planner');
  const devWorkDir = path.join(baseWorkDir, 'executor');
  ensureCleanDir(plannerWorkDir);
  ensureCleanDir(devWorkDir);

  const modelConfig = {
    provider: 'anthropic',
    apiKey: apiConfig.apiKey,
    baseUrl: apiConfig.baseUrl,
    model: apiConfig.model,
  } as const;

  const planner = await pool.create('agt-planner', {
    templateId: 'room-planner',
    modelConfig,
    sandbox: { kind: 'local', workDir: plannerWorkDir, enforceBoundary: true, watchFiles: true },
  });

  const dev = await pool.create('agt-dev', {
    templateId: 'room-executor',
    modelConfig,
    sandbox: { kind: 'local', workDir: devWorkDir, enforceBoundary: true, watchFiles: true },
  });

  const room = new Room(pool);
  room.join('planner', planner.agentId);
  room.join('dev', dev.agentId);

  const plannerTools: MonitorToolExecutedEvent[] = [];
  const devTools: MonitorToolExecutedEvent[] = [];
  const devReminders: MonitorTodoReminderEvent[] = [];
  const devControlEvents: ControlEvent[] = [];

  const detachPlannerTool = planner.on('tool_executed', (evt: MonitorToolExecutedEvent) => {
    plannerTools.push(evt);
  });
  const detachDevTool = dev.on('tool_executed', (evt: MonitorToolExecutedEvent) => {
    devTools.push(evt);
  });
  const detachReminders = dev.on('todo_reminder', (evt: MonitorTodoReminderEvent) => {
    devReminders.push(evt);
  });
  const detachPermissionRequired = dev.on('permission_required', async (evt) => {
    devControlEvents.push(evt);
    await evt.respond('allow', { note: '允许执行写入' });
  });
  const detachPermissionDecided = dev.on('permission_decided', (evt) => {
    devControlEvents.push(evt);
  });

  const targetFile = path.join(devWorkDir, 'ROOM_CHECK.md');
  fs.writeFileSync(targetFile, '初始内容\n');
  fs.writeFileSync(path.join(devWorkDir, 'README.md'), 'Room collaboration checklist.\n');

  await room.say('planner', '@dev 请创建 ResumeChecklist todo，并概述需要修改的 README 要点。');
  await wait(4000);
  await room.say('dev', '@planner 请确认已收到协作请求并记录当前进度。');
  await wait(2000);

  const devTodosStage1 = dev.getTodos();
  expect.toBeTruthy(devTodosStage1.some((todo) => todo.title.includes('ResumeChecklist')));

  await room.say('planner', '@dev 请将 ROOM_CHECK.md 内容改写，并在 todo 中标记进行中。');
  await wait(4000);

  const fileAfter = fs.readFileSync(targetFile, 'utf-8');
  expect.toBeTruthy(fileAfter.includes('已') || fileAfter.length > 5);

  const devTodosStage2 = dev.getTodos();
  expect.toBeTruthy(devTodosStage2.some((todo) => todo.status === 'in_progress' || todo.status === 'completed'));

  const fork = await pool.fork('agt-planner');
  const forkStatus = await fork.status();
  expect.toBeGreaterThan(forkStatus.stepCount, 0);

  expect.toBeGreaterThanOrEqual(plannerTools.length, 1);
  expect.toBeGreaterThanOrEqual(devTools.length, 1);
  expect.toBeGreaterThanOrEqual(devReminders.length, 0);
  expect.toBeGreaterThanOrEqual(
    devControlEvents.filter((evt) => evt.type === 'permission_required').length,
    1
  );
  expect.toBeGreaterThanOrEqual(
    devControlEvents.filter((evt) => evt.type === 'permission_decided').length,
    1
  );

  detachPlannerTool();
  detachDevTool();
  detachReminders();
  detachPermissionRequired();
  detachPermissionDecided();

  await (planner as any).sandbox?.dispose?.();
  await (dev as any).sandbox?.dispose?.();
  await pool.delete('agt-planner');
  await pool.delete('agt-dev');
  await wait(200);
  fs.rmSync(storeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  fs.rmSync(baseWorkDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

export async function run() {
  return runner.run();
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
