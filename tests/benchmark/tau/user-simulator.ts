// ---------------------------------------------------------------------------
// TAU benchmark user simulator — LLM-powered simulated user
// ---------------------------------------------------------------------------

import type { ModelProvider } from '../../../src/infra/providers/types';
import type { Message, ContentBlock } from '../../../src/core/types';

const STOP_SIGNAL = '###STOP###';

export interface UserSimulatorResult {
  text: string;
  tokens: number;
  done: boolean;
}

export class UserSimulator {
  private provider: ModelProvider;
  private scenario: string;

  constructor(provider: ModelProvider, scenario: string) {
    this.provider = provider;
    this.scenario = scenario;
  }

  /**
   * Generate the first user message (initiating the conversation).
   */
  async generateFirstMessage(): Promise<UserSimulatorResult> {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Generate your opening message to the customer service agent. Be natural and concise — state who you are and what you need. Respond with ONLY the message text, nothing else.',
          },
        ],
      },
    ];

    return this.callModel(messages);
  }

  /**
   * Generate the next user response based on the agent's message.
   */
  async generateResponse(agentMessage: string, history: Array<{ role: string; content: string }>): Promise<UserSimulatorResult> {
    // Build conversation history for the user simulator
    const messages: Message[] = [];

    // Add previous turns (alternating user/assistant from the USER's perspective:
    // the user simulator sees agent messages as "user" input and its own messages as "assistant" output)
    for (const msg of history) {
      if (msg.role === 'user') {
        // This was a user-sim output — from user-sim's perspective it's "assistant"
        messages.push({ role: 'assistant', content: [{ type: 'text', text: msg.content }] });
      } else if (msg.role === 'assistant') {
        // This was an agent output — from user-sim's perspective it's "user" input
        messages.push({ role: 'user', content: [{ type: 'text', text: msg.content }] });
      }
    }

    // Latest agent message
    messages.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text: `The customer service agent said:\n\n${agentMessage}\n\nRespond as the customer. If your issue is resolved, say goodbye naturally and include "${STOP_SIGNAL}" at the end of your message. Respond with ONLY the message text, nothing else.`,
        },
      ],
    });

    return this.callModel(messages);
  }

  private async callModel(messages: Message[]): Promise<UserSimulatorResult> {
    const systemPrompt = [
      'You are simulating a customer calling airline customer service.',
      'Follow this scenario exactly:',
      '',
      this.scenario,
      '',
      'Rules:',
      '- Stay in character. Only say things consistent with your scenario.',
      '- Be natural and conversational, like a real customer.',
      '- Provide information when asked (your name, reservation ID, etc.).',
      '- Do not invent details not in your scenario.',
      `- When your issue is fully resolved and you have no more questions, include "${STOP_SIGNAL}" at the end of your final message.`,
      '- Respond with ONLY the customer message text. Do not add any meta-commentary.',
    ].join('\n');

    const response = await this.provider.complete(messages, { system: systemPrompt });

    const text = response.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map(b => b.text)
      .join('');

    const tokens =
      (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0);

    const done = text.includes(STOP_SIGNAL);

    return { text: text.replace(STOP_SIGNAL, '').trim(), tokens, done };
  }
}
