/**
 * Shared utilities for provider implementations.
 */

import { ContentBlock, Message, ImageContentBlock, FileContentBlock, AudioContentBlock, VideoContentBlock } from '../../core/types';
import { ReasoningTransport } from './types';

// =============================================================================
// Proxy Handling
// =============================================================================

const proxyAgents = new Map<string, any>();

export function resolveProxyUrl(explicit?: string): string | undefined {
  if (explicit) return explicit;
  const flag = process.env.KODE_USE_ENV_PROXY;
  if (!flag || ['0', 'false', 'no'].includes(flag.toLowerCase())) {
    return undefined;
  }
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy
  );
}

export function getProxyDispatcher(proxyUrl?: string): any | undefined {
  const resolved = resolveProxyUrl(proxyUrl);
  if (!resolved) return undefined;
  const cached = proxyAgents.get(resolved);
  if (cached) return cached;
  let ProxyAgent: any;
  try {
    ({ ProxyAgent } = require('undici'));
  } catch (error: any) {
    throw new Error(`Proxy support requires undici. Install it to use proxyUrl (${error?.message || error}).`);
  }
  const agent = new ProxyAgent(resolved);
  proxyAgents.set(resolved, agent);
  return agent;
}

export function withProxy(init: RequestInit, dispatcher?: any): RequestInit {
  if (!dispatcher) return init;
  return { ...init, dispatcher } as any;
}

// =============================================================================
// URL Normalization
// =============================================================================

export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

export function normalizeOpenAIBaseUrl(url: string): string {
  let normalized = url.replace(/\/+$/, '');
  // Auto-append /v1 if not present (for OpenAI-compatible APIs)
  if (!normalized.endsWith('/v1')) {
    normalized += '/v1';
  }
  return normalized;
}

export function normalizeAnthropicBaseUrl(url: string): string {
  let normalized = url.replace(/\/+$/, '');
  if (normalized.endsWith('/v1')) {
    normalized = normalized.slice(0, -3);
  }
  return normalized;
}

export function normalizeGeminiBaseUrl(url: string): string {
  let normalized = url.replace(/\/+$/, '');
  // Auto-append /v1beta if no version path present
  if (!normalized.endsWith('/v1beta') && !normalized.endsWith('/v1')) {
    normalized += '/v1beta';
  }
  return normalized;
}

// =============================================================================
// Content Block Utilities
// =============================================================================

export function getMessageBlocks(message: Message): ContentBlock[] {
  if (message.metadata?.transport === 'omit') {
    return message.content;
  }
  return message.metadata?.content_blocks ?? message.content;
}

export function markTransportIfDegraded(message: Message, blocks: ContentBlock[]): void {
  if (message.metadata?.transport === 'omit') {
    return;
  }
  if (!message.metadata) {
    message.metadata = { content_blocks: blocks, transport: 'text' };
    return;
  }
  if (!message.metadata.content_blocks) {
    message.metadata.content_blocks = blocks;
  }
  message.metadata.transport = 'text';
}

// =============================================================================
// Text Formatting
// =============================================================================

export function joinTextBlocks(blocks: ContentBlock[]): string {
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

export function formatToolResult(content: any): string {
  if (typeof content === 'string') return content;
  return safeJsonStringify(content);
}

export function safeJsonStringify(value: any): string {
  try {
    const json = JSON.stringify(value ?? {});
    return json === undefined ? '{}' : json;
  } catch {
    return '{}';
  }
}

// =============================================================================
// Unsupported Content Messages
// =============================================================================

export const FILE_UNSUPPORTED_TEXT =
  '[file unsupported] This model does not support PDF input. Please extract text or images first.';
export const IMAGE_UNSUPPORTED_TEXT =
  '[image unsupported] This model does not support image URLs; please provide base64 data if supported.';
export const AUDIO_UNSUPPORTED_TEXT =
  '[audio unsupported] This model does not support audio input; please provide a text transcript instead.';
export const VIDEO_UNSUPPORTED_TEXT =
  '[video unsupported] This model does not support video input; please provide text description or extracted frames instead.';

// =============================================================================
// Reasoning/Thinking Utilities
// =============================================================================

export function concatTextWithReasoning(
  blocks: ContentBlock[],
  reasoningTransport: ReasoningTransport = 'text'
): string {
  let text = '';
  for (const block of blocks) {
    if (block.type === 'text') {
      text += block.text;
    } else if (block.type === 'reasoning' && reasoningTransport === 'text') {
      text += `<think>${block.reasoning}</think>`;
    }
  }
  return text;
}

export function joinReasoningBlocks(blocks: ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'reasoning' }> => block.type === 'reasoning')
    .map((block) => block.reasoning)
    .join('\n');
}

/**
 * Parse <think> tags in text blocks and convert to reasoning blocks.
 */
