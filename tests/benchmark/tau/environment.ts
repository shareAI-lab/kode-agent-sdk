// ---------------------------------------------------------------------------
// TAU benchmark environment — manages DB state and dispatches tool calls
// ---------------------------------------------------------------------------

export type ToolHandler = (db: any, args: any) => any;

export class Environment {
  private db: any;
  private toolCallLog: Array<{ name: string; args: any; result: any }> = [];
  private handlers: Record<string, ToolHandler>;

  constructor(initialDb: any, handlers: Record<string, ToolHandler>) {
    // Deep clone so each trial gets an isolated copy
    this.db = JSON.parse(JSON.stringify(initialDb));
    this.handlers = handlers;
  }

  /** Return current database state (deep clone) as a generic record. */
  getState(): Record<string, any[]> {
    return JSON.parse(JSON.stringify(this.db));
  }

  /** Return log of all tool calls made during this simulation. */
  getToolCallLog() {
    return this.toolCallLog;
  }

  /** Dispatch a tool call by name. Returns the tool result as a JSON-serialisable value. */
  executeTool(name: string, args: any): any {
    let result: any;
    try {
      const handler = this.handlers[name];
      if (!handler) {
        result = { error: `Unknown tool: ${name}` };
      } else {
        result = handler(this.db, args);
      }
    } catch (err: any) {
      result = { error: err.message || String(err) };
    }
    this.toolCallLog.push({ name, args, result });
    return result;
  }
}
