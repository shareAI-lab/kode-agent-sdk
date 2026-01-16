import http from 'http';

export interface MockRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body?: any;
  rawBody: string;
}

export interface MockResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: any;
  stream?: string[];
}

export interface MockPlan {
  assert?: (req: MockRequest) => void;
  response: MockResponse;
}

export async function createMockServer(plans: MockPlan[]) {
  const requests: MockRequest[] = [];
  const previousProxyFlag = process.env.KODE_USE_ENV_PROXY;
  process.env.KODE_USE_ENV_PROXY = '0';
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf-8');
      let parsedBody: any = undefined;
      if (rawBody.trim()) {
        try {
          parsedBody = JSON.parse(rawBody);
        } catch {
          parsedBody = rawBody;
        }
      }

      const request: MockRequest = {
        method: req.method || 'GET',
        url: req.url || '/',
        headers: req.headers,
        body: parsedBody,
        rawBody,
      };
      requests.push(request);

      const plan = plans.shift();
      if (!plan) {
        res.statusCode = 500;
        res.end('Unexpected request');
        return;
      }

      try {
        plan.assert?.(request);
      } catch (error: any) {
        res.statusCode = 500;
        res.end(`Assertion failed: ${error?.message || String(error)}`);
        return;
      }

      const status = plan.response.status ?? 200;
      const headers = { ...(plan.response.headers || {}) };

      if (plan.response.stream) {
        if (!headers['Content-Type']) {
          headers['Content-Type'] = 'text/event-stream';
        }
        res.writeHead(status, headers);
        res.flushHeaders();
        for (const chunk of plan.response.stream) {
          const payload = chunk.endsWith('\n') ? chunk : `${chunk}\n`;
          res.write(payload);
        }
        res.end();
        return;
      }

      let body = plan.response.body ?? '';
      if (body && typeof body === 'object') {
        body = JSON.stringify(body);
        if (!headers['Content-Type']) {
          headers['Content-Type'] = 'application/json';
        }
      }
      res.writeHead(status, headers);
      res.end(body);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to start mock server');
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    requests,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      if (previousProxyFlag === undefined) {
        delete process.env.KODE_USE_ENV_PROXY;
      } else {
        process.env.KODE_USE_ENV_PROXY = previousProxyFlag;
      }
    },
  };
}