export function normalizeThinkBlocks(
  blocks: ContentBlock[],
  reasoningTransport: ReasoningTransport = 'text'
): ContentBlock[] {
  if (reasoningTransport !== 'text') {
    return blocks;
  }
  const output: ContentBlock[] = [];
  for (const block of blocks) {
    if (block.type !== 'text') {
      output.push(block);
      continue;
    }
    const parts = splitThinkText(block.text);
    if (parts.length === 0) {
      output.push(block);
    } else {
      output.push(...parts);
    }
  }
  return output;
}

export function splitThinkText(text: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const regex = /<think>([\s\S]*?)<\/think>/g;
  let match: RegExpExecArray | null;
  let cursor = 0;
  let matched = false;

  while ((match = regex.exec(text)) !== null) {
    matched = true;
    const before = text.slice(cursor, match.index);
    if (before) {
      blocks.push({ type: 'text', text: before });
    }
    const reasoning = match[1] || '';
    blocks.push({ type: 'reasoning', reasoning });
    cursor = match.index + match[0].length;
  }

  if (!matched) {
    return [];
  }

  const after = text.slice(cursor);
  if (after) {
    blocks.push({ type: 'text', text: after });
  }
  return blocks;
}

/**
 * Extract reasoning details from OpenAI response (for reasoning models).
 */
export function extractReasoningDetails(message: any): ContentBlock[] {
  const details = Array.isArray(message?.reasoning_details) ? message.reasoning_details : [];
  const content = typeof message?.reasoning_content === 'string' ? message.reasoning_content : undefined;
  const blocks: ContentBlock[] = [];
  for (const detail of details) {
    if (typeof detail?.text === 'string') {
      blocks.push({ type: 'reasoning', reasoning: detail.text });
    }
  }
  if (content) {
    blocks.push({ type: 'reasoning', reasoning: content });
  }
  return blocks;
}

// =============================================================================
// Gemini Helpers
// =============================================================================

export function buildGeminiImagePart(block: ImageContentBlock): any | null {
  if (block.file_id) {
    return { file_data: { mime_type: block.mime_type, file_uri: block.file_id } };
  }
  if (block.url) {
    if (block.url.startsWith('gs://')) {
      return { file_data: { mime_type: block.mime_type, file_uri: block.url } };
    }
    return null;
  }
  if (block.base64 && block.mime_type) {
    return { inline_data: { mime_type: block.mime_type, data: block.base64 } };
  }
  return null;
}

export function buildGeminiFilePart(block: FileContentBlock): any | null {
  const mimeType = block.mime_type || 'application/pdf';
  if (block.file_id) {
    return { file_data: { mime_type: mimeType, file_uri: block.file_id } };
  }
  if (block.url) {
    if (block.url.startsWith('gs://')) {
      return { file_data: { mime_type: mimeType, file_uri: block.url } };
    }
    return null;
  }
  if (block.base64) {
    return { inline_data: { mime_type: mimeType, data: block.base64 } };
  }
  return null;
}

export function buildGeminiAudioPart(block: AudioContentBlock): any | null {
  const mimeType = block.mime_type || 'audio/wav';
  if (block.file_id) {
    return { file_data: { mime_type: mimeType, file_uri: block.file_id } };
  }
  if (block.url) {
    if (block.url.startsWith('gs://')) {
      return { file_data: { mime_type: mimeType, file_uri: block.url } };
    }
    // Gemini supports https URLs for audio via file_data
    return { file_data: { mime_type: mimeType, file_uri: block.url } };
  }
  if (block.base64) {
    return { inline_data: { mime_type: mimeType, data: block.base64 } };
  }
  return null;
}

export function buildGeminiVideoPart(block: VideoContentBlock): any | null {
  const mimeType = block.mime_type || 'video/mp4';
  if (block.file_id) {
    return { file_data: { mime_type: mimeType, file_uri: block.file_id } };
  }
  if (block.url) {
    if (block.url.startsWith('gs://')) {
      return { file_data: { mime_type: mimeType, file_uri: block.url } };
    }
    // Gemini supports https URLs for video via file_data
    return { file_data: { mime_type: mimeType, file_uri: block.url } };
  }
  if (block.base64) {
    return { inline_data: { mime_type: mimeType, data: block.base64 } };
  }
  return null;
}

// =============================================================================
// OpenAI Audio Helpers
// =============================================================================

/** Supported OpenAI audio formats */
export const OPENAI_SUPPORTED_AUDIO_FORMATS = ['wav', 'mp3'] as const;
export type OpenAIAudioFormat = (typeof OPENAI_SUPPORTED_AUDIO_FORMATS)[number];

/**
 * Extract and validate OpenAI audio format from MIME type.
 * OpenAI Chat Completions API only supports wav and mp3.
 * @returns The audio format if supported, null otherwise
 */
