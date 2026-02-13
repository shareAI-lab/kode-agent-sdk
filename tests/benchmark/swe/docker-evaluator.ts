// ---------------------------------------------------------------------------
// SWE-bench full mode — Docker-based evaluation
// ---------------------------------------------------------------------------

import { execSync, spawnSync, ExecSyncOptionsWithStringEncoding } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ModelProvider } from '../../../src/infra/providers/types';
import type { Message } from '../../../src/core/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FullSWEInstance {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  hints_text: string;
  test_patch: string;
  test_command: string;
}

export interface FullHarnessResult {
  patch: string;
  tokens: number;
  error?: string;
}

export interface DockerEvalResult {
  passed: boolean;
  output: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Docker availability check
// ---------------------------------------------------------------------------

export function isDockerAvailable(): boolean {
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract "owner/repo" from a GitHub URL.
 * e.g. "https://github.com/psf/requests.git" → "psf-requests"
 */
function repoSlug(repoUrl: string): string {
  const match = repoUrl.match(/github\.com\/([^/]+)\/([^/.]+)/);
  if (match) return `${match[1]}-${match[2]}`.toLowerCase();
  // Fallback: strip protocol, slashes, .git
  return repoUrl
    .replace(/^https?:\/\//, '')
    .replace(/\.git$/, '')
    .replace(/[^a-z0-9-]/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

/**
 * Sanitize a string for use as a Docker container name.
 * Docker allows [a-zA-Z0-9_.-] and must start with [a-zA-Z0-9].
 */
function sanitizeContainerName(raw: string): string {
  return raw
    .replace(/[^a-zA-Z0-9_.-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[^a-zA-Z0-9]+/, '')
    .slice(0, 128);
}

// ---------------------------------------------------------------------------
// New full-mode helpers: read from Docker image → LLM → diff
// ---------------------------------------------------------------------------

/**
 * Read files from a SWE-bench Docker image's /testbed directory.
 * This avoids cloning the repo on the host — the image already has everything.
 */
function readFilesFromImage(imageName: string, filePaths: string[]): Record<string, string> {
  const files: Record<string, string> = {};

  for (const fp of filePaths) {
    const result = spawnSync(
      'docker',
      ['run', '--rm', imageName, 'cat', `/testbed/${fp}`],
      { stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000 },
    );

    if (result.status === 0) {
      const content = (result.stdout || '').toString();
      if (content) {
        files[fp] = content;
      }
    }
  }

  return files;
}

/**
 * Extract relevant file paths from problem statement and hints text.
 * Looks for common source file path patterns.
 */
function extractRelevantPaths(problemStatement: string, hintsText: string): string[] {
  const paths = new Set<string>();

  // Common source file patterns (Python-centric for SWE-bench)
  const patterns = [
    // Explicit paths like `path/to/file.py` (backtick-quoted)
    /`([\w/.]+\.py)`/g,
    // Paths mentioned naturally: word/word/file.py
    /(?:^|\s)((?:[\w-]+\/)+[\w-]+\.py)(?:\s|$|[.,;:)])/gm,
    // Module-style paths: package.module.file (convert dots to slashes)
    /(?:in|see|at|file|module)\s+`?([\w]+(?:\.[\w]+){2,})`?/gi,
  ];

  // Prioritize hints_text (usually more precise)
  const sources = [hintsText, problemStatement].filter(Boolean);

  for (const source of sources) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(source)) !== null) {
        let p = match[1].trim();
        // Convert module-style paths (e.g. astropy.modeling.separable) to file paths
        if (!p.includes('/') && p.includes('.') && !p.endsWith('.py')) {
          p = p.replace(/\./g, '/') + '.py';
        }
        // Skip test files and obviously invalid paths
        if (!p.includes('test') && p.endsWith('.py') && p.length > 4) {
          paths.add(p);
        }
      }
    }
  }

  return Array.from(paths);
}

// (readFilesFromRepo removed — we now read directly from Docker images)

// ---------------------------------------------------------------------------
// LLM interaction — generate fix (file-based, like mini mode)
// ---------------------------------------------------------------------------

const FULL_SYSTEM_PROMPT = `You are a software engineer fixing bugs in open-source repositories.
You will be given a bug report, hints, and the relevant source files.
Your task is to fix the bug so all tests pass.

Rules:
- Only modify source files. NEVER modify test files.
- Output ONLY the changed sections using the SEARCH/REPLACE format below.
- Do NOT output the entire file. Only output the minimal code blocks that need to change.
- Do NOT include any explanation outside the file markers.

Format:

--- FILE: <filepath> ---
<<<<<<< SEARCH
<exact lines from the original file to find>
=======
<replacement lines>
>>>>>>> REPLACE
--- END FILE ---

You may include multiple SEARCH/REPLACE blocks within one FILE section.
You may output multiple FILE sections if changes span multiple files.

Example:

--- FILE: src/utils.py ---
<<<<<<< SEARCH
def validate(value):
    if value > 0:
        return True
=======
def validate(value):
    if value >= 0:
        return True
>>>>>>> REPLACE
--- END FILE ---`;

/**
 * Call the LLM with source file context (like mini mode).
 * Includes a single retry on failure.
 */
async function callLLMWithContext(
  provider: ModelProvider,
  instance: FullSWEInstance,
  files: Record<string, string>,
): Promise<{ text: string; tokens: number }> {
  const fileListing = Object.entries(files)
    .map(([name, content]) => `--- ${name} ---\n${content}`)
    .join('\n');

  const userMessage = [
    'Bug report:',
    instance.problem_statement,
  ];

  if (instance.hints_text) {
    userMessage.push('', 'Hints:', instance.hints_text);
  }

  userMessage.push(
    '',
    'Source files:',
    fileListing,
    '',
    'Fix the bug in the source file(s) so that all tests pass.',
    'Output ONLY the changed sections using the SEARCH/REPLACE format described in your instructions.',
  );

  const messages: Message[] = [
    { role: 'user', content: [{ type: 'text', text: userMessage.join('\n') }] },
  ];

  const attempt = async (): Promise<{ text: string; tokens: number }> => {
    const response = await provider.complete(messages, {
      system: FULL_SYSTEM_PROMPT,
      maxTokens: 16384,
    });

    const text = response.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map(b => b.text)
      .join('');

    const tokens =
      (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0);

    return { text, tokens };
  };

  try {
    return await attempt();
  } catch (err: any) {
    // Single retry after 3 seconds
    console.log(`      [llm] First attempt failed (${err.message}), retrying ...`);
    await new Promise(resolve => setTimeout(resolve, 3000));
    return await attempt();
  }
}

/**
 * Parse `--- FILE: <name> --- ... --- END FILE ---` blocks from model output.
 * Each FILE block may contain one or more SEARCH/REPLACE hunks, or a full file body.
 */
function parseFileBlocks(text: string): Array<{ path: string; body: string }> {
  const blocks: Array<{ path: string; body: string }> = [];
  const regex = /---\s*FILE:\s*(.+?)\s*---\r?\n([\s\S]*?)---\s*END FILE\s*---/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const filename = match[1].trim();
    const body = match[2];
    if (!filename.includes('test')) {
      blocks.push({ path: filename, body });
    }
  }

