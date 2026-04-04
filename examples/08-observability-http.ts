import './shared/load-env';

import http from 'node:http';

// This example intentionally keeps HTTP in application code to show
// how KODE observability readers can be wrapped without making HTTP
// part of the SDK core contract.
import {
  Agent,
  AgentConfig,
  AgentTemplateRegistry,
  ModelConfig,
  JSONStore,
  JSONStoreObservationBackend,
  SandboxFactory,
  ToolRegistry,
  createStoreBackedObservationReader,
} from '@shareai-lab/kode-sdk';
import { createDemoModelConfig, createDemoModelProvider } from './shared/demo-model';
import { createExampleObservabilityHttpHandler } from './shared/observability-http';

const storeDir = './.kode-observability-http';
const observationBackend = new JSONStoreObservationBackend(storeDir);
const persistedReader = createStoreBackedObservationReader(observationBackend);
const demoAgentId = 'agt-observability-http-demo';
const defaultPort = Number(process.env.PORT || 3100);
const demoModelConfig = createDemoModelConfig();
const liveAgents = new Map<string, Promise<Agent>>();

const templates = new AgentTemplateRegistry();
templates.register({
  id: 'obs-http-demo',
  systemPrompt: 'You are an observability demo assistant.',
  tools: [],
  permission: { mode: 'auto' },
});

const deps = {
  store: new JSONStore(storeDir),
  templateRegistry: templates,
  sandboxFactory: new SandboxFactory(),
  toolRegistry: new ToolRegistry(),
  modelFactory: (config: any) => createDemoModelProvider(config),
};

async function createOrResumeAgent(agentId: string): Promise<Agent> {
  const exists = await deps.store.exists(agentId);
  if (exists) {
    return Agent.resumeFromStore(agentId, deps, {
      overrides: {
        modelConfig: demoModelConfig as ModelConfig,
        observability: {
          persistence: { backend: observationBackend },
        },
      },
    });
  }

  const config: AgentConfig = {
    agentId,
    templateId: 'obs-http-demo',
    modelConfig: demoModelConfig,
    sandbox: { kind: 'local', workDir: './workspace', enforceBoundary: true },
    observability: {
      persistence: { backend: observationBackend },
    },
  };

  return Agent.create(config, deps);
}

function getLiveAgent(agentId: string): Promise<Agent> {
  const existing = liveAgents.get(agentId);
  if (existing) {
    return existing;
  }

  const pending = createOrResumeAgent(agentId).catch((error) => {
    liveAgents.delete(agentId);
    throw error;
  });
  liveAgents.set(agentId, pending);
  return pending;
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data, null, 2));
}

function parseJsonBody(body: string): any {
  if (!body.trim()) {
    return {};
  }

  try {
    return JSON.parse(body);
  } catch (error: any) {
    throw new Error(`Request body must be valid JSON: ${error?.message || 'parse failed'}`);
  }
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function getExampleRoutes(port: number) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const agentBase = `${baseUrl}/api/observability/agents/${demoAgentId}`;

  return {
    baseUrl,
    docs: `${baseUrl}/`,
    sendPrompt: `${baseUrl}/agents/demo/send`,
    metrics: `${agentBase}/metrics`,
    runtimeObservations: `${agentBase}/observations/runtime`,
    persistedObservations: `${agentBase}/observations/persisted`,
    runtimeRun: `${agentBase}/observations/runtime/runs/<runId>`,
    persistedRun: `${agentBase}/observations/persisted/runs/<runId>`,
    healthz: `${baseUrl}/healthz`,
  };
}

function getRequiredEnvHints(): string[] {
  if (demoModelConfig.provider === 'anthropic') {
    return ['ANTHROPIC_API_KEY'];
  }
  if (demoModelConfig.provider === 'gemini') {
    return ['GEMINI_API_KEY'];
  }
  if (demoModelConfig.provider === 'glm') {
    return ['OPENAI_API_KEY', 'OPENAI_MODEL_ID=glm-5', 'OPENAI_BASE_URL'];
  }
  return ['OPENAI_API_KEY'];
}