export function extractOpenAIAudioFormat(mimeType?: string): OpenAIAudioFormat | null {
  if (!mimeType) return null;
  const lower = mimeType.toLowerCase();
  if (lower === 'audio/wav' || lower === 'audio/x-wav' || lower === 'audio/wave') {
    return 'wav';
  }
  if (lower === 'audio/mpeg' || lower === 'audio/mp3') {
    return 'mp3';
  }
  return null;
}

/**
 * Build OpenAI input_audio content part from AudioContentBlock.
 * OpenAI only supports base64 encoded audio (no URLs).
 * @returns The OpenAI input_audio part or null if not supported
 */
export function buildOpenAIAudioPart(block: AudioContentBlock): any | null {
  const format = extractOpenAIAudioFormat(block.mime_type);
  if (!format) return null;
  if (!block.base64) return null;
  return {
    type: 'input_audio',
    input_audio: {
      data: block.base64,
      format,
    },
  };
}

export function sanitizeGeminiSchema(schema: any): any {
  if (schema === null || schema === undefined) return schema;
  if (Array.isArray(schema)) return schema.map((item) => sanitizeGeminiSchema(item));
  if (typeof schema !== 'object') return schema;

  const cleaned: any = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'additionalProperties' || key === '$schema' || key === '$defs' || key === 'definitions') {
      continue;
    }
    cleaned[key] = sanitizeGeminiSchema(value);
  }
  return cleaned;
}

// =============================================================================
// Anthropic Helpers
// =============================================================================

export function hasAnthropicFileBlocks(messages: Message[]): boolean {
  for (const msg of messages) {
    const blocks = getMessageBlocks(msg);
    for (const block of blocks) {
      if (block.type === 'file' && block.file_id) {
        return true;
      }
    }
  }
  return false;
}

export function mergeAnthropicBetaHeader(existing: string | undefined, entries: string[]): string | undefined {
  const set = new Set<string>();
  if (existing) {
    for (const e of existing.split(',')) {
      const trimmed = e.trim();
      if (trimmed) set.add(trimmed);
    }
  }
  for (const e of entries) {
    if (e) set.add(e);
  }
  return set.size > 0 ? Array.from(set).join(',') : undefined;
}

/**
 * Normalize Anthropic response content to internal format.
 */
export function normalizeAnthropicContent(
  content: any[],
  reasoningTransport?: ReasoningTransport
): ContentBlock[] {
  if (!Array.isArray(content)) return [];
  const blocks: ContentBlock[] = [];
  for (const block of content) {
    const normalized = normalizeAnthropicContentBlock(block, reasoningTransport);
    if (normalized) blocks.push(normalized);
  }
  return blocks;
}

/**
 * Normalize a single Anthropic content block.
 * Handles thinking blocks with signature preservation.
 */
export function normalizeAnthropicContentBlock(
  block: any,
  reasoningTransport?: ReasoningTransport
): ContentBlock | null {
  if (!block || typeof block !== 'object') return null;

  // Handle thinking blocks - preserve signature for conversation continuity
  if (block.type === 'thinking') {
    if (reasoningTransport === 'text') {
      return { type: 'text', text: `<think>${block.thinking ?? ''}</think>` };
    }
    const result: any = { type: 'reasoning', reasoning: block.thinking ?? '' };
    // Preserve signature for multi-turn conversations (critical for Claude 4+)
    if (block.signature) {
      result.meta = { signature: block.signature };
    }
    return result;
  }

  if (block.type === 'text') {
    return { type: 'text', text: block.text ?? '' };
  }

  if (block.type === 'image' && block.source?.type === 'base64') {
    return {
      type: 'image',
      base64: block.source.data,
      mime_type: block.source.media_type,
    };
  }

  if (block.type === 'document' && block.source?.type === 'file') {
    return {
      type: 'file',
      file_id: block.source.file_id,
      mime_type: block.source.media_type,
    };
  }

  if (block.type === 'tool_use') {
    return {
      type: 'tool_use',
      id: block.id,
      name: block.name,
      input: block.input ?? {},
    };
  }

  if (block.type === 'tool_result') {
    return {
      type: 'tool_result',
      tool_use_id: block.tool_use_id,
      content: block.content,
      is_error: block.is_error,
    };
  }

  return null;
}

/**
 * Normalize Anthropic streaming delta.
 */
export function normalizeAnthropicDelta(delta: any): {
  type: 'text_delta' | 'input_json_delta' | 'reasoning_delta';
  text?: string;
  partial_json?: string;
} {
  if (!delta) {
    return { type: 'text_delta', text: '' };
  }
  if (delta.type === 'thinking_delta') {
    return { type: 'reasoning_delta', text: delta.thinking ?? '' };
  }
  if (delta.type === 'input_json_delta') {
    return { type: 'input_json_delta', partial_json: delta.partial_json ?? '' };
  }
  return { type: 'text_delta', text: delta.text ?? '' };
}
