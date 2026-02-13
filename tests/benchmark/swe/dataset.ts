// ---------------------------------------------------------------------------
// SWE benchmark dataset loader
// ---------------------------------------------------------------------------

import fs from 'fs';
import path from 'path';
import type { FullSWEInstance } from './docker-evaluator';

export interface MiniCase {
  id: string;
  description: string;
  files: Record<string, string>;
  test_command: string;
}

/**
 * Load mini-SWE cases from the local JSON file.
 */
export function loadMiniCases(): MiniCase[] {
  const casesPath = path.join(__dirname, 'cases', 'mini-cases.json');
  if (!fs.existsSync(casesPath)) {
    console.log(`  SWE: cases file not found at ${casesPath}`);
    return [];
  }
  const raw = fs.readFileSync(casesPath, 'utf-8');
  return JSON.parse(raw) as MiniCase[];
}

/**
 * Load curated SWE-bench instances for full mode.
 */
export function loadCuratedInstances(): FullSWEInstance[] {
  const instancesPath = path.join(__dirname, 'cases', 'curated-instances.json');
  if (!fs.existsSync(instancesPath)) {
    console.log(`  SWE: curated instances file not found at ${instancesPath}`);
    return [];
  }
  const raw = fs.readFileSync(instancesPath, 'utf-8');
  return JSON.parse(raw) as FullSWEInstance[];
}
