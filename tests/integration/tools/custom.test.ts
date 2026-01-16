import { z } from 'zod';
import { tool, EnhancedToolContext } from '../../../src/tools/tool';
import { createIntegrationTestAgent, collectEvents } from '../../helpers/setup';
import { TestRunner, expect } from '../../helpers/utils';

const runner = new TestRunner('集成测试 - 自定义工具');

runner.test('自定义工具触发自定义事件', async () => {
  const customTool = tool({
    name: 'custom_report',
    description: 'Record a custom metric and emit a monitor event',
    parameters: z.object({
      subject: z.string().describe('Metric subject'),
    }),
    async execute(args, ctx: EnhancedToolContext) {
      ctx.emit('custom_metric', { subject: args.subject });
      return {
        ok: true,
        message: `Metric recorded for ${args.subject}`,
      };
    },
  });

  const template = {
    id: 'integration-custom-tool',
    systemPrompt:
      'You must always call the custom_report tool before replying. Your final reply must include the exact phrase "已记录".',
    tools: ['custom_report'],
  };

  const { agent, cleanup } = await createIntegrationTestAgent({
    customTemplate: template,
    registerTools: (registry) => {
      registry.register(customTool.name, () => customTool);
    },
  });

  const monitorEvents = collectEvents(agent, ['monitor'], (event) => event.type === 'tool_custom_event');
  const result = await agent.chat('请记录主题为“集成自定义工具”的指标，并在回复中包含“已记录”。');

  expect.toEqual(result.status, 'ok');
  expect.toBeTruthy(result.text && result.text.includes('已记录'));

  const events = await monitorEvents;
  expect.toBeGreaterThan(events.length, 0);
  const customEvent = (events as any[]).find((event) => event.type === 'tool_custom_event');
  expect.toBeTruthy(customEvent);
  expect.toEqual((customEvent as any).eventType, 'custom_metric');
  expect.toEqual((customEvent as any).toolName, 'custom_report');

  await cleanup();
});

export async function run() {
  return runner.run();
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
