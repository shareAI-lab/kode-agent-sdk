import { existsSync } from 'node:fs';
import * as dotenv from 'dotenv';

const preferred = process.env.KODE_EXAMPLE_ENV_FILE;
const envFiles = preferred
  ? [preferred]
  : [
      '.env',
      '.env.local',
      ...(!existsSync('.env') && existsSync('.env.test') ? ['.env.test'] : []),
    ];

for (const path of envFiles) {
  dotenv.config({ path, override: false });
}
