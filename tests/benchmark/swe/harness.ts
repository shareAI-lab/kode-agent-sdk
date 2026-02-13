// ---------------------------------------------------------------------------
// SWE benchmark harness — sends code + issue to model, parses corrected files
// ---------------------------------------------------------------------------

import type { ModelProvider } from '../../../src/infra/providers/types';
import type { Message } from '../../../src/core/types';
import type { MiniCase } from './dataset';

export interface HarnessResult {
  correctedFiles: Record<string, string>;
  tokens: number;
  error?: string;
}

const SYSTEM_PROMPT = `You are a software engineer fixing bugs in source code.
You will be given a bug report and the project files.
Your task is to fix the bug so all tests pass.

Rules:
- Only modify source files. NEVER modify test files.
- Output the COMPLETE corrected file content using this exact format:

--- FILE: <filename> ---
<full corrected file content>
--- END FILE ---

- You may output multiple files if needed.
- Do NOT include any explanation outside the file markers.
- Output ONLY the corrected file(s), nothing else.`;

/**
 * Send a mini-SWE case to the model and parse corrected files from the response.
 */
export async function runHarness(
  provider: ModelProvider,
  caseData: MiniCase,
): Promise<HarnessResult> {
  // Build user message with issue + all file contents
  const fileListing = Object.entries(caseData.files)
    .map(([name, content]) => `--- ${name} ---\n${content}`)
    .join('\n');

  const userMessage = [
    'Bug report:',
    caseData.description,
    '',
    'Project files:',
    fileListing,
    '',
    'Fix the bug in the source file(s) so that all tests pass.',
    'Output the corrected file(s) using the --- FILE: <name> --- / --- END FILE --- format.',
  ].join('\n');

  const messages: Message[] = [
    { role: 'user', content: [{ type: 'text', text: userMessage }] },
  ];

  try {
    const response = await provider.complete(messages, { system: SYSTEM_PROMPT });

    const text = response.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map(b => b.text)
      .join('');

    const tokens =
      (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0);

    const correctedFiles = parseFileBlocks(text);

    // If no file blocks found, try to infer from the response
    if (Object.keys(correctedFiles).length === 0) {
      // Fallback: look for code fences with the src filename
      const fallback = parseFallbackCodeBlocks(text, caseData.files);
      if (Object.keys(fallback).length > 0) {
        return { correctedFiles: fallback, tokens };
      }
      return { correctedFiles: {}, tokens, error: 'No corrected files found in model response' };
    }

    return { correctedFiles, tokens };
  } catch (err: any) {
    return { correctedFiles: {}, tokens: 0, error: err.message || String(err) };
  }
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/**
 * Parse `--- FILE: <name> --- ... --- END FILE ---` blocks from model output.
 */
function parseFileBlocks(text: string): Record<string, string> {
  const files: Record<string, string> = {};
  const regex = /---\s*FILE:\s*(.+?)\s*---\n([\s\S]*?)---\s*END FILE\s*---/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const filename = match[1].trim();
    const content = match[2];
    // Only accept source files, never test files
    if (!filename.includes('test')) {
      files[filename] = content;
    }
  }

  return files;
}

/**
 * Fallback: try to extract code from markdown fences like ```js ... ```
 * and match them to source filenames (excluding test files).
 */
function parseFallbackCodeBlocks(text: string, originalFiles: Record<string, string>): Record<string, string> {
  const files: Record<string, string> = {};
  const sourceFiles = Object.keys(originalFiles).filter(f => !f.includes('test'));

  if (sourceFiles.length !== 1) return files; // Only works for single source file

  const srcName = sourceFiles[0];
  // Match the last code fence (most likely the final corrected version)
  const fenceRegex = /```(?:js|javascript)?\n([\s\S]*?)```/g;
  let lastMatch: string | null = null;
  let match: RegExpExecArray | null;

  while ((match = fenceRegex.exec(text)) !== null) {
    lastMatch = match[1];
  }

  if (lastMatch) {
    files[srcName] = lastMatch;
  }

  return files;
}
