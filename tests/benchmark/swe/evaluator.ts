// ---------------------------------------------------------------------------
// SWE benchmark evaluator — run tests in a temp directory
// ---------------------------------------------------------------------------

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const TEST_TIMEOUT_MS = 15_000;

export interface EvalResult {
  passed: boolean;
  output: string;
  error?: string;
}

/**
 * Write files to a temporary directory, run the test command, return pass/fail.
 */
export function evaluateCase(
  files: Record<string, string>,
  testCommand: string,
  workDir: string,
): EvalResult {
  // Ensure work directory exists
  fs.mkdirSync(workDir, { recursive: true });

  // Write all files
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(workDir, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
  }

  // Run the test command
  try {
    const output = execSync(testCommand, {
      cwd: workDir,
      timeout: TEST_TIMEOUT_MS,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { passed: true, output: output.trim() };
  } catch (err: any) {
    const stdout = (err.stdout || '').toString().trim();
    const stderr = (err.stderr || '').toString().trim();
    return {
      passed: false,
      output: stdout,
      error: stderr || err.message || String(err),
    };
  }
}

/**
 * Clean up a work directory.
 */
export function cleanupWorkDir(workDir: string): void {
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}
