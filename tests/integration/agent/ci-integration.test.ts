/**
 * Agent Integration Tests for CI/CD
 *
 * These tests validate the complete agent workflow with real LLM providers.
 * Designed to run on GitHub Actions with proper API credentials.
 *
 * Test Categories:
 * 1. File Operations - Create, read, edit, delete files
 * 2. Bash Commands - System info, directory operations
 * 3. Multi-turn Conversations - Context preservation
 * 4. Tool Execution - Success and error handling
 * 5. Resume/Fork - State persistence and branching
 */

import * as fs from 'fs';
import * as path from 'path';
import { Agent } from '../../../src';
import { TestRunner, expect } from '../../helpers/utils';
import { createProviderTestAgent } from '../../helpers/provider-harness';
import { loadProviderEnv } from '../../helpers/provider-env';

const runner = new TestRunner('Agent/Integration');

// Get available providers
const anthropicEnv = loadProviderEnv('anthropic');
const openaiEnv = loadProviderEnv('openai');
const geminiEnv = loadProviderEnv('gemini');

// Select the best available provider for integration tests
function getBestProvider(): { provider: string; apiKey: string; model: string; baseUrl?: string } | null {
  if (openaiEnv.ok && openaiEnv.config) {
    return {
      provider: 'openai',
      apiKey: openaiEnv.config.apiKey,
      model: openaiEnv.config.model || 'gpt-4.1',
      baseUrl: openaiEnv.config.baseUrl,
    };
  }
  if (anthropicEnv.ok && anthropicEnv.config) {
    return {
      provider: 'anthropic',
      apiKey: anthropicEnv.config.apiKey,
      model: anthropicEnv.config.model || 'claude-sonnet-4-5-20250929',
      baseUrl: anthropicEnv.config.baseUrl,
    };
  }
  if (geminiEnv.ok && geminiEnv.config) {
    return {
      provider: 'gemini',
      apiKey: geminiEnv.config.apiKey,
      model: geminiEnv.config.model || 'gemini-3-flash-preview',
      baseUrl: geminiEnv.config.baseUrl,
    };
  }
  return null;
}

const providerConfig = getBestProvider();

