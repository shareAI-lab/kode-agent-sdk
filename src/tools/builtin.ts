import { ToolInstance } from './registry';
import { FsRead } from './fs_read';
import { FsWrite } from './fs_write';
import { FsEdit } from './fs_edit';
import { FsGlob } from './fs_glob';
import { FsGrep } from './fs_grep';
import { FsMultiEdit } from './fs_multi_edit';
import { BashRun } from './bash_run';
import { BashLogs } from './bash_logs';
import { BashKill } from './bash_kill';
import { TodoRead } from './todo_read';
import { TodoWrite } from './todo_write';
import { createTaskRunTool } from './task_run';
import type { AgentTemplate } from './task_run';

export const builtin = {
  fs: (): ToolInstance[] => [FsRead, FsWrite, FsEdit, FsGlob, FsGrep, FsMultiEdit],
  bash: (): ToolInstance[] => [BashRun, BashLogs, BashKill],
  todo: (): ToolInstance[] => [TodoRead, TodoWrite],
  task: (templates?: AgentTemplate[]): ToolInstance | null => {
    if (!templates || templates.length === 0) {
      return null;
    }
    return createTaskRunTool(templates);
  },
};

export type { AgentTemplate };
