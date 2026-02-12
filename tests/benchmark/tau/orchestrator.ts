// ---------------------------------------------------------------------------
// TAU benchmark orchestrator — Agent ↔ User ↔ Environment message loop
//
// Follows τ-bench protocol:
// 1. User initiates conversation
// 2. Agent responds (text or tool calls)
// 3. If tool calls → environment executes → results fed back to agent
// 4. If text → forwarded to user simulator
// 5. Repeat until ###STOP### or max turns
// ---------------------------------------------------------------------------

import type { ModelProvider } from '../../../src/infra/providers/types';
import type { Message, ContentBlock } from '../../../src/core/types';
import type { ToolDef } from './domains/airline/tools';
import { Environment } from './environment';
import { UserSimulator } from './user-simulator';

const STOP_SIGNAL = '###STOP###';
const MAX_TOOL_ROUNDS = 10; // Safety limit for consecutive tool calls in one turn

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface OrchestrationResult {
  passed: boolean;
  messages: ConversationMessage[];
  agentTokens: number;
  userSimTokens: number;
  turns: number;
  error?: string;
}

export interface OrchestrationOptions {
  agentProvider: ModelProvider;
  userSimulator: UserSimulator;
  environment: Environment;
  systemPrompt: string;
  toolDefs: ToolDef[];
  maxTurns: number;
  timeoutMs: number;
  expectedDb: Record<string, any[]>;
  evaluate: (finalDb: Record<string, any[]>, expectedDb: Record<string, any[]>) => boolean;
}

export async function runOrchestration(opts: OrchestrationOptions): Promise<OrchestrationResult> {
  const {
    agentProvider,
    userSimulator,
    environment,
    systemPrompt,
    toolDefs,
    maxTurns,
    timeoutMs,
    expectedDb,
    evaluate,
  } = opts;

  const conversationLog: ConversationMessage[] = [];
  // Internal messages in SDK format for model.complete()
  const modelMessages: Message[] = [];
  let agentTokens = 0;
  let userSimTokens = 0;
  let turns = 0;

  try {
    // Wrap the entire orchestration in a timeout
    const result = await withTimeout(async () => {
      // 1. User generates first message
      const firstMsg = await userSimulator.generateFirstMessage();
      userSimTokens += firstMsg.tokens;
      conversationLog.push({ role: 'user', content: firstMsg.text });
      modelMessages.push(textMsg('user', firstMsg.text));

      // 2. Conversation loop
      while (turns < maxTurns) {
        // --- Agent turn ---
        const agentText = await runAgentTurn(
          agentProvider,
          modelMessages,
          systemPrompt,
          toolDefs,
          environment,
          (t) => { agentTokens += t; },
        );

        conversationLog.push({ role: 'assistant', content: agentText });
        turns++;

        // Check agent stop signal
        if (agentText.includes(STOP_SIGNAL)) break;

        // --- User turn ---
        const userReply = await userSimulator.generateResponse(
          agentText,
          conversationLog.slice(0, -1), // history without the latest agent msg
        );
        userSimTokens += userReply.tokens;
        conversationLog.push({ role: 'user', content: userReply.text });
        modelMessages.push(textMsg('user', userReply.text));

        // Check user stop signal
        if (userReply.done) break;
      }

      // 3. Evaluate
      const finalDb = environment.getState();
      const passed = evaluate(finalDb, expectedDb);

      return { passed, messages: conversationLog, agentTokens, userSimTokens, turns };
    }, timeoutMs);

    return result;
  } catch (err: any) {
    return {
      passed: false,
      messages: conversationLog,
      agentTokens,
      userSimTokens,
      turns,
      error: err.message || String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Agent turn: call model, handle tool loops, return final text
// ---------------------------------------------------------------------------

async function runAgentTurn(
  provider: ModelProvider,
  modelMessages: Message[],
  systemPrompt: string,
  toolDefs: ToolDef[],
  environment: Environment,
  addTokens: (t: number) => void,
): Promise<string> {
  let toolRounds = 0;

  while (toolRounds < MAX_TOOL_ROUNDS) {
    const response = await provider.complete(modelMessages, {
      system: systemPrompt,
      tools: toolDefs,
    });

    const usage = (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0);
    addTokens(usage);

    // Separate text and tool_use blocks
    const textBlocks = response.content.filter(
      (b): b is { type: 'text'; text: string } => b.type === 'text',
    );
    const toolUseBlocks = response.content.filter(
      (b): b is { type: 'tool_use'; id: string; name: string; input: any } => b.type === 'tool_use',
    );

    // If no tool calls, return text
    if (toolUseBlocks.length === 0) {
      const text = textBlocks.map(b => b.text).join('');
      modelMessages.push({ role: 'assistant', content: response.content });
      return text;
    }

    // Handle tool calls
    modelMessages.push({ role: 'assistant', content: response.content });

    const toolResults: ContentBlock[] = toolUseBlocks.map(tc => {
      const result = environment.executeTool(tc.name, tc.input);
      return {
        type: 'tool_result' as const,
        tool_use_id: tc.id,
        content: JSON.stringify(result),
      };
    });

    modelMessages.push({ role: 'user', content: toolResults });
    toolRounds++;
  }

  // Safety: too many tool rounds — return whatever text we have
  return '[Agent exceeded maximum tool call rounds]';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textMsg(role: 'user' | 'assistant' | 'system', text: string): Message {
  return { role, content: [{ type: 'text', text }] };
}

function withTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
    fn().then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); },
    );
  });
}