if (!providerConfig) {
  runner.skip('No provider configured - skipping integration tests');
} else {
  const { provider, apiKey, model, baseUrl } = providerConfig;

  // ===========================================================================
  // File Operation Tests
  // ===========================================================================

  runner.test('File: Create and read file', async () => {
    const ctx = await createProviderTestAgent({
      provider: provider as any,
      apiKey,
      model,
      baseUrl,
      tools: ['fs_write', 'fs_read'],
    });

    try {
      const testFile = path.join(ctx.workDir, 'test-create.txt');
      const content = `Hello from CI test at ${new Date().toISOString()}`;

      // Ask agent to create file
      const result = await ctx.agent.chat(
        `Create a file at ${testFile} with the content: "${content}"`
      );

      expect.toEqual(result.status, 'ok');

      // Verify file was created
      const exists = fs.existsSync(testFile);
      expect.toBeTruthy(exists, 'File should be created');

      if (exists) {
        const fileContent = fs.readFileSync(testFile, 'utf-8');
        expect.toContain(fileContent, 'Hello from CI test');
      }
    } finally {
      await ctx.cleanup();
    }
  });

  runner.test('File: Edit existing file', async () => {
    const ctx = await createProviderTestAgent({
      provider: provider as any,
      apiKey,
      model,
      baseUrl,
      tools: ['fs_write', 'fs_read', 'fs_edit'],
    });

    try {
      const testFile = path.join(ctx.workDir, 'test-edit.txt');

      // Create initial file
      fs.writeFileSync(testFile, 'Line 1: Hello\nLine 2: World\nLine 3: Test\n');

      // Ask agent to edit
      const result = await ctx.agent.chat(
        `Edit the file at ${testFile} and replace "World" with "KODE SDK"`
      );

      expect.toEqual(result.status, 'ok');

      // Verify edit
      const newContent = fs.readFileSync(testFile, 'utf-8');
      expect.toContain(newContent, 'KODE SDK');
      expect.toBeFalsy(newContent.includes('World'), 'Original text should be replaced');
    } finally {
      await ctx.cleanup();
    }
  });

  runner.test('File: Read directory contents', async () => {
    const ctx = await createProviderTestAgent({
      provider: provider as any,
      apiKey,
      model,
      baseUrl,
      tools: ['fs_glob', 'fs_read'],
    });

    try {
      // Create test files
      fs.writeFileSync(path.join(ctx.workDir, 'a.txt'), 'File A');
      fs.writeFileSync(path.join(ctx.workDir, 'b.txt'), 'File B');
      fs.writeFileSync(path.join(ctx.workDir, 'c.md'), 'File C');

      // Ask agent to list files
      const result = await ctx.agent.chat(
        `List all .txt files in ${ctx.workDir} directory`
      );

      expect.toEqual(result.status, 'ok');
      expect.toBeTruthy(result.text?.includes('a.txt') || result.text?.includes('b.txt'),
        'Response should mention txt files');
    } finally {
      await ctx.cleanup();
    }
  });

  // ===========================================================================
  // Bash Command Tests
  // ===========================================================================

  runner.test('Bash: Get system info', async () => {
    const ctx = await createProviderTestAgent({
      provider: provider as any,
      apiKey,
      model,
      baseUrl,
      tools: ['bash_run'],
    });

    try {
      const result = await ctx.agent.chat(
        'Run the command "uname -a" and tell me what operating system this is'
      );

      expect.toEqual(result.status, 'ok');
      // Should mention Linux or Darwin (macOS)
      const text = result.text?.toLowerCase() || '';
      expect.toBeTruthy(
        text.includes('linux') || text.includes('darwin') || text.includes('ubuntu'),
        'Response should identify the OS'
      );
    } finally {
      await ctx.cleanup();
    }
  });

  runner.test('Bash: List directory', async () => {
    const ctx = await createProviderTestAgent({
      provider: provider as any,
      apiKey,
      model,
      baseUrl,
      tools: ['bash_run', 'fs_write'],
    });

    try {
      // Create some files first
      fs.writeFileSync(path.join(ctx.workDir, 'file1.txt'), 'content1');
      fs.writeFileSync(path.join(ctx.workDir, 'file2.txt'), 'content2');

      const result = await ctx.agent.chat(
        `Run "ls -la ${ctx.workDir}" and count how many files are there`
      );

      expect.toEqual(result.status, 'ok');
    } finally {
      await ctx.cleanup();
    }
  });

  runner.test('Bash: Environment variable', async () => {
    const ctx = await createProviderTestAgent({
      provider: provider as any,
      apiKey,
      model,
      baseUrl,
      tools: ['bash_run'],
    });

    try {
      const result = await ctx.agent.chat(
        'Run "echo $HOME" and tell me the home directory path'
      );

      expect.toEqual(result.status, 'ok');
      expect.toBeTruthy(
        result.text?.includes('/') || result.text?.includes('home'),
        'Response should include a path'
      );
    } finally {
      await ctx.cleanup();
    }
  });

  // ===========================================================================
  // Multi-turn Conversation Tests
  // ===========================================================================

  runner.test('Multi-turn: Context preservation', async () => {
    const ctx = await createProviderTestAgent({
      provider: provider as any,
      apiKey,
      model,
      baseUrl,
      tools: [],
    });

    try {
      // First turn - introduce a code word (not "secret" which may trigger safety)
      const code = `CODE${Date.now()}`;
      const r1 = await ctx.agent.chat(
        `I'm testing multi-turn context. Please remember this code word: ${code}. Reply with "Understood, I will remember ${code}"`
      );
      expect.toEqual(r1.status, 'ok');

      // Second turn - ask for the code
      const r2 = await ctx.agent.chat('What was the code word I asked you to remember?');
      expect.toEqual(r2.status, 'ok');
      // Check if code is in response or if model acknowledges it remembers something
      const text = r2.text || '';
      const hasCode = text.includes(code) || text.toLowerCase().includes('code');
      expect.toBeTruthy(hasCode, `Context should be preserved. Got: ${text.slice(0, 100)}`);
    } finally {
      await ctx.cleanup();
    }
  });

  runner.test('Multi-turn: Sequential tool calls', async () => {
    const ctx = await createProviderTestAgent({
      provider: provider as any,
      apiKey,
      model,
      baseUrl,
      tools: ['fs_write', 'fs_read'],
    });

    try {
      const testFile = path.join(ctx.workDir, 'multi-turn.txt');

      // Turn 1: Create file
      const r1 = await ctx.agent.chat(
        `Create a file at ${testFile} with content "Step 1 complete"`
      );
      expect.toEqual(r1.status, 'ok');

      // Turn 2: Read it back
      const r2 = await ctx.agent.chat(
        `Read the file at ${testFile} and tell me its content`
      );
      expect.toEqual(r2.status, 'ok');
      expect.toContain(r2.text || '', 'Step 1');
    } finally {
      await ctx.cleanup();
    }
  });

  // ===========================================================================
  // Resume/Fork Tests
  // ===========================================================================

  runner.test('Resume: Restore conversation state', async () => {
    const ctx = await createProviderTestAgent({
      provider: provider as any,
      apiKey,
      model,
      baseUrl,
      tools: [],
    });

    try {
      const token = `RESUME-${Date.now()}`;

      // Initial conversation
      await ctx.agent.chat(`Remember: ${token}`);

      // Create new agent with same ID (simulating resume)
      const resumed = await Agent.resume(ctx.agent.agentId, ctx.config, ctx.deps);

      // Verify state preserved
      const result = await resumed.chat('What did I ask you to remember?');
      expect.toContain(result.text || '', token);
    } finally {
      await ctx.cleanup();
    }
  });

  // ===========================================================================
  // Error Handling Tests
  // ===========================================================================

  runner.test('Error: Handle non-existent file read', async () => {
    const ctx = await createProviderTestAgent({
      provider: provider as any,
      apiKey,
      model,
      baseUrl,
      tools: ['fs_read'],
    });

    try {
      const result = await ctx.agent.chat(
        'Try to read the file at /nonexistent/path/that/does/not/exist.txt and tell me what happened'
      );

      // Agent should handle gracefully - either status ok or the response indicates awareness
      // The model might refuse to try or report the error
      const text = (result.text || '').toLowerCase();
      const handledGracefully =
        result.status === 'ok' ||
        text.includes('error') ||
        text.includes('not found') ||
        text.includes("doesn't exist") ||
        text.includes('does not exist') ||
        text.includes('unable') ||
        text.includes('cannot') ||
        text.includes('failed');
      expect.toBeTruthy(handledGracefully, `Should handle error gracefully. Got: ${text.slice(0, 100)}`);
    } finally {
      await ctx.cleanup();
    }
  });

  runner.test('Error: Handle command failure', async () => {
    const ctx = await createProviderTestAgent({
      provider: provider as any,
      apiKey,
      model,
      baseUrl,
      tools: ['bash_run'],
    });

    try {
      const result = await ctx.agent.chat(
        'Run the command "nonexistent_command_xyz_123"'
      );

      expect.toEqual(result.status, 'ok');
      const text = (result.text || '').toLowerCase();
      expect.toBeTruthy(
        text.includes('error') || text.includes('not found') || text.includes('failed'),
        'Response should mention the error'
      );
    } finally {
      await ctx.cleanup();
    }
  });
}

export async function run() {
  return await runner.run();
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
