import type {
  ObservationEnvelope,
  ObservationKind,
  ObservationListOptions,
  ObservationReader,
  ObservationRunView,
  ObservationStatus,
  PersistedObservationListOptions,
  PersistedObservationReader,
} from '@shareai-lab/kode-sdk';

export type ObservabilityHttpRequest = {
  method?: string;
  url: string;
};

export type ObservabilityHttpResponse = {
  status: number;
  headers: Record<string, string>;
  body: unknown;
};

export type RuntimeHttpSource = {
  getMetricsSnapshot(): unknown | Promise<unknown>;
  getObservationReader(): ObservationReader | Promise<ObservationReader>;
};

export type ObservabilityHttpHandlerConfig = {
  basePath?: string;
  resolveRuntimeSource?: (
    agentId: string
  ) => RuntimeHttpSource | Promise<RuntimeHttpSource | undefined> | undefined;
  resolvePersistedReader?: (
    agentId: string
  ) => PersistedObservationReader | Promise<PersistedObservationReader | undefined> | undefined;
};

const OBSERVATION_KINDS: ObservationKind[] = ['agent_run', 'generation', 'tool', 'subagent', 'compression'];
const OBSERVATION_STATUSES: ObservationStatus[] = ['ok', 'error', 'cancelled'];

function normalizeBasePath(basePath?: string): string {
  if (!basePath || basePath === '/') {
    return '';
  }
  return `/${basePath.replace(/^\/+|\/+$/g, '')}`;
}

function buildJsonResponse(status: number, body: unknown): ObservabilityHttpResponse {
  return {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
    body,
  };
}

function splitSegments(pathname: string): string[] {
  return pathname.split('/').filter(Boolean);
}

function stripBasePath(pathname: string, basePath: string): string[] | undefined {
  const pathSegments = splitSegments(pathname);
  const baseSegments = splitSegments(basePath);

  if (baseSegments.length > pathSegments.length) {
    return undefined;
  }

  for (let index = 0; index < baseSegments.length; index++) {
    if (pathSegments[index] !== baseSegments[index]) {
      return undefined;
    }
  }

  return pathSegments.slice(baseSegments.length);
}

function readStringList(params: URLSearchParams, key: string): string[] | undefined {
  const values = params
    .getAll(key)
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);

  return values.length > 0 ? [...new Set(values)] : undefined;
}