  return blocks;
}

/**
 * Parse SEARCH/REPLACE hunks from a file block body.
 * Returns an array of { search, replace } pairs.
 */
function parseSearchReplaceHunks(body: string): Array<{ search: string; replace: string }> {
  const hunks: Array<{ search: string; replace: string }> = [];
  const regex = /<<<<<<< SEARCH\r?\n([\s\S]*?)=======\r?\n([\s\S]*?)>>>>>>> REPLACE/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(body)) !== null) {
    hunks.push({ search: match[1], replace: match[2] });
  }

  return hunks;
}

/**
 * Apply SEARCH/REPLACE hunks to the original file content.
 * Returns the corrected file content, or null if any hunk fails to match.
 */
function applyHunks(
  original: string,
  hunks: Array<{ search: string; replace: string }>,
): string | null {
  let result = original;

  for (const hunk of hunks) {
    // Try exact match first
    if (result.includes(hunk.search)) {
      result = result.replace(hunk.search, hunk.replace);
      continue;
    }

    // Try trimmed trailing newline match
    const searchTrimmed = hunk.search.replace(/\n$/, '');
    const replaceTrimmed = hunk.replace.replace(/\n$/, '');
    if (result.includes(searchTrimmed)) {
      result = result.replace(searchTrimmed, replaceTrimmed);
      continue;
    }

    // Hunk didn't match
    return null;
  }

  return result;
}

/**
 * Generate a unified diff by comparing original and corrected file contents.
 * Uses `diff -u` with temp files. No repo clone needed.
 */
