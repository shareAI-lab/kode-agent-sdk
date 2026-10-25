export type SandboxKind = 'local' | 'docker' | 'k8s' | 'remote' | 'vfs' | 'e2b' | 'opensandbox';

export interface SandboxFS {
  resolve(path: string): string;
  isInside(path: string): boolean;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  temp(name?: string): string;
  stat(path: string): Promise<{ mtimeMs: number }>;
  glob(pattern: string, opts?: { cwd?: string; ignore?: string[]; dot?: boolean; absolute?: boolean }): Promise<string[]>;
}

export interface SandboxExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Sandbox {
  kind: SandboxKind;
  workDir?: string;
  fs: SandboxFS;
  exec(cmd: string, opts?: { timeoutMs?: number }): Promise<SandboxExecResult>;
  watchFiles?(paths: string[], listener: (event: { path: string; mtimeMs: number }) => void): Promise<string>;
  unwatchFiles?(id: string): void;
  dispose?(): Promise<void> | void;
  toConfig?(): { kind: SandboxKind } & Record<string, any>;
}

export interface LocalSandboxOptions {
  workDir?: string;
  baseDir?: string;
  pwd?: string;
  enforceBoundary?: boolean;
  allowPaths?: string[];
  watchFiles?: boolean;
}

// 危险命令模式 - 防止执行破坏性操作
const DANGEROUS_PATTERNS = [
  /rm\s+-rf\s+\/($|\s)/,                    // rm -rf /
  /sudo\s+/,                                 // sudo 提权
  /shutdown/,                                // 系统关机
  /reboot/,                                  // 系统重启
  /mkfs\./,                                  // 格式化文件系统
  /dd\s+.*of=/,                              // dd 写入设备
  /:\(\)\{\s*:\|\:&\s*\};:/,                 // fork bomb
  /chmod\s+777\s+\//,                        // 修改根目录权限
  /curl\s+.*\|\s*(bash|sh)/,                 // 管道执行远程脚本
  /wget\s+.*\|\s*(bash|sh)/,                 // wget 执行远程脚本
  />\s*\/dev\/sda/,                          // 直接写入硬盘
  /mkswap/,                                  // 创建交换分区
  /swapon/,                                  // 启用交换分区
];

export class LocalSandbox implements Sandbox {
  kind: SandboxKind = 'local';
  workDir: string;
  fs: SandboxFS;
  private watchers = new Map<string, { paths: string[]; close: () => void }>();
  private readonly enforceBoundary: boolean;
  private readonly allowPaths: string[];
  private readonly watchEnabled: boolean;

  toConfig() {
    return {
      kind: this.kind, workDir: this.workDir, enforceBoundary: this.enforceBoundary,
      allowPaths: [...this.allowPaths], watchFiles: this.watchEnabled,
    };
  }

  constructor(opts: LocalSandboxOptions = {}) {
    const path = require('path');
    this.workDir = path.resolve(opts.workDir || opts.baseDir || opts.pwd || process.cwd());
    this.enforceBoundary = opts.enforceBoundary !== false;
    this.allowPaths = (opts.allowPaths || []).map((p) => path.resolve(p));
    this.watchEnabled = opts.watchFiles !== false; // default true
    this.fs = new LocalFS(this.workDir, {
      enforceBoundary: this.enforceBoundary,
      allowPaths: this.allowPaths,
    });
  }