function buildExampleIndex(port: number) {
  const routes = getExampleRoutes(port);
  return {
    message: 'KODE observability demo server',
    purpose: 'Application-layer HTTP wrapper around SDK observability readers and persistence.',
    model: {
      provider: demoModelConfig.provider,
      model: demoModelConfig.model,
      baseUrl: demoModelConfig.baseUrl,
    },
    boundaries: [
      'HTTP stays in the example application, not in Agent or SDK core.',
      'Use runtime reader for live state and persisted reader for history/audit.',
      'Filter internal/debug fields before exposing data outside trusted systems.',
    ],
    requiredEnv: getRequiredEnvHints(),
    routes,
    sampleCurl: {
      sendPrompt: `curl -X POST ${routes.sendPrompt} -H 'content-type: application/json' -d '{"prompt":"Summarize KODE observability in one sentence."}'`,
      metrics: `curl ${routes.metrics}`,
      runtimeObservations: `curl '${routes.runtimeObservations}?limit=20'`,
      persistedObservations: `curl '${routes.persistedObservations}?limit=20'`,
    },
  };
}

const observabilityHandler = createExampleObservabilityHttpHandler({
  basePath: '/api/observability',
  resolveRuntimeSource: async (agentId) => {
    if (agentId !== demoAgentId) {
      return undefined;
    }
    const agent = await getLiveAgent(agentId);
    return {
      getMetricsSnapshot: () => agent.getMetricsSnapshot(),
      getObservationReader: () => agent.getObservationReader(),
    };
  },
  resolvePersistedReader: async (agentId) => (agentId === demoAgentId ? persistedReader : undefined),
});

const server = http.createServer(async (req, res) => {
  try {
    const method = req.method || 'GET';
    const url = new URL(req.url || '/', `http://127.0.0.1:${defaultPort}`);
    const path = url.pathname || '/';

    if (method === 'GET' && (path === '/' || path === '/api/observability')) {
      return sendJson(res, 200, buildExampleIndex(defaultPort));
    }

    if (method === 'POST' && path === '/agents/demo/send') {
      const body = await readBody(req);
      const payload = parseJsonBody(body);
      const agent = await getLiveAgent(demoAgentId);
      const result = await agent.chat(payload.prompt || 'say hello');
      return sendJson(res, 200, result);
    }

    if (method === 'GET' && path === '/healthz') {
      return sendJson(res, 200, { ok: true });
    }

    if (path.startsWith('/api/observability/')) {
      const response = await observabilityHandler({
        method,
        url: req.url || '/',
      });

      for (const [key, value] of Object.entries(response.headers)) {
        res.setHeader(key, value);
      }
      return sendJson(res, response.status, response.body);
    }

    return sendJson(res, 404, {
      error: 'not_found',
      ...buildExampleIndex(defaultPort),
    });
  } catch (error: any) {
    const message = error?.message || 'Unexpected server error';
    const status = message.startsWith('Request body must be valid JSON') ? 400 : 500;
    return sendJson(res, status, {
      error: status === 400 ? 'bad_request' : 'internal_error',
      message,
    });
  }
});

server.listen(defaultPort, '127.0.0.1', () => {
  const routes = getExampleRoutes(defaultPort);
  console.log(`Observability demo server listening on ${routes.baseUrl}`);
  console.log(`Model provider: ${demoModelConfig.provider}`);
  console.log(`Model id: ${demoModelConfig.model}`);
  console.log(`Docs: ${routes.docs}`);
  console.log(`POST prompt: ${routes.sendPrompt}`);
  console.log(`Runtime metrics: ${routes.metrics}`);
  console.log(`Runtime observations: ${routes.runtimeObservations}`);
  console.log(`Persisted observations: ${routes.persistedObservations}`);
});
