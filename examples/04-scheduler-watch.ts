import {
  Agent,
  LocalSandbox,
  ModelProvider,
  MonitorFileChangedEvent,
  MonitorTodoReminderEvent,
} from '@shareai-lab/kode-sdk';
import { createRuntime } from './shared/runtime';
import { createDemoModelProvider } from './shared/demo-model';
import { MockProvider } from './shared/mock-provider';

export async function runSchedulerWatch(provider: ModelProvider, options: {
  workDir?: string;
  storeDir?: string;
  log?: (message: string) => void;
} = {}): Promise<void> {
  const log = options.log ?? console.log;
  const sandbox = new LocalSandbox({ workDir: options.workDir ?? './workspace', enforceBoundary: true, watchFiles: true });
  let agent: Agent | undefined;
  let reminderSubmitted: Promise<void> = Promise.resolve();
  let failure: Error | undefined;
  const unsubscribe: Array<() => void> = [];
  try {
    const deps = createRuntime(({ templates, registerBuiltin }) => {
      registerBuiltin('fs', 'todo');

      templates.register({
        id: 'watcher',
        systemPrompt: 'You are an operations engineer. Monitor files and summarize progress regularly.',
        tools: ['fs_read', 'fs_write', 'fs_glob', 'todo_read', 'todo_write'],
        model: provider.model,
        runtime: {
          todo: { enabled: true, reminderOnStart: true, remindIntervalSteps: 10 },
          metadata: { exposeThinking: false },
        },
      });
    }, { storeDir: options.storeDir });

    agent = await Agent.create(
      {
        templateId: 'watcher',
        model: provider,
        sandbox,
      },
      deps
    );

    const scheduler = agent.schedule();
    const prompts = [
      '请列出 README 中所有与事件驱动相关的章节。',
      '根据刚才的输出，更新 todo 列表并加上到期时间。',
      '监控 docs/ 目录变化，如果 README 被修改请提醒。',
    ];
    let submitted = 0;

    scheduler.everySteps(2, ({ stepCount }) => {
      if (submitted === prompts.length) return;
      log(`[scheduler] remind at step ${stepCount}`);
      // Reminders are injected into the next user turn; they do not start a model request.
      reminderSubmitted = agent!.send('系统提醒：请总结当前任务进度并更新时间线。', { kind: 'reminder' })
        .then(() => undefined, error => { failure = error instanceof Error ? error : new Error(String(error)); });
      return reminderSubmitted;
    });

    unsubscribe.push(agent.on('file_changed', (event: MonitorFileChangedEvent) => {
      log(`[monitor:file_changed] ${event.path} ${new Date(event.mtime).toISOString()}`);
    }));

    unsubscribe.push(agent.on('todo_reminder', (event: MonitorTodoReminderEvent) => {
      log(`[monitor:todo_reminder] ${event.reason}`);
    }));

    for (const prompt of prompts) {
      submitted++;
      await agent.chat(prompt);
      await reminderSubmitted;
      if (failure) throw failure;
    }
    if (failure) throw failure;

    log('Scheduler demo completed. Scheduled tasks and file watchers will now close.');
  } finally {
    agent?.schedule().clear();
    await reminderSubmitted;
    unsubscribe.forEach(stop => stop());
    await sandbox.dispose();
  }
}

async function main() {
  let provider: ModelProvider;
  if (process.argv.includes('--mock')) provider = new MockProvider();
  else {
    require('./shared/load-env');
    provider = createDemoModelProvider({ provider: 'anthropic', model: process.env.ANTHROPIC_MODEL_ID || 'claude-sonnet-4-5-20250929' });
  }
  await runSchedulerWatch(provider);
}

if (require.main === module) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
