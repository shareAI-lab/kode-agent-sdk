import { createHash } from 'node:crypto';

import type {
  AgentRunObservation,
  CompressionObservation,
  GenerationObservation,
  ObservationEnvelope,
  ObservationRecord,
  ToolObservation,
  SubagentObservation,
} from '../types';
import type { OTelAttributeNamespace, OTelAttributeValue } from './types';

export function toOTelTraceId(value: string): string {
  return createHash('sha256').update(`trace:${value}`).digest('hex').slice(0, 32);
}

export function toOTelSpanId(value: string): string {
  return createHash('sha256').update(`span:${value}`).digest('hex').slice(0, 16);
}

export function toOTelAttributeValue(value: unknown): OTelAttributeValue | undefined {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return undefined;
}

export function buildBaseOTelAttributes(
  envelope: ObservationEnvelope,
  attributeNamespace: OTelAttributeNamespace
): Record<string, OTelAttributeValue> {
  const observation = envelope.observation;
  const attributes: Record<string, OTelAttributeValue> = {
    'kode.agent.id': observation.agentId,
    'kode.run.id': observation.runId,
    'kode.trace.id': observation.traceId,
    'kode.span.id': observation.spanId,
    'kode.observation.kind': observation.kind,
    'kode.observation.name': observation.name,
    'kode.observation.status': observation.status,
    'kode.envelope.seq': envelope.seq,
    'kode.envelope.timestamp': envelope.timestamp,
    'kode.duration.ms': observation.durationMs ?? Math.max(0, (observation.endTime ?? observation.startTime) - observation.startTime),
  };

  if (observation.parentSpanId) {
    attributes['kode.parent_span.id'] = observation.parentSpanId;
  }

  if (attributeNamespace === 'kode') {
    return attributes;
  }

  return {
    ...attributes,
    'gen_ai.kode.agent_id': observation.agentId,
    'gen_ai.kode.run_id': observation.runId,
  };
}

export function buildObservationSpecificAttributes(
  observation: ObservationRecord,
  attributeNamespace: OTelAttributeNamespace
): Record<string, OTelAttributeValue> {
  switch (observation.kind) {
    case 'agent_run':
      return buildAgentRunAttributes(observation);
    case 'generation':
      return buildGenerationAttributes(observation, attributeNamespace);
    case 'tool':
      return buildToolAttributes(observation);
    case 'subagent':
      return buildSubagentAttributes(observation);
    case 'compression':
      return buildCompressionAttributes(observation);
    default:
      return {};
  }
}

function buildAgentRunAttributes(observation: AgentRunObservation): Record<string, OTelAttributeValue> {
  const attributes: Record<string, OTelAttributeValue> = {
    'kode.run.trigger': observation.trigger,
    'kode.step': observation.step,
    'kode.message_count.before': observation.messageCountBefore,
  };

  if (observation.messageCountAfter !== undefined) {
    attributes['kode.message_count.after'] = observation.messageCountAfter;
  }
  if (observation.metadata?.templateId && typeof observation.metadata.templateId === 'string') {
    attributes['kode.template.id'] = observation.metadata.templateId;
  }
  if (observation.errorMessage) {
    attributes['kode.error.message'] = observation.errorMessage;
  }

  return attributes;
}