function readNumberParam(params: URLSearchParams, key: string, opts?: {
  integer?: boolean;
  min?: number;
}): number | undefined {
  const raw = params.get(key);
  if (raw === null || raw.trim() === '') {
    return undefined;
  }

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid numeric query parameter "${key}"`);
  }
  if (opts?.integer && !Number.isInteger(value)) {
    throw new Error(`Query parameter "${key}" must be an integer`);
  }
  if (opts?.min !== undefined && value < opts.min) {
    throw new Error(`Query parameter "${key}" must be >= ${opts.min}`);
  }

  return value;
}

function readEnumList<T extends string>(
  params: URLSearchParams,
  key: string,
  allowed: readonly T[]
): T[] | undefined {
  const values = readStringList(params, key);
  if (!values) {
    return undefined;
  }

  const invalid = values.filter((value) => !allowed.includes(value as T));
  if (invalid.length > 0) {
    throw new Error(`Invalid "${key}" values: ${invalid.join(', ')}`);
  }

  return values as T[];
}

function parseRuntimeListOptions(agentId: string, params: URLSearchParams): ObservationListOptions {
  return {
    agentId,
    kinds: readEnumList(params, 'kinds', OBSERVATION_KINDS),
    statuses: readEnumList(params, 'statuses', OBSERVATION_STATUSES),
    limit: readNumberParam(params, 'limit', { integer: true, min: 1 }),
    sinceSeq: readNumberParam(params, 'sinceSeq', { integer: true, min: 0 }),
    runId: params.get('runId') || undefined,
    traceId: params.get('traceId') || undefined,
    parentSpanId: params.get('parentSpanId') || undefined,
  };
}

function parsePersistedListOptions(agentId: string, params: URLSearchParams): PersistedObservationListOptions {
  const options: PersistedObservationListOptions = {
    ...parseRuntimeListOptions(agentId, params),
    agentIds: [agentId],
    templateIds: readStringList(params, 'templateIds'),
    fromTimestamp: readNumberParam(params, 'fromTimestamp'),
    toTimestamp: readNumberParam(params, 'toTimestamp'),
  };

  if (
    options.fromTimestamp !== undefined &&
    options.toTimestamp !== undefined &&
    options.fromTimestamp > options.toTimestamp
  ) {
    throw new Error('Query parameter "fromTimestamp" must be <= "toTimestamp"');
  }

  return options;
}

function buildObservationListBody(
  agentId: string,
  source: 'runtime' | 'persisted',
  observations: ObservationEnvelope[]
) {
  return { agentId, source, observations };
}

function buildRunBody(agentId: string, source: 'runtime' | 'persisted', runView: ObservationRunView) {
  return {
    agentId,
    source,
    run: runView.run,
    observations: runView.observations,
  };
}

export function createExampleObservabilityHttpHandler(
  config: ObservabilityHttpHandlerConfig
): (request: ObservabilityHttpRequest) => Promise<ObservabilityHttpResponse> {
  const basePath = normalizeBasePath(config.basePath);

  return async (request) => {
    const method = (request.method || 'GET').toUpperCase();
    const parsed = new URL(request.url, 'http://kode-observability.local');
    const relativeSegments = stripBasePath(parsed.pathname, basePath);

    if (!relativeSegments) {
      return buildJsonResponse(404, { error: 'not_found' });
    }

    const [scope, agentId, resource, source, qualifier, targetId] = relativeSegments;

    if (method !== 'GET') {
      return {
        status: 405,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          allow: 'GET',
        },
        body: {
          error: 'method_not_allowed',
          message: `Method ${method} is not supported for ${parsed.pathname}`,
        },
      };
    }

    if (scope !== 'agents' || !agentId) {
      return buildJsonResponse(404, { error: 'not_found' });
    }

    try {
      if (resource === 'metrics') {
        const runtimeSource = config.resolveRuntimeSource ? await config.resolveRuntimeSource(agentId) : undefined;
        if (!runtimeSource) {
          return buildJsonResponse(404, { error: 'not_found', message: `Agent "${agentId}" was not found` });
        }
        return buildJsonResponse(200, await runtimeSource.getMetricsSnapshot());
      }

      if (resource !== 'observations' || (source !== 'runtime' && source !== 'persisted')) {
        return buildJsonResponse(404, { error: 'not_found' });
      }

      if (source === 'runtime') {
        const runtimeSource = config.resolveRuntimeSource ? await config.resolveRuntimeSource(agentId) : undefined;
        if (!runtimeSource) {
          return buildJsonResponse(404, { error: 'not_found', message: `Agent "${agentId}" was not found` });
        }

        const reader = await runtimeSource.getObservationReader();

        if (qualifier === 'runs' && targetId) {
          const runView = reader.getRun(targetId);
          return runView
            ? buildJsonResponse(200, buildRunBody(agentId, 'runtime', runView))
            : buildJsonResponse(404, { error: 'not_found', message: `Run "${targetId}" was not found` });
        }

        return buildJsonResponse(
          200,
          buildObservationListBody(agentId, 'runtime', reader.listObservations(parseRuntimeListOptions(agentId, parsed.searchParams)))
        );
      }

      const reader = config.resolvePersistedReader ? await config.resolvePersistedReader(agentId) : undefined;
      if (!reader) {
        return buildJsonResponse(404, {
          error: 'not_found',
          message: `Persisted reader for agent "${agentId}" was not found`,
        });
      }

      if (qualifier === 'runs' && targetId) {
        const runView = await reader.getRun(targetId);
        return runView
          ? buildJsonResponse(200, buildRunBody(agentId, 'persisted', runView))
          : buildJsonResponse(404, { error: 'not_found', message: `Run "${targetId}" was not found` });
      }

      return buildJsonResponse(
        200,
        buildObservationListBody(agentId, 'persisted', await reader.listObservations(parsePersistedListOptions(agentId, parsed.searchParams)))
      );
    } catch (error: any) {
      return buildJsonResponse(400, {
        error: 'bad_request',
        message: error?.message || 'Invalid request',
      });
    }
  };
}
