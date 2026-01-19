import { Hooks } from './hooks';

export type PermissionDecisionMode = 'auto' | 'approval' | 'readonly' | (string & {});

export interface PermissionConfig {
  mode: PermissionDecisionMode;
  requireApprovalTools?: string[];
  allowTools?: string[];
  denyTools?: string[];
  metadata?: Record<string, any>;
}

export interface SubAgentConfig {
  templates?: string[];
  depth: number;
  inheritConfig?: boolean;
  overrides?: {
    permission?: PermissionConfig;
    todo?: TodoConfig;
  };
}

export interface TodoConfig {
  enabled: boolean;
  remindIntervalSteps?: number;
  storagePath?: string;
  reminderOnStart?: boolean;
}

export interface AgentTemplateDefinition {
  id: string;
  name?: string;
  desc?: string;
  version?: string;
  systemPrompt: string;
  model?: string;
  sandbox?: Record<string, any>;
  tools?: '*' | string[];
  permission?: PermissionConfig;
  runtime?: TemplateRuntimeConfig;
  hooks?: Hooks;
  metadata?: Record<string, any>;
}

export interface TemplateRuntimeConfig {
  exposeThinking?: boolean;
  retainThinking?: boolean;
  multimodalContinuation?: 'history';
  multimodalRetention?: { keepRecent?: number };
  todo?: TodoConfig;
  subagents?: SubAgentConfig;
  metadata?: Record<string, any>;
}

export class AgentTemplateRegistry {
  private templates = new Map<string, AgentTemplateDefinition>();

  register(template: AgentTemplateDefinition): void {
    if (!template.id) throw new Error('Template id is required');
    if (!template.systemPrompt || !template.systemPrompt.trim()) {
      throw new Error(`Template ${template.id} must provide a non-empty systemPrompt`);
    }
    this.templates.set(template.id, template);
  }

  bulkRegister(templates: AgentTemplateDefinition[]): void {
    for (const tpl of templates) {
      this.register(tpl);
    }
  }

  has(id: string): boolean {
    return this.templates.has(id);
  }

  get(id: string): AgentTemplateDefinition {
    const tpl = this.templates.get(id);
    if (!tpl) {
      throw new Error(`Template not found: ${id}`);
    }
    return tpl;
  }

  list(): AgentTemplateDefinition[] {
    return Array.from(this.templates.values());
  }
}
