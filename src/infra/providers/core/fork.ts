/**
 * Fork Point Detection and Resume Support
 *
 * Provides utilities for detecting safe fork points in message history
 * and preparing messages for resume across different providers.
 */

import { Message, ContentBlock, MessageRole } from '../../../core/types';

/**
 * Fork point analysis result.
 */
export interface ForkPoint {
  messageIndex: number;
  isSafe: boolean;
  reason?: string;
}

/**
 * Validation result for resume.
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings?: string[];
}

/**
 * Resume handler interface for provider-specific logic.
 */
export interface ResumeHandler {
  // Prepare messages for resuming conversation
  prepareForResume(messages: Message[]): Message[];

  // Validate messages are suitable for resume
  validateForResume(messages: Message[]): ValidationResult;
}

/**
 * Serialization options for message persistence.
 */
export interface SerializationOptions {
  // How to handle reasoning blocks
  reasoningTransport: 'provider' | 'text' | 'omit';

  // Whether to preserve thinking signatures
  preserveSignatures: boolean;

  // Max content length for truncation
  maxContentLength?: number;
}

/**
 * Find all safe fork points in a message sequence.
 *
 * Safe fork points are:
 * 1. User messages
 * 2. Assistant messages without tool_use
 * 3. After a user message containing all tool_results for preceding tool_uses
 */
export function findSafeForkPoints(messages: Message[]): ForkPoint[] {
  const points: ForkPoint[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const point = analyzeForkSafety(msg, i, messages);
    points.push(point);
  }

  return points;
}

/**
 * Analyze if a specific message index is a safe fork point.
 */
function analyzeForkSafety(
  msg: Message,
  index: number,
  messages: Message[]
): ForkPoint {
  // User messages are always safe fork points
  if (msg.role === 'user') {
    // But check if this user message contains incomplete tool results
    const prevMsg = messages[index - 1];
    if (prevMsg?.role === 'assistant') {
      const toolUseIds = getToolUseIds(prevMsg);
      if (toolUseIds.length > 0) {
        const resultIds = getToolResultIds(msg);
        const allHaveResults = toolUseIds.every(id => resultIds.includes(id));
        if (!allHaveResults) {
          return {
            messageIndex: index,
            isSafe: false,
            reason: 'User message does not contain all required tool_results',
          };
        }
      }
    }
    return { messageIndex: index, isSafe: true };
  }

  // Assistant messages without tool_use are safe
  if (msg.role === 'assistant') {
    const hasToolUse = msg.content.some(b => b.type === 'tool_use');
    if (!hasToolUse) {
      return { messageIndex: index, isSafe: true };
    }

    // Check if all tool calls have results in the next message
    const toolUseIds = getToolUseIds(msg);
    const nextMsg = messages[index + 1];

    if (nextMsg?.role === 'user') {
      const resultIds = getToolResultIds(nextMsg);
      const allHaveResults = toolUseIds.every(id => resultIds.includes(id));

      if (allHaveResults) {
        // The next user message (index + 1) is the safe fork point
        return {
          messageIndex: index,
          isSafe: false,
          reason: 'Fork at next message (after tool results)',
        };
      }
    }

    return {
      messageIndex: index,
      isSafe: false,
      reason: 'Pending tool calls without results',
    };
  }

  // System messages
  if (msg.role === 'system') {
    return { messageIndex: index, isSafe: true };
  }

  return { messageIndex: index, isSafe: false, reason: 'Unknown message role' };
}

/**
 * Get the last safe fork point index.
 */
export function getLastSafeForkPoint(messages: Message[]): number {
  const points = findSafeForkPoints(messages);

  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i].isSafe) {
      return points[i].messageIndex;
    }
  }

  return -1;  // No safe fork point found
}

/**
 * Extract tool_use IDs from a message.
 */
function getToolUseIds(msg: Message): string[] {
  return msg.content
    .filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
    .map(b => b.id);
}

/**
 * Extract tool_result IDs from a message.
 */