  async exec(cmd: string, opts?: { timeoutMs?: number }): Promise<SandboxExecResult> {
    // 安全检查：阻止危险命令
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(cmd)) {
        const error = `Dangerous command blocked for security: ${cmd.slice(0, 100)}`;
        return {
          code: 1,
          stdout: '',
          stderr: error,
        };
      }
    }

    const { exec } = require('child_process');
    const util = require('util');
    const execPromise = util.promisify(exec);

    const timeout = opts?.timeoutMs || 120000;

    try {
      const { stdout, stderr } = await execPromise(cmd, {
        cwd: this.workDir,
        timeout,
        maxBuffer: 10 * 1024 * 1024,
      });
      return { code: 0, stdout: stdout || '', stderr: stderr || '' };
    } catch (error: any) {
      return {
        code: error.code || 1,
        stdout: error.stdout || '',
        stderr: error.stderr || error.message || '',
      };
    }
  }

  static local(opts: { workDir?: string; baseDir?: string; pwd?: string }): LocalSandbox {
    return new LocalSandbox(opts);
  }

  async watchFiles(paths: string[], listener: (event: { path: string; mtimeMs: number }) => void): Promise<string> {
    if (!this.watchEnabled) {
      return `watch-disabled-${Date.now()}`;
    }
    const id = `watch-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const fs = require('fs');
    const watchers: any[] = [];
    for (const path of paths) {
      const resolved = this.fs.resolve(path);
      if (!this.fs.isInside(resolved)) continue;
      const watcher = fs.watch(resolved, async () => {
        try {
          const stat = await this.fs.stat(resolved);
          listener({ path: resolved, mtimeMs: stat.mtimeMs });
        } catch {
          listener({ path: resolved, mtimeMs: Date.now() });
        }
      });
      watchers.push(watcher);
    }
    this.watchers.set(id, {
      paths,
      close: () => watchers.forEach((w) => w.close()),
    });
    return id;
  }

  unwatchFiles(id: string): void {
    const entry = this.watchers.get(id);
    if (entry) {
      entry.close();
      this.watchers.delete(id);
    }
  }

  async dispose(): Promise<void> {
    for (const entry of this.watchers.values()) {
      entry.close();
    }
    this.watchers.clear();
  }
}

interface LocalFSOptions {
  enforceBoundary: boolean;
  allowPaths: string[];
}

class LocalFS implements SandboxFS {
  constructor(private workDir: string, private options: LocalFSOptions) {}

  resolve(p: string): string {
    const path = require('path');
    if (path.isAbsolute(p)) return p;
    return path.resolve(this.workDir, p);
  }

  isInside(p: string): boolean {
    const path = require('path');
    const resolved = path.resolve(this.resolve(p)); // resolve 去除 ..

    // 1. 检查是否在 workDir 内
    const relativeToWork = path.relative(this.workDir, resolved);
    if (!relativeToWork.startsWith('..') && !path.isAbsolute(relativeToWork)) {
      return true;
    }

    // 2. 如果不强制边界检查，允许所有路径
    if (!this.options.enforceBoundary) return true;

    // 3. 检查白名单（先 resolve 防止绕过）
    return this.options.allowPaths.some((allowed) => {
      const resolvedAllowed = path.resolve(allowed); // 先 resolve
      const relative = path.relative(resolvedAllowed, resolved);
      return !relative.startsWith('..') && !path.isAbsolute(relative);
    });
  }

  async read(p: string): Promise<string> {
    const fs = require('fs').promises;
    const resolved = this.resolve(p);
    if (!this.isInside(resolved)) {
      throw new Error(`Path outside sandbox: ${p}`);
    }
    return await fs.readFile(resolved, 'utf-8');
  }

  async write(p: string, content: string): Promise<void> {
    const fs = require('fs').promises;
    const path = require('path');
    const resolved = this.resolve(p);
    if (!this.isInside(resolved)) {
      throw new Error(`Path outside sandbox: ${p}`);
    }
    const dir = path.dirname(resolved);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(resolved, content, 'utf-8');
  }

  temp(name?: string): string {
    const path = require('path');
    const tempName = name || `temp-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    return path.relative(this.workDir, path.join(this.workDir, '.temp', tempName));
  }

  async stat(p: string): Promise<{ mtimeMs: number }> {
    const fs = require('fs').promises;
    const resolved = this.resolve(p);
    if (!this.isInside(resolved)) {
      throw new Error(`Path outside sandbox: ${p}`);
    }
    const stat = await fs.stat(resolved);
    return { mtimeMs: stat.mtimeMs };
  }

  async glob(pattern: string, opts?: { cwd?: string; ignore?: string[]; dot?: boolean; absolute?: boolean }): Promise<string[]> {
    const path = require('path');
    const cwd = opts?.cwd ? this.resolve(opts.cwd) : this.workDir;
    let matches: string[];
    try {
      const fg = require('fast-glob');
      matches = await fg(pattern, {
        cwd,
        dot: opts?.dot ?? false,
        absolute: true,
        ignore: opts?.ignore,
      });
    } catch {
      matches = await this.manualGlob(pattern, { cwd, dot: opts?.dot ?? false });
    }
    const filtered = matches.filter((entry: string) => this.isInside(entry));
    if (opts?.absolute) {
      return filtered;
    }
    return filtered.map((entry: string) => path.relative(this.workDir, entry));
  }

  private async manualGlob(pattern: string, opts: { cwd: string; dot: boolean }): Promise<string[]> {
    const fs = require('fs').promises;
    const path = require('path');
    const normalizedPattern = pattern.split(path.sep).join('/');
    const results: string[] = [];

    const walk = async (dir: string) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!opts.dot && entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        const rel = path.relative(opts.cwd, full).split(path.sep).join('/');
        if (matchesGlob(normalizedPattern, rel)) {
          results.push(full);
        }
        if (entry.isDirectory()) {
          await walk(full);
        }
      }
    };

    await walk(opts.cwd);
    return results;
  }
}

function matchesGlob(pattern: string, target: string): boolean {
  const pSegs = pattern.split('/');
  const tSegs = target.split('/');
  return matchSegments(pSegs, tSegs);
}

function matchSegments(pattern: string[], target: string[]): boolean {
  if (pattern.length === 0) return target.length === 0;
  const [head, ...rest] = pattern;
  if (head === '**') {
    return (
      matchSegments(rest, target) ||
      (target.length > 0 && matchSegments(pattern, target.slice(1)))
    );
  }
  if (target.length === 0) return false;
  if (!matchSegment(head, target[0])) return false;
  return matchSegments(rest, target.slice(1));
}

function matchSegment(pattern: string, target: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regex = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${regex}$`).test(target);
}
