import fs from 'fs';
import path from 'path';
import type { FullSWEInstance } from './docker-evaluator';

export function loadVerifiedInstances(): FullSWEInstance[] {
  const instancesPath = path.join(__dirname, 'cases', 'verified-instances.json');
  if (!fs.existsSync(instancesPath)) {
    console.log(`  SWE: verified instances file not found at ${instancesPath}`);
    return [];
  }
  const raw = fs.readFileSync(instancesPath, 'utf-8');
  return JSON.parse(raw) as FullSWEInstance[];
}
