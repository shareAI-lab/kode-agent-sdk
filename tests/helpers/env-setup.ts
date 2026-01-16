import fs from 'fs';
import path from 'path';
import * as dotenv from 'dotenv';

const envPath = process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.test');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

const UNSUPPORTED_KEYS = ['ANTHROPIC_API_TOKEN'];

for (const key of UNSUPPORTED_KEYS) {
  if (key in process.env) {
    delete process.env[key as keyof NodeJS.ProcessEnv];
  }
}

export const TEST_ENV_SANITIZED = true;
