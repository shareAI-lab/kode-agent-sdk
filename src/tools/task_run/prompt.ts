export const DESCRIPTION = 'Delegate a task to a specialized sub-agent';

export function generatePrompt(templates: Array<{ id: string; whenToUse?: string }>): string {
  const templateList = templates
    .map((tpl) => `- agentTemplateId: ${tpl.id}\n  whenToUse: ${tpl.whenToUse || 'General purpose tasks'}`)
    .join('\n');

  return `Delegate complex, multi-step work to specialized sub-agents.

Instructions:
- Always provide a concise "description" (3-5 words) and a detailed "prompt" outlining deliverables.
- REQUIRED: Set "agentTemplateId" to one of the available template IDs below.
- Optionally supply "context" for extra background information.
- Optional "model" override:
  - string: keep parent provider, override model id
  - { provider, model }: explicitly choose provider + model
  - omitted: inherit parent model instance
- The tool returns the sub-agent's final text and any pending permissions.

Available agent templates:
${templateList}

Safety/Limitations:
- Sub-agents inherit the same sandbox and tool restrictions.
- Task delegation depth may be limited to prevent infinite recursion.
- Sub-agents cannot access parent agent state or context directly.`;
}
