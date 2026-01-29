import fs from 'fs';
import path from 'path';
import { FilePool } from '../../../src/core/file-pool';
import { LocalSandbox } from '../../../src/infra/sandbox';
import { TestRunner, expect } from '../../helpers/utils';
import { TEST_ROOT } from '../../helpers/fixtures';

const runner = new TestRunner('FilePool');

function createTempDir(name: string): string {
  const dir = path.join(TEST_ROOT, 'file-pool', `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

runner
  .test('记录读写并追踪新鲜度', async () => {
    const dir = createTempDir('freshness');
    const filePath = path.join(dir, 'note.txt');
    fs.writeFileSync(filePath, 'initial');

    const sandbox = new LocalSandbox({ workDir: dir, enforceBoundary: true, watchFiles: false });
    const pool = new FilePool(sandbox, { watch: false });

    await pool.recordRead('note.txt');
    const firstCheck = await pool.validateWrite('note.txt');
    expect.toEqual(firstCheck.isFresh, true);

    await new Promise(r => setTimeout(r, 50)); // 确保 mtime 变化
    fs.writeFileSync(filePath, 'updated');
    const freshness = await pool.validateWrite('note.txt');
    expect.toEqual(freshness.isFresh, false);

    await pool.recordEdit('note.txt');
    const tracked = pool.getTrackedFiles();
    expect.toHaveLength(tracked, 1);

    const summary = pool.getAccessedFiles();
    expect.toHaveLength(summary, 1);
  })

  .test('记录后若无访问返回默认新鲜度', async () => {
    const dir = createTempDir('default');
    const sandbox = new LocalSandbox({ workDir: dir, enforceBoundary: true, watchFiles: false });
    const pool = new FilePool(sandbox, { watch: false });

    const status = await pool.checkFreshness('missing.txt');
    expect.toEqual(status.isFresh, false);
  })

  .test('并发 recordEdit 不会创建重复 watcher', async () => {
    const dir = createTempDir('concurrent');
    const filePath = path.join(dir, 'test.txt');
    fs.writeFileSync(filePath, 'content');

    const sandbox = new LocalSandbox({ workDir: dir, enforceBoundary: true, watchFiles: false });

    // 追踪 watchFiles 调用次数
    const watchCalls: string[] = [];
    (sandbox as any).watchFiles = async (paths: string[]) => {
      watchCalls.push(paths[0]);
      await new Promise(r => setTimeout(r, 50)); // 模拟异步延迟
      return `watch-${watchCalls.length}`;
    };

    const pool = new FilePool(sandbox, { watch: true });

    // 并发调用 3 次 recordEdit
    await Promise.all([
      pool.recordEdit('test.txt'),
      pool.recordEdit('test.txt'),
      pool.recordEdit('test.txt'),
    ]);

    // 验证只创建了 1 个 watcher（per-path 锁生效）
    expect.toEqual(watchCalls.length, 1);
  })

  .test('不同文件的并发 recordEdit 各自创建 watcher', async () => {
    const dir = createTempDir('concurrent-multi');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
    fs.writeFileSync(path.join(dir, 'c.txt'), 'c');

    const sandbox = new LocalSandbox({ workDir: dir, enforceBoundary: true, watchFiles: false });

    const watchCalls: string[] = [];
    (sandbox as any).watchFiles = async (paths: string[]) => {
      watchCalls.push(paths[0]);
      await new Promise(r => setTimeout(r, 30));
      return `watch-${watchCalls.length}`;
    };

    const pool = new FilePool(sandbox, { watch: true });

    // 并发操作 3 个不同文件
    await Promise.all([
      pool.recordEdit('a.txt'),
      pool.recordEdit('b.txt'),
      pool.recordEdit('c.txt'),
    ]);

    // 每个文件各创建 1 个 watcher
    expect.toEqual(watchCalls.length, 3);
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