function getToolResultIds(msg: Message): string[] {
  return msg.content
    .filter((b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result')
    .map(b => b.tool_use_id);
}

/**
 * Serialize messages for persistence.
 */
export function serializeForResume(
  messages: Message[],
  options: SerializationOptions
): Message[] {
  return messages.map(msg => serializeMessage(msg, options));
}

/**
 * Serialize a single message.
 */
function serializeMessage(
  msg: Message,
  options: SerializationOptions
): Message {
  const serialized: Message = {
    role: msg.role,
    content: [],
    metadata: msg.metadata,
  };

  for (const block of msg.content) {
    const serializedBlock = serializeBlock(block, options);
    if (serializedBlock) {
      serialized.content.push(serializedBlock);
    }
  }

  return serialized;
}

/**
 * Serialize a content block based on options.
 */
function serializeBlock(
  block: ContentBlock,
  options: SerializationOptions
): ContentBlock | null {
  // Handle reasoning blocks based on transport
  if (block.type === 'reasoning') {
    switch (options.reasoningTransport) {
      case 'provider':
        // Keep as-is for providers that support it
        return block;

      case 'text':
        // Convert to text block with <think> tags
        return {
          type: 'text',
          text: `<think>${block.reasoning}</think>`,
        };

      case 'omit':
        // Exclude from serialized output
        return null;
    }
  }

  // All other blocks pass through
  return block;
}

// ============================================================================
// Provider-Specific Resume Handlers
// ============================================================================

/**
 * Anthropic resume handler.
 * Preserves thinking blocks with signatures for Claude 4+.
 */
export const anthropicResumeHandler: ResumeHandler = {
  prepareForResume(messages) {
    // Anthropic requires thinking blocks with signatures for Claude 4+
    // Blocks without signatures will be ignored by the API
    return messages.map(msg => {
      if (msg.role !== 'assistant') return msg;

      // Keep all blocks, including reasoning
      // The API will verify signatures and ignore invalid ones
      return msg;
    });
  },

  validateForResume(messages) {
    const errors: string[] = [];
    const warnings: string[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      // Check tool_use has corresponding tool_result
      if (msg.role === 'assistant') {
        const toolUses = msg.content.filter(b => b.type === 'tool_use');
        if (toolUses.length > 0 && i < messages.length - 1) {
          const nextMsg = messages[i + 1];
          if (nextMsg.role !== 'user') {
            errors.push(`Tool use at index ${i} not followed by user message`);
          } else {
            const resultIds = getToolResultIds(nextMsg);
            const toolUseIds = getToolUseIds(msg);
            const missing = toolUseIds.filter(id => !resultIds.includes(id));
            if (missing.length > 0) {
              errors.push(`Missing tool_results for tool_use IDs: ${missing.join(', ')}`);
            }
          }
        }
      }

      // Check for reasoning without signatures
      if (msg.role === 'assistant') {
        const reasoningBlocks = msg.content.filter(b => b.type === 'reasoning');
        for (const block of reasoningBlocks) {
          if (block.type === 'reasoning' && !block.meta?.signature) {
            warnings.push(`Reasoning block at index ${i} has no signature (may be ignored)`);
          }
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  },
};

/**
 * DeepSeek resume handler.
 * CRITICAL: Must NOT include reasoning_content in message history.
 */
export const deepseekResumeHandler: ResumeHandler = {
  prepareForResume(messages) {
    // DeepSeek returns 400 if reasoning_content is included in next turn
    // Only include content field (text blocks)
    return messages.map(msg => {
      if (msg.role !== 'assistant') return msg;

      // Filter out reasoning blocks entirely
      const filteredBlocks = msg.content.filter(b => b.type !== 'reasoning');

      return { ...msg, content: filteredBlocks };
    });
  },

  validateForResume(messages) {
    const errors: string[] = [];

    // Check that reasoning is not included in non-last messages
    for (let i = 0; i < messages.length - 1; i++) {
      const msg = messages[i];
      if (msg.role === 'assistant') {
        const hasReasoning = msg.content.some(b => b.type === 'reasoning');
        if (hasReasoning) {
          errors.push(
            `DeepSeek: reasoning_content must not be included at index ${i} (returns 400 error)`
          );
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  },
};

/**
 * Qwen resume handler.
 * Similar to DeepSeek - reasoning should be omitted.
 */
export const qwenResumeHandler: ResumeHandler = {
  prepareForResume(messages) {
    // Qwen: Similar to DeepSeek, reasoning_content should be omitted
    return messages.map(msg => {
      if (msg.role !== 'assistant') return msg;

      const filteredBlocks = msg.content.filter(b => b.type !== 'reasoning');

      return { ...msg, content: filteredBlocks };
    });
  },

  validateForResume(messages) {
    // Less strict than DeepSeek, but still recommend omitting
    return { valid: true, errors: [] };
  },
};

/**
 * OpenAI Chat resume handler.
 * Reasoning is converted to text with <think> tags.
 */
export const openaiChatResumeHandler: ResumeHandler = {
  prepareForResume(messages) {
    return messages.map(msg => {
      if (msg.role !== 'assistant') return msg;

      // Convert reasoning to text with <think> tags
      const convertedBlocks = msg.content.map(block => {
        if (block.type === 'reasoning') {
          return {
            type: 'text' as const,
            text: `<think>${block.reasoning}</think>`,
          };
        }
        return block;
      });

      return { ...msg, content: convertedBlocks };
    });
  },

  validateForResume(messages) {
    return { valid: true, errors: [] };
  },
};

/**
 * OpenAI Responses API resume handler.
 * Uses previous_response_id for state persistence.
 */
export const openaiResponsesResumeHandler: ResumeHandler = {
  prepareForResume(messages) {
    // Responses API handles state via previous_response_id
    // Messages are passed normally
    return messages;
  },

  validateForResume(messages) {
    // Responses API manages state via previous_response_id
    // This is typically passed in options, not in message metadata
    return { valid: true, errors: [] };
  },
};

/**
 * Gemini resume handler.
 * Preserves thoughtSignature for function calls.
 */
export const geminiResumeHandler: ResumeHandler = {
  prepareForResume(messages) {
    // Gemini: Preserve thoughtSignature for function call continuation
    return messages.map(msg => {
      if (msg.role !== 'assistant') return msg;

      // Keep reasoning blocks that have thoughtSignature
      // Others can be omitted or converted
      const processedBlocks = msg.content.map(block => {
        if (block.type === 'reasoning') {
          // Keep if has signature, otherwise omit
          if (block.meta?.thoughtSignature) {
            return block;
          }
          return null;
        }
        return block;
      }).filter((b): b is ContentBlock => b !== null);

      return { ...msg, content: processedBlocks };
    });
  },

  validateForResume(messages) {
    return { valid: true, errors: [] };
  },
};

/**
 * Get resume handler for a provider.
 */
export function getResumeHandler(provider: string): ResumeHandler {
  switch (provider) {
    case 'anthropic':
      return anthropicResumeHandler;
    case 'deepseek':
      return deepseekResumeHandler;
    case 'qwen':
      return qwenResumeHandler;
    case 'openai':
    case 'openai-chat':
      return openaiChatResumeHandler;
    case 'openai-responses':
      return openaiResponsesResumeHandler;
    case 'gemini':
      return geminiResumeHandler;
    default:
      // Default handler - omit reasoning to be safe
      return {
        prepareForResume(messages) {
          return messages.map(msg => {
            if (msg.role !== 'assistant') return msg;
            const filtered = msg.content.filter(b => b.type !== 'reasoning');
            return { ...msg, content: filtered };
          });
        },
        validateForResume() {
          return { valid: true, errors: [] };
        },
      };
  }
}

/**
 * Prepare messages for resume with a specific provider.
 */
export function prepareMessagesForResume(
  messages: Message[],
  provider: string
): Message[] {
  const handler = getResumeHandler(provider);
  return handler.prepareForResume(messages);
}

/**
 * Validate messages for resume with a specific provider.
 */
export function validateMessagesForResume(
  messages: Message[],
  provider: string
): ValidationResult {
  const handler = getResumeHandler(provider);
  return handler.validateForResume(messages);
}

/**
 * Check if a message sequence can be safely forked at a given index.
 */
export function canForkAt(messages: Message[], index: number): boolean {
  if (index < 0 || index >= messages.length) {
    return false;
  }

  const points = findSafeForkPoints(messages);
  return points[index]?.isSafe ?? false;
}

/**
 * Fork messages at a given index.
 * Returns messages up to and including the fork point.
 */
export function forkAt(messages: Message[], index: number): Message[] {
  if (!canForkAt(messages, index)) {
    throw new Error(`Cannot fork at index ${index} - not a safe fork point`);
  }

  return messages.slice(0, index + 1);
}