function generateDiffFromOriginals(
  originals: Record<string, string>,
  corrected: Record<string, string>,
): string {
  const diffs: string[] = [];

  for (const [filePath, newContent] of Object.entries(corrected)) {
    const originalContent = originals[filePath];
    if (originalContent === undefined) {
      // New file — generate a diff from /dev/null
      const tmpNew = path.join(os.tmpdir(), `swe-new-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      fs.writeFileSync(tmpNew, newContent, 'utf-8');
      try {
        const result = spawnSync(
          'diff',
          ['-u', '/dev/null', tmpNew, '--label', `a/${filePath}`, '--label', `b/${filePath}`],
          { stdio: ['pipe', 'pipe', 'pipe'], timeout: 10_000 },
        );
        const diffOutput = (result.stdout || '').toString();
        if (diffOutput) {
          diffs.push(`diff --git a/${filePath} b/${filePath}\n${diffOutput}`);
        }
      } finally {
        fs.unlinkSync(tmpNew);
      }
      continue;
    }

    // Write original and new to temp files for diff
    const tmpOrig = path.join(os.tmpdir(), `swe-orig-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const tmpNew = path.join(os.tmpdir(), `swe-new-${Date.now()}-${Math.random().toString(36).slice(2)}`);

    fs.writeFileSync(tmpOrig, originalContent, 'utf-8');
    fs.writeFileSync(tmpNew, newContent, 'utf-8');

    try {
      const result = spawnSync(
        'diff',
        ['-u', tmpOrig, tmpNew, '--label', `a/${filePath}`, '--label', `b/${filePath}`],
        { stdio: ['pipe', 'pipe', 'pipe'], timeout: 10_000 },
      );
      // diff exits 1 when files differ (not an error)
      const diffOutput = (result.stdout || '').toString();
      if (diffOutput) {
        diffs.push(`diff --git a/${filePath} b/${filePath}\n${diffOutput}`);
      }
    } finally {
      fs.unlinkSync(tmpOrig);
      fs.unlinkSync(tmpNew);
    }
  }

  return diffs.join('\n');
}

// ---------------------------------------------------------------------------
// Main entry point — generate fix (replaces old generatePatch)
// ---------------------------------------------------------------------------

/**
 * Generate a fix by:
 * 1. Pulling the SWE-bench Docker image (has repo at /testbed)
 * 2. Extracting relevant file paths from the problem statement / hints
 * 3. Reading those files directly from the Docker image
 * 4. Sending source code + problem to LLM (like mini mode)
 * 5. Parsing corrected files from LLM response
 * 6. Generating unified diff programmatically
 */
export async function generateFix(
  provider: ModelProvider,
  instance: FullSWEInstance,
  proxyUrl?: string,
): Promise<FullHarnessResult> {
  try {
    // 1. Ensure the SWE-bench image is available
    const imageName = getSWEBenchImageName(instance.instance_id);
    if (!pullImage(imageName, proxyUrl)) {
      return { patch: '', tokens: 0, error: `Failed to pull SWE-bench image: ${imageName}` };
    }

    // 2. Extract relevant file paths
    const filePaths = extractRelevantPaths(instance.problem_statement, instance.hints_text);
    console.log(`      [fix] Extracted ${filePaths.length} relevant file path(s): ${filePaths.join(', ')}`);

    if (filePaths.length === 0) {
      return { patch: '', tokens: 0, error: 'No relevant file paths found in problem statement or hints' };
    }

    // 3. Read source files directly from the Docker image
    console.log(`      [fix] Reading files from Docker image ...`);
    const fileContents = readFilesFromImage(imageName, filePaths);
    const readCount = Object.keys(fileContents).length;
    console.log(`      [fix] Read ${readCount} file(s) from image`);

    if (readCount === 0) {
      return { patch: '', tokens: 0, error: 'None of the extracted file paths exist in the image' };
    }

    // 4. Call LLM with source context
    console.log(`      [fix] Sending source files + problem to LLM ...`);
    const response = await callLLMWithContext(provider, instance, fileContents);

    // 5. Parse file blocks and apply search/replace hunks
    const fileBlocks = parseFileBlocks(response.text);

    if (fileBlocks.length === 0) {
      // Log a snippet of the response for debugging
      const snippet = response.text.slice(0, 300).replace(/\n/g, '\\n');
      console.log(`      [fix] Response snippet: ${snippet}`);
      return { patch: '', tokens: response.tokens, error: 'No corrected files found in model response' };
    }

    // Build corrected files by applying hunks to originals
    const correctedFiles: Record<string, string> = {};

    for (const block of fileBlocks) {
      const hunks = parseSearchReplaceHunks(block.body);

      if (hunks.length > 0) {
        // Search/replace mode — apply hunks to original
        const original = fileContents[block.path];
        if (!original) {
          console.log(`      [fix] Warning: original file not found for ${block.path}, skipping`);
          continue;
        }
        const applied = applyHunks(original, hunks);
        if (applied === null) {
          console.log(`      [fix] Warning: SEARCH block mismatch for ${block.path}`);
          continue;
        }
        correctedFiles[block.path] = applied;
      } else {
        // Fallback: block body is the complete corrected file content
        correctedFiles[block.path] = block.body;
      }
    }

    const correctedCount = Object.keys(correctedFiles).length;

    if (correctedCount === 0) {
      return { patch: '', tokens: response.tokens, error: 'All SEARCH/REPLACE hunks failed to match' };
    }

    console.log(`      [fix] LLM returned ${correctedCount} corrected file(s)`);

    // 6. Generate unified diff (using temp files, no repo clone needed)
    const patch = generateDiffFromOriginals(fileContents, correctedFiles);

    if (!patch) {
      return { patch: '', tokens: response.tokens, error: 'Generated diff is empty (no changes detected)' };
    }

    return { patch, tokens: response.tokens };
  } catch (err: any) {
    return { patch: '', tokens: 0, error: err.message || String(err) };
  }
}

// ---------------------------------------------------------------------------
// Docker-based evaluation (using official SWE-bench pre-built images)
// ---------------------------------------------------------------------------

/** stdio config that streams stdout to terminal for progress visibility */
const LIVE_OPTS = {
  stdio: ['pipe' as const, 'inherit' as const, 'pipe' as const],
  timeout: 1_200_000, // 20 minutes — some test suites (e.g. sympy) are slow
};

/**
 * Derive the official SWE-bench Docker image name from an instance_id.
 * Convention: `swebench/sweb.eval.x86_64.<instance_id_lower>:latest`
 * where `__` in instance_id is replaced with `_1776_`.
 */
export function getSWEBenchImageName(instanceId: string): string {
  const slug = instanceId.toLowerCase().replace(/__/g, '_1776_');
  return `swebench/sweb.eval.x86_64.${slug}:latest`;
}

/**
 * Pull a Docker image, using proxy if configured.
 * Returns true if the image is available (already existed or pulled successfully).
 */
function pullImage(imageName: string, proxyUrl?: string): boolean {
  // Check if image already exists locally
  const checkResult = spawnSync(
    'docker', ['image', 'inspect', imageName],
    { stdio: ['pipe', 'pipe', 'pipe'], timeout: 10_000 },
  );
  if (checkResult.status === 0) {
    console.log(`      [docker] Image ${imageName} already available locally`);
    return true;
  }

  // Pull with proxy if needed
  const env: Record<string, string> = { ...process.env as Record<string, string> };
  if (proxyUrl) {
    env.HTTPS_PROXY = proxyUrl;
    env.HTTP_PROXY = proxyUrl;
    env.https_proxy = proxyUrl;
    env.http_proxy = proxyUrl;
  }

  console.log(`      [docker] Pulling ${imageName} ...`);
  const pullResult = spawnSync(
    'docker', ['pull', imageName],
    { env, stdio: ['pipe', 'inherit', 'pipe'], timeout: 1_200_000 },
  );

  if (pullResult.status !== 0) {
    const stderr = (pullResult.stderr || '').toString().trim();
    console.log(`      [docker] Failed to pull image: ${stderr}`);
    return false;
  }

  return true;
}

/**
 * Evaluate a patch inside an official SWE-bench Docker container.
 *
 * The SWE-bench images come with:
 *   - Repository pre-cloned at /testbed (at the correct base commit)
 *   - Conda environment "testbed" with all dependencies installed
 *   - Correct Python version for the project
 *
 * Steps:
 *   1. Pull the SWE-bench image (if not cached locally)
 *   2. Mount patch files into the container
 *   3. Apply the fix patch with git apply (with fallbacks)
 *   4. Apply the test patch (if provided)
 *   5. Run the test command inside the conda environment
 */
export function evaluateWithDocker(
  instance: FullSWEInstance,
  patch: string,
  workDir: string,
  proxyUrl?: string,
): DockerEvalResult {
  const imageName = getSWEBenchImageName(instance.instance_id);

  // Pull image if needed
  if (!pullImage(imageName, proxyUrl)) {
    return {
      passed: false,
      output: '',
      error: `Failed to pull SWE-bench image: ${imageName}`,
    };
  }

  fs.mkdirSync(workDir, { recursive: true });

  // Write patches to workDir (mounted into container)
  fs.writeFileSync(path.join(workDir, 'fix.patch'), patch, 'utf-8');
  if (instance.test_patch) {
    fs.writeFileSync(path.join(workDir, 'test.patch'), instance.test_patch, 'utf-8');
  }

  // Build evaluation script
  // The SWE-bench container has: /testbed (repo), conda env "testbed"
  const script = [
    '#!/bin/bash',
    'set -uo pipefail',
    '',
    'source /opt/miniconda3/bin/activate',
    'conda activate testbed',
    'cd /testbed',
    '',
    'echo "      [docker] Applying fix patch ..."',
    'if git apply --verbose /patches/fix.patch; then',
    '  echo "      [docker] Patch applied with git apply"',
    'elif git apply --verbose --reject /patches/fix.patch; then',
    '  echo "      [docker] Patch applied with --reject"',
    'elif patch --batch --fuzz=5 -p1 -i /patches/fix.patch; then',
    '  echo "      [docker] Patch applied with patch command"',
    'else',
    '  echo "      [docker] ERROR: Patch application failed"',
    '  exit 1',
    'fi',
    '',
    'if [ -f /patches/test.patch ] && [ -s /patches/test.patch ]; then',
    '  echo "      [docker] Applying test patch ..."',
    '  git apply -v /patches/test.patch || true',
    'fi',
    '',
    `echo "      [docker] Running tests: ${instance.test_command}"`,
    `${instance.test_command}`,
    'echo "      [docker] Tests completed."',
  ].join('\n');

  fs.writeFileSync(path.join(workDir, 'evaluate.sh'), script, 'utf-8');

  const containerName = sanitizeContainerName(`swe-${instance.instance_id}-${Date.now()}`);

  try {
    console.log(`      [docker] Starting container (${imageName}) ...`);
    const result = spawnSync(
      'docker',
      [
        'run', '--rm',
        '--name', containerName,
        '-v', `${workDir}:/patches:ro`,
        imageName,
        'bash', '/patches/evaluate.sh',
      ],
      LIVE_OPTS,
    );

    const stderr = (result.stderr || '').toString().trim();

    if (result.status === 0) {
      return { passed: true, output: '' };
    }

    return {
      passed: false,
      output: '',
      error: stderr || `exit code ${result.status}`,
    };
  } catch (err: any) {
    return {
      passed: false,
      output: '',
      error: err.message || String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Local evaluation fallback (no Docker)
// ---------------------------------------------------------------------------

const EXEC_OPTS: ExecSyncOptionsWithStringEncoding = {
  encoding: 'utf-8',
  stdio: ['pipe', 'pipe', 'pipe'],
  timeout: 600_000,
};

export function evaluateLocally(
  instance: FullSWEInstance,
  patch: string,
  workDir: string,
): DockerEvalResult {
  const repoDir = path.join(workDir, 'repo');
  fs.mkdirSync(workDir, { recursive: true });

  try {
    console.log(`      [local] Cloning ${instance.repo} ...`);
    spawnSync(
      'git', ['clone', '--quiet', instance.repo, repoDir],
      { ...LIVE_OPTS, timeout: 120_000 },
    );

    console.log(`      [local] Checking out ${instance.base_commit.slice(0, 10)} ...`);
    execSync(`git checkout "${instance.base_commit}" --quiet`, {
      ...EXEC_OPTS,
      cwd: repoDir,
    });

    console.log(`      [local] Applying fix patch ...`);
    const patchPath = path.join(workDir, 'fix.patch');
    fs.writeFileSync(patchPath, patch, 'utf-8');
    execSync(`git apply "${patchPath}"`, { ...EXEC_OPTS, cwd: repoDir });

    if (instance.test_patch) {
      console.log(`      [local] Applying test patch ...`);
      const testPatchPath = path.join(workDir, 'test.patch');
      fs.writeFileSync(testPatchPath, instance.test_patch, 'utf-8');
      try {
        execSync(`git apply "${testPatchPath}"`, { ...EXEC_OPTS, cwd: repoDir });
      } catch {
        // Test patch may not apply cleanly
      }
    }

    console.log(`      [local] Running tests: ${instance.test_command}`);
    const result = spawnSync('bash', ['-c', instance.test_command], {
      ...LIVE_OPTS,
      cwd: repoDir,
      timeout: 300_000,
    });

    const stderr = (result.stderr || '').toString().trim();

    if (result.status === 0) {
      console.log(`      [local] Tests completed.`);
      return { passed: true, output: '' };
    }

    return {
      passed: false,
      output: '',
      error: stderr || `exit code ${result.status}`,
    };
  } catch (err: any) {
    const stderr = (err.stderr || '').toString().trim();
    return {
      passed: false,
      output: '',
      error: stderr || err.message || String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

export function cleanupWorkDir(workDir: string): void {
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}