function buildGenerationAttributes(
  observation: GenerationObservation,
  attributeNamespace: OTelAttributeNamespace
): Record<string, OTelAttributeValue> {
  const attributes: Record<string, OTelAttributeValue> = {};

  if (observation.provider) {
    attributes['kode.generation.provider'] = observation.provider;
  }
  if (observation.model) {
    attributes['kode.generation.model'] = observation.model;
  }
  if (observation.requestId) {
    attributes['kode.generation.request_id'] = observation.requestId;
  }
  if (observation.request?.stopReason) {
    attributes['kode.generation.stop_reason'] = observation.request.stopReason;
  }
  if (observation.request?.latencyMs !== undefined) {
    attributes['kode.generation.latency_ms'] = observation.request.latencyMs;
  }
  if (observation.request?.timeToFirstTokenMs !== undefined) {
    attributes['kode.generation.ttft_ms'] = observation.request.timeToFirstTokenMs;
  }
  if (observation.usage?.inputTokens !== undefined) {
    attributes['kode.generation.input_tokens'] = observation.usage.inputTokens;
  }
  if (observation.usage?.outputTokens !== undefined) {
    attributes['kode.generation.output_tokens'] = observation.usage.outputTokens;
  }
  if (observation.usage?.totalTokens !== undefined) {
    attributes['kode.generation.total_tokens'] = observation.usage.totalTokens;
  }
  if (observation.cost?.totalCost !== undefined) {
    attributes['kode.generation.total_cost_usd'] = observation.cost.totalCost;
  }

  if (attributeNamespace !== 'kode') {
    if (observation.provider) {
      attributes['gen_ai.system'] = observation.provider;
    }
    if (observation.model) {
      attributes['gen_ai.request.model'] = observation.model;
    }
    if (observation.usage?.inputTokens !== undefined) {
      attributes['gen_ai.usage.input_tokens'] = observation.usage.inputTokens;
    }
    if (observation.usage?.outputTokens !== undefined) {
      attributes['gen_ai.usage.output_tokens'] = observation.usage.outputTokens;
    }
    if (observation.usage?.totalTokens !== undefined) {
      attributes['gen_ai.usage.total_tokens'] = observation.usage.totalTokens;
    }
  }

  if (observation.errorMessage) {
    attributes['kode.error.message'] = observation.errorMessage;
  }

  return attributes;
}

function buildToolAttributes(observation: ToolObservation): Record<string, OTelAttributeValue> {
  const attributes: Record<string, OTelAttributeValue> = {
    'kode.tool.call_id': observation.toolCallId,
    'kode.tool.name': observation.toolName,
    'kode.tool.state': observation.toolState,
    'kode.tool.approval_required': observation.approvalRequired,
  };

  if (observation.approval) {
    attributes['kode.tool.approval.status'] = observation.approval.status;
    if (observation.approval.waitMs !== undefined) {
      attributes['kode.tool.approval.wait_ms'] = observation.approval.waitMs;
    }
  }
  if (observation.errorMessage) {
    attributes['kode.error.message'] = observation.errorMessage;
  }

  return attributes;
}

function buildSubagentAttributes(observation: SubagentObservation): Record<string, OTelAttributeValue> {
  const attributes: Record<string, OTelAttributeValue> = {
    'kode.subagent.child_agent_id': observation.childAgentId,
    'kode.subagent.template_id': observation.templateId,
  };

  if (observation.childRunId) {
    attributes['kode.subagent.child_run_id'] = observation.childRunId;
  }
  if (observation.delegatedBy) {
    attributes['kode.subagent.delegated_by'] = observation.delegatedBy;
  }
  if (observation.errorMessage) {
    attributes['kode.error.message'] = observation.errorMessage;
  }

  return attributes;
}

function buildCompressionAttributes(observation: CompressionObservation): Record<string, OTelAttributeValue> {
  const attributes: Record<string, OTelAttributeValue> = {
    'kode.compression.policy': observation.policy,
    'kode.compression.reason': observation.reason,
    'kode.compression.message_count_before': observation.messageCountBefore,
    'kode.compression.summary_generated': observation.summaryGenerated,
  };

  if (observation.messageCountAfter !== undefined) {
    attributes['kode.compression.message_count_after'] = observation.messageCountAfter;
  }
  if (observation.estimatedTokensBefore !== undefined) {
    attributes['kode.compression.tokens_before'] = observation.estimatedTokensBefore;
  }
  if (observation.estimatedTokensAfter !== undefined) {
    attributes['kode.compression.tokens_after'] = observation.estimatedTokensAfter;
  }
  if (observation.ratio !== undefined) {
    attributes['kode.compression.ratio'] = observation.ratio;
  }
  if (observation.errorMessage) {
    attributes['kode.error.message'] = observation.errorMessage;
  }

  return attributes;
}
