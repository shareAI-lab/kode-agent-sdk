import fs from 'fs';
import path from 'path';
import { LocalSandbox } from '../../../src/infra/sandbox';
import { TestRunner, expect } from '../../helpers/utils';
import { TEST_ROOT } from '../../helpers/fixtures';
import { EventEmitter } from 'events';

const runner = new TestRunner('LocalSandbox');

function tempDir(name: string) {
  const dir = path.join(TEST_ROOT, 'sandbox', `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function within<T>(task: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([task, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('File watcher did not observe the change')), 3000);
    })]);
  } finally { clearTimeout(timer); }
}

runner
  .test('读写文件并强制边界', async () => {
    const dir = tempDir('fs');
    const sandbox = new LocalSandbox({ workDir: dir, enforceBoundary: true });

    await sandbox.fs.write('notes.txt', 'hello');
    const content = await sandbox.fs.read('notes.txt');
    expect.toEqual(content, 'hello');

    await expect.toThrow(async () => {
      await sandbox.fs.read('../outside.txt');
    });
  })

  .test('exec 阻止危险命令并允许安全命令', async () => {
    const dir = tempDir('exec');
    const sandbox = new LocalSandbox({ workDir: dir });

    const safe = await sandbox.exec('echo test');
    expect.toContain(safe.stdout.trim(), 'test');
    expect.toEqual(safe.code, 0);

    const blocked = await sandbox.exec('rm -rf /');
    expect.toEqual(blocked.code, 1);
    expect.toContain(blocked.stderr, 'Dangerous command');
  })

  .test('watchFiles 返回ID并可取消', async () => {
    const dir = tempDir('watch');
    const sandbox = new LocalSandbox({ workDir: dir, watchFiles: true });
    const file = path.join(dir, 'file.txt');
    fs.writeFileSync(file, 'content');

    const events: number[] = [];
    let timeout: NodeJS.Timeout | undefined;
    let observed = () => {};
    let id: string | undefined;
    try {
      id = await sandbox.watchFiles(['file.txt'], (evt) => {
        events.push(evt.mtimeMs);
        observed();
      });
      const change = new Promise<void>((resolve, reject) => {
        observed = resolve;
        timeout = setTimeout(() => reject(new Error('File change was not observed within 2 seconds')), 2000);
      });
      fs.writeFileSync(file, 'updated');
      await change;
      expect.toBeGreaterThan(events.length, 0);
    } finally {
      clearTimeout(timeout);
      if (id) sandbox.unwatchFiles?.(id);
      await sandbox.dispose?.();
    }
  });

runner.test('watchFiles observes changes and stops after cancellation when native watching exhausts resources', async () => {
  const dir = tempDir('watch-fallback');
  const sandbox = new LocalSandbox({ workDir: dir, watchFiles: true });
  const file = path.join(dir, 'file.txt');
  fs.writeFileSync(file, 'before');
  const original = fs.watch;
  let observed!: () => void;
  const changed = new Promise<void>(resolve => { observed = resolve; });
  let events = 0;
  (fs as any).watch = () => { throw Object.assign(new Error('controlled native limit'), { code: 'EMFILE' }); };
  try {
    const id = await sandbox.watchFiles(['file.txt'], () => { events++; observed(); });
    fs.writeFileSync(file, 'first change');
    await within(changed);
    expect.toEqual(events, 1);
    sandbox.unwatchFiles(id);
    fs.writeFileSync(file, 'after unwatch');
    await new Promise(resolve => setTimeout(resolve, 350));
    expect.toEqual(events, 1);
  } finally { (fs as any).watch = original; await sandbox.dispose(); }
});

runner.test('asynchronous native watcher errors retain change detection through polling', async () => {
  const dir = tempDir('watch-async-error');
  const sandbox = new LocalSandbox({ workDir: dir, watchFiles: true });
  const file = path.join(dir, 'file.txt');
  fs.writeFileSync(file, 'before');
  const original = fs.watch;
  const watcher = new EventEmitter() as EventEmitter & { close(): void };
  let closed = false;
  watcher.close = () => { closed = true; };
  let observed!: () => void;
  const changed = new Promise<void>(resolve => { observed = resolve; });
  (fs as any).watch = () => watcher;
  try {
    await sandbox.watchFiles(['file.txt'], () => observed());
    watcher.emit('error', Object.assign(new Error('controlled async native error'), { code: 'EMFILE' }));
    fs.writeFileSync(file, 'changed');
    await within(changed);
    expect.toEqual(closed, true);
  } finally { (fs as any).watch = original; await sandbox.dispose(); }
});

runner.test('failed multi-path watcher setup closes handles already created', async () => {
  const dir = tempDir('watch-setup-error');
  const sandbox = new LocalSandbox({ workDir: dir, watchFiles: true });
  fs.writeFileSync(path.join(dir, 'one.txt'), 'one');
  fs.writeFileSync(path.join(dir, 'two.txt'), 'two');
  const original = fs.watch;
  let started = 0, closed = 0;
  (fs as any).watch = () => {
    if (++started === 2) throw Object.assign(new Error('controlled watch denied'), { code: 'EACCES' });
    return Object.assign(new EventEmitter(), { close() { closed++; } });
  };
  try {
    await expect.toThrow(async () => { await sandbox.watchFiles(['one.txt', 'two.txt'], () => {}); }, 'controlled watch denied');
    expect.toEqual(closed, 1);
    expect.toEqual((sandbox as any).watchers.size, 0);
  } finally { (fs as any).watch = original; await sandbox.dispose(); }
});

runner.test('a watched file can be created after registration and disposal releases its polling', async () => {
  const dir = tempDir('watch-create');
  const sandbox = new LocalSandbox({ workDir: dir, watchFiles: true });
  let observed!: () => void;
  const changed = new Promise<void>(resolve => { observed = resolve; });
  try {
    await sandbox.watchFiles(['later.txt'], () => observed());
    fs.writeFileSync(path.join(dir, 'later.txt'), 'created');
    await within(changed);
  } finally { await sandbox.dispose(); }
});

runner.test('dispose cancels a watcher registration waiting for its first stat', async () => {
  const dir = tempDir('watch-pending-dispose');
  const sandbox = new LocalSandbox({ workDir: dir, watchFiles: true });
  const file = path.join(dir, 'file.txt'); fs.writeFileSync(file, 'before');
  const stat = fs.promises.stat;
  const watch = fs.watch;
  const interval = globalThis.setInterval;
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let nativeCreated = 0, pollingCreated = 0;
  (globalThis as any).setInterval = (...args: any[]) => { pollingCreated++; return (interval as any)(...args); };
  (fs.promises as any).stat = async (target: any, ...args: any[]) => {
    if (target === file) { entered(); await gate; }
    return (stat as any)(target, ...args);
  };
  (fs as any).watch = () => { nativeCreated++; return Object.assign(new EventEmitter(), { close() {} }); };
  const pending = sandbox.watchFiles(['file.txt'], () => { throw new Error('disposed watcher callback'); });
  try {
    await within(started);
    await sandbox.dispose(); release(); await pending;
    expect.toEqual(nativeCreated, 0);
    expect.toEqual(pollingCreated, 0);
    expect.toEqual((sandbox as any).watchers.size, 0);
  } finally {
    try { release(); await pending; }
    finally {
      (fs.promises as any).stat = stat; (fs as any).watch = watch; (globalThis as any).setInterval = interval;
      await sandbox.dispose();
    }
  }
});

runner.test('native directory notifications survive an unchanged directory stat', async () => {
  const dir = tempDir('watch-directory');
  fs.writeFileSync(path.join(dir, 'child.txt'), 'before');
  const sandbox = new LocalSandbox({ workDir: dir, watchFiles: true });
  const watch = fs.watch;
  const watcher = Object.assign(new EventEmitter(), { close() {} });
  let observed!: () => void;
  const changed = new Promise<void>(resolve => { observed = resolve; });
  (fs as any).watch = (_target: string, listener: (...args: any[]) => void) => { watcher.on('change', listener); return watcher; };
  try {
    await sandbox.watchFiles(['.'], () => observed());
    fs.writeFileSync(path.join(dir, 'child.txt'), 'after');
    watcher.emit('change', 'change', 'child.txt');
    await within(changed);
  } finally { (fs as any).watch = watch; await sandbox.dispose(); }
});

export async function run() {
  return await runner.run();
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
