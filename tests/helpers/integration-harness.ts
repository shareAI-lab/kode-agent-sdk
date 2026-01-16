import { Agent, AgentConfig, AgentDependencies, ResumeStrategy } from '../../src';
import { createIntegrationTestAgent, IntegrationTestAgentOptions } from './setup';
import { expect } from './utils';

export interface ChatStepExpectation {
  includes?: string[];
  notIncludes?: string[];
}

export interface ChatStepOptions {
  label: string;
  prompt: string;
  expectation?: ChatStepExpectation;
  approval?: {
    mode?: 'auto' | 'manual';
    decision?: 'allow' | 'deny';
    note?: string;
  };
}

export interface DelegateTaskOptions {
  label: string;
  templateId: string;
  prompt: string;
  tools?: string[];
}

interface SubscriptionEvent {
  channel: 'progress' | 'monitor' | 'control';
  event: any;
}

export class IntegrationHarness {
  static async create(options: IntegrationTestAgentOptions = {}) {
    const context = await createIntegrationTestAgent(options);
    return new IntegrationHarness(
      context.agent,
      context.deps,
      context.config,
      context.cleanup,
      context.workDir,
      context.storeDir
    );
  }

  private constructor(
    private agent: Agent,
    private readonly deps: AgentDependencies,
    private readonly config: AgentConfig,
    private readonly cleanupFn: () => Promise<void>,
    private readonly workDir?: string,
    private readonly storeDir?: string
  ) {}

  log(message: string) {
    console.log(message);
  }

  async chatStep(opts: ChatStepOptions) {
    const { label, prompt, expectation } = opts;
    const approvalMode = opts.approval?.mode ?? 'auto';
    const approvalDecision = opts.approval?.decision ?? 'allow';
    const approvalNote = opts.approval?.note ?? `auto ${approvalDecision} by integration harness`;
    this.log(`\n[${label}] >>> 用户指令`);
    this.log(`[${label}] ${prompt}`);

    const iterator = this.agent.subscribe(['progress', 'monitor', 'control'])[Symbol.asyncIterator]();
    const events: SubscriptionEvent[] = [];
    const pendingReply = this.agent.chat(prompt);
    const handledApprovals = new Set<string>();
    let streamedText = '';
    let stoppedForApproval = false;

    let replyResolved = false;
    let replyResult: Awaited<ReturnType<Agent['chat']>> | undefined;
    let replyError: unknown;

    pendingReply
      .then((reply) => {
        replyResult = reply;
        replyResolved = true;
      })
      .catch((error) => {
        replyError = error;
        replyResolved = true;
      });

    while (true) {
      const { value, done } = await iterator.next();
      if (!value) {
        if (done) {
          break;
        }
        // 无事件但未标记完成，继续等待
        continue;
      }

      const envelope = value as any;
      const event = (envelope.event ?? envelope) as any;
      const channel = (event.channel ?? envelope.channel) as SubscriptionEvent['channel'];
      events.push({ channel, event });
      this.log(
        `[${label}] [事件#${events.length}] channel=${channel ?? 'unknown'}, type=${event.type}` +
          (event.delta ? `, delta=${event.delta.slice?.(0, 120)}` : '')
      );

      if (channel === 'progress' && event.type === 'text_chunk' && typeof event.delta === 'string') {
        streamedText += event.delta;
      }

      if (channel === 'control' && event.type === 'permission_required') {
        const callId = event.call?.id || event.callId || event.permissionId;
        if (callId && !handledApprovals.has(callId)) {
          handledApprovals.add(callId);
          if (approvalMode === 'auto') {
            if (typeof event.respond === 'function') {
              await event.respond(approvalDecision, { note: approvalNote });
            } else {
              await this.agent.decide(callId, approvalDecision, approvalNote);
            }
          } else {
            pendingReply.catch(() => undefined);
            replyResult = {
              status: 'paused',
              text: streamedText || undefined,
              last: undefined,
              permissionIds: callId ? [callId] : [],
            } as Awaited<ReturnType<Agent['chat']>>;
            replyResolved = true;
            stoppedForApproval = true;
          }
        }
      }

      if (channel === 'progress' && event.type === 'done') {
        break;
      }

      if (stoppedForApproval) {
        break;
      }
    }

    if (iterator.return) {
      await iterator.return();
    }

    if (replyError) {
      throw replyError;
    }

    if (!replyResolved && !stoppedForApproval) {
      replyResult = await pendingReply;
      replyResolved = true;
    }

    if (stoppedForApproval && !replyResolved) {
      pendingReply.catch(() => undefined);
    }

    const reply = replyResult!;
    this.log(`[${label}] <<< 模型响应`);
    this.log(`[${label}] ${reply.text ?? '(无文本响应)'}`);

    if (expectation?.includes) {
      for (const fragment of expectation.includes) {
        expect.toBeTruthy(
          reply.text?.includes(fragment),
          `[${label}] 期望响应包含: ${fragment}`
        );
      }
    }

    if (expectation?.notIncludes) {
      for (const fragment of expectation.notIncludes) {
        expect.toBeFalsy(
          reply.text?.includes(fragment),
          `[${label}] 不应包含: ${fragment}`
        );
      }
    }

    return { reply, events };
  }

  async delegateTask(opts: DelegateTaskOptions) {
    const { label, templateId, prompt, tools } = opts;
    this.log(`\n[${label}] >>> task_run 子代理请求`);
    this.log(`[${label}] 模板: ${templateId}`);
    this.log(`[${label}] Prompt: ${prompt}`);
    const result = await this.agent.delegateTask({ templateId, prompt, tools });
    this.log(`[${label}] <<< 子代理返回 status=${result.status}`);
    this.log(`[${label}] 子代理内容: ${result.text ?? '(无文本响应)'}`);
    return result;
  }

  async resume(label: string, opts?: { strategy?: ResumeStrategy; autoRun?: boolean }) {
    this.log(`\n[${label}] 执行 Agent.resume 以继续对话.`);
    this.agent = await Agent.resume(this.agent.agentId, this.config, this.deps, opts);
  }

  getAgent(): Agent {
    return this.agent;
  }

  getConfig(): AgentConfig {
    return this.config;
  }

  getDependencies(): AgentDependencies {
    return this.deps;
  }

  async cleanup() {
    await this.cleanupFn();
  }

  getWorkDir(): string | undefined {
    return this.workDir;
  }

  getStoreDir(): string | undefined {
    return this.storeDir;
  }
}
