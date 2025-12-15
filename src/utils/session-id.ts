export interface SessionIdComponents {
  orgId?: string;
  teamId?: string;
  userId?: string;
  agentTemplate: string;
  rootId: string;
  forkIds: string[];
}

export class SessionId {
  static parse(id: string): SessionIdComponents {
    const parts = id.split('/');
    const components: SessionIdComponents = {
      agentTemplate: '',
      rootId: '',
      forkIds: [],
    };

    for (const part of parts) {
      if (part.startsWith('org:')) {
        components.orgId = part.slice(4);
      } else if (part.startsWith('team:')) {
        components.teamId = part.slice(5);
      } else if (part.startsWith('user:')) {
        components.userId = part.slice(5);
      } else if (part.startsWith('agent:')) {
        components.agentTemplate = part.slice(6);
      } else if (part.startsWith('session:')) {
        components.rootId = part.slice(8);
      } else if (part.startsWith('fork-')) {
        components.forkIds.push(part.slice(5));
      }
    }

    return components;
  }

  static generate(opts: {
    orgId?: string;
    teamId?: string;
    userId?: string;
    agentTemplate: string;
    parentSessionId?: string;
  }): string {
    const parts: string[] = [];

    if (opts.orgId) parts.push(`org:${opts.orgId}`);
    if (opts.teamId) parts.push(`team:${opts.teamId}`);
    if (opts.userId) parts.push(`user:${opts.userId}`);

    parts.push(`agent:${opts.agentTemplate}`);

    if (opts.parentSessionId) {
      const parent = SessionId.parse(opts.parentSessionId);
      parts.push(`session:${parent.rootId}`);
      parts.push(...parent.forkIds.map((id) => `fork-${id}`));
      parts.push(`fork-${this.randomId()}`);
    } else {
      parts.push(`session:${this.randomId()}`);
    }

    return parts.join('/');
  }

  static snapshot(sessionId: string, sfpIndex: number): string {
    return `${sessionId}@sfp-${sfpIndex}`;
  }

  static label(sessionId: string, label: string): string {
    return `${sessionId}@label:${label}`;
  }

  private static randomId(): string {
    return Math.random().toString(36).slice(2, 8);
  }
}
