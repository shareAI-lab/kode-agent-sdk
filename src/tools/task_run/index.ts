import { tool } from '../tool';
import { z } from 'zod';
import { DESCRIPTION, generatePrompt } from './prompt';
import { ToolContext } from '../../core/types';

export interface AgentTemplate {
  id: string;
  system?: string;
  tools?: string[];
  whenToUse?: string;
}

export function createTaskRunTool(templates: AgentTemplate[]) {
  if (!templates || templates.length === 0) {
    throw new Error('Cannot create task_run tool: no agent templates provided');
  }

  const modelOverrideSchema = z.union([
    z.string().describe('Model ID override while keeping parent provider'),
    z.object({
      provider: z.string().describe('Provider ID override (e.g. anthropic/openai/gemini/custom)'),
      model: z.string().describe('Model ID for the selected provider'),
    }).describe('Explicit provider + model override'),
  ]).optional();

  const TaskRun = tool({
    name: 'task_run',
    description: DESCRIPTION,
    parameters: z.object({
      description: z.string().describe('Short description of the task (3-5 words)'),
      prompt: z.string().describe('Detailed instructions for the sub-agent'),
      agentTemplateId: z.string().describe('Agent template ID to use for this task'),
      context: z.string().optional().describe('Additional context to append'),
      model: modelOverrideSchema,
    }),
    async execute(args, ctx: ToolContext) {
      const { description, prompt, agentTemplateId, context, model } = args;

      const template = templates.find((tpl) => tpl.id === agentTemplateId);

      if (!template) {
        const availableTemplates = templates
          .map((tpl) => `  - ${tpl.id}: ${tpl.whenToUse || 'General purpose agent'}`)
          .join('\n');

        throw new Error(
          `Agent template '${agentTemplateId}' not found.\n\nAvailable templates:\n${availableTemplates}\n\nPlease choose one of the available template IDs.`
        );
      }

      const detailedPrompt = [
        `# Task: ${description}`,
        prompt,
        context ? `\n# Additional Context\n${context}` : undefined,
      ]
        .filter(Boolean)
        .join('\n\n');

      if (!ctx.agent?.delegateTask) {
        throw new Error('Task delegation not supported by this agent version');
      }

      const result = await ctx.agent.delegateTask({
        templateId: template.id,
        prompt: detailedPrompt,
        model,
        tools: template.tools,
      });

      return {
        status: result.status,
        template: template.id,
        text: result.text,
        permissionIds: result.permissionIds,
      };
    },
    metadata: {
      readonly: false,
      version: '1.0',
    },
  });

  TaskRun.prompt = generatePrompt(templates);

  return TaskRun;
}
