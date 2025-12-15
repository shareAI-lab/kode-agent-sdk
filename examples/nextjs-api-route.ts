// Example Next.js API route illustrating resume-or-create pattern + SSE progress stream
// (在本地 demo 中使用最小类型声明避免额外依赖)

import './shared/load-env';

type NextApiRequest = {
  query: Record<string, string | string[]>;
  body: any;
  method?: string;
  on(event: 'close', listener: () => void): void;
};

type NextApiResponse = {
  setHeader(name: string, value: string): void;
  status(code: number): NextApiResponse;
  json(data: any): void;
  end(): void;
  write(chunk: string): void;
  flushHeaders?: () => void;
};

import {
  Agent,
  AgentConfig,
  ControlPermissionRequiredEvent,
  MonitorErrorEvent,
  MonitorToolExecutedEvent,
} from '../src';
import { createRuntime } from './shared/runtime';

// ---- shared singletons --------------------------------------------------

const modelId = process.env.ANTHROPIC_MODEL_ID || 'claude-sonnet-4.5-20250929';

const deps = createRuntime(({ templates, registerBuiltin }) => {
  registerBuiltin('fs', 'todo');

  templates.register({
    id: 'repo-assistant',
    systemPrompt: 'You are the repo teammate. Always cite filenames.',
    tools: ['fs_read', 'fs_glob', 'todo_read', 'todo_write'],
    model: modelId,
    runtime: { todo: { enabled: true, reminderOnStart: true, remindIntervalSteps: 12 } },
  });
});

// ---- helper -------------------------------------------------------------

async function resumeOrCreate(agentId: string, overrides?: Partial<AgentConfig>): Promise<Agent> {
  const exists = await deps.store.exists(agentId);
  if (exists) {
    return Agent.resumeFromStore(agentId, deps, { overrides });
  }

  const baseConfig: AgentConfig = {
    agentId,
    templateId: 'repo-assistant',
    sandbox: { kind: 'local', workDir: './workspace', enforceBoundary: true },
  };

  return Agent.create({ ...baseConfig, ...overrides }, deps);
}

function bindControlAndMonitor(agent: Agent) {
  agent.on('permission_required', (event: ControlPermissionRequiredEvent) => {
    // 推送到审批队列或写入数据库
    console.log('[control] pending approval', event.call.name, event.call.inputPreview);
  });

  agent.on('tool_executed', (event: MonitorToolExecutedEvent) => {
    console.log('[monitor] tool executed', event.call.name, event.call.durationMs ?? 0);
  });

  agent.on('error', (event: MonitorErrorEvent) => {
    console.error('[monitor] error', event.phase, event.message);
  });
}

// ---- API route ----------------------------------------------------------

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const agentId = (req.query.agentId as string) || 'agt-web-demo';
  const agent = await resumeOrCreate(agentId);

  bindControlAndMonitor(agent);

  if (req.method === 'POST') {
    const { prompt } = req.body;
    await agent.send(prompt);
    res.status(202).json({ status: 'queued' });
    return;
  }

  if (req.method === 'GET') {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders?.();

    const since = req.query.since
      ? { seq: Number(req.query.since), timestamp: Date.now() }
      : undefined;

    const iterator = agent.subscribe(['progress', 'monitor'], { since })[Symbol.asyncIterator]();

    (async () => {
      try {
        for await (const envelope of { [Symbol.asyncIterator]: () => iterator }) {
          res.write(`data: ${JSON.stringify(envelope)}\n\n`);
        }
      } catch (error) {
        console.error('SSE stream error', error);
      } finally {
        res.end();
      }
    })();

    req.on('close', () => {
      iterator.return?.();
    });
    return;
  }

  res.status(405).end();
}
