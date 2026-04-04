type StepCallback = (ctx: { stepCount: number }) => void | Promise<void>;
type TaskCallback = () => void | Promise<void>;

export type AgentSchedulerHandle = string;

interface StepTask {
  id: string;
  every: number;
  callback: StepCallback;
  lastTriggered: number;
}

type TriggerKind = 'steps' | 'time' | 'cron';

export interface SchedulerTriggerInfo {
  taskId: string;
  spec: string;
  kind: TriggerKind;
}

interface SchedulerOptions {
  onTrigger?: (info: SchedulerTriggerInfo) => void;
  onTriggerStart?: (info: SchedulerTriggerInfo) => void;
  onTriggerEnd?: (info: SchedulerTriggerInfo) => void;
}

export class Scheduler {
  private readonly stepTasks = new Map<string, StepTask>();
  private readonly listeners = new Set<StepCallback>();
  private queued: Promise<void> = Promise.resolve();
  private readonly onTrigger?: SchedulerOptions['onTrigger'];
  private readonly onTriggerStart?: SchedulerOptions['onTriggerStart'];
  private readonly onTriggerEnd?: SchedulerOptions['onTriggerEnd'];

  constructor(opts?: SchedulerOptions) {
    this.onTrigger = opts?.onTrigger;
    this.onTriggerStart = opts?.onTriggerStart;
    this.onTriggerEnd = opts?.onTriggerEnd;
  }

  everySteps(every: number, callback: StepCallback): AgentSchedulerHandle {
    if (!Number.isFinite(every) || every <= 0) {
      throw new Error('everySteps: interval must be positive');
    }
    const id = this.generateId('steps');
    this.stepTasks.set(id, {
      id,
      every,
      callback,
      lastTriggered: 0,
    });
    return id;
  }

  onStep(callback: StepCallback): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  enqueue(callback: TaskCallback): void {
    this.queued = this.queued.then(() => Promise.resolve(callback())).catch(() => undefined);
  }

  notifyStep(stepCount: number) {
    for (const listener of this.listeners) {
      void Promise.resolve(listener({ stepCount }));
    }

    for (const task of this.stepTasks.values()) {
      const shouldTrigger = stepCount - task.lastTriggered >= task.every;
      if (!shouldTrigger) continue;
      task.lastTriggered = stepCount;
      const info: SchedulerTriggerInfo = { taskId: task.id, spec: `steps:${task.every}`, kind: 'steps' };
      this.runTriggeredTask(info, () => task.callback({ stepCount }), { emitTrigger: 'before' });
    }
  }

  cancel(taskId: AgentSchedulerHandle) {
    this.stepTasks.delete(taskId);
  }

  clear() {
    this.stepTasks.clear();
    this.listeners.clear();
  }

  notifyExternalTrigger(info: { taskId: string; spec: string; kind: 'time' | 'cron' }) {
    this.onTrigger?.(info);
  }

  runExternalTrigger(info: { taskId: string; spec: string; kind: 'time' | 'cron' }, callback: TaskCallback): void {
    this.enqueue(() => this.runTriggeredTask(info, callback, { emitTrigger: 'afterSuccess' }));
  }

  private generateId(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  private async runTriggeredTask(
    info: SchedulerTriggerInfo,
    callback: TaskCallback,
    opts: { emitTrigger: 'before' | 'afterSuccess' }
  ): Promise<void> {
    this.onTriggerStart?.(info);
    try {
      if (opts.emitTrigger === 'before') {
        this.onTrigger?.(info);
      }
      await callback();
      if (opts.emitTrigger === 'afterSuccess') {
        this.onTrigger?.(info);
      }
    } finally {
      this.onTriggerEnd?.(info);
    }
  }
}
