import { defineTool } from '../../src/tools/define';
import { ToolRegistry } from '../../src/tools/registry';

export const alwaysOkTool = defineTool(
  {
    name: 'always_ok',
    description: 'Test tool that always succeeds.',
    params: {
      value: { type: 'string', description: 'Echo value', required: false },
    },
    attributes: { readonly: true, noEffect: true },
    exec: async (args) => ({
      ok: true,
      data: { echo: args?.value ?? 'ok' },
    }),
  },
  { autoRegister: false }
);

export const alwaysFailTool = defineTool(
  {
    name: 'always_fail',
    description: 'Test tool that always fails.',
    params: {
      reason: { type: 'string', description: 'Failure reason', required: false },
    },
    attributes: { readonly: true, noEffect: true },
    exec: async (args) => ({
      ok: false,
      error: args?.reason || 'forced failure',
      _thrownError: true,
    }),
  },
  { autoRegister: false }
);

export function registerProviderTestTools(registry: ToolRegistry) {
  registry.register(alwaysOkTool.name, () => alwaysOkTool);
  registry.register(alwaysFailTool.name, () => alwaysFailTool);
}
