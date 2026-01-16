import fs from 'fs';
import path from 'path';
import { LocalSandbox } from '../../../src/infra/sandbox';
import { FsRead } from '../../../src/tools/fs_read';
import { FsWrite } from '../../../src/tools/fs_write';
import { FsEdit } from '../../../src/tools/fs_edit';
import { FsGlob } from '../../../src/tools/fs_glob';
import { FsGrep } from '../../../src/tools/fs_grep';
import { FsMultiEdit } from '../../../src/tools/fs_multi_edit';
import { ToolContext } from '../../../src/core/types';
import { TestRunner, expect } from '../../helpers/utils';
import { TEST_ROOT } from '../../helpers/fixtures';

const runner = new TestRunner('文件系统工具');

function tempDir(name: string) {
  const dir = path.join(TEST_ROOT, 'tools-fs', `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function createContext(workDir: string): ToolContext {
  const sandbox = new LocalSandbox({ workDir, watchFiles: false });
  const filePool = {
    recordRead: async () => {},
    recordEdit: async () => {},
    validateWrite: async () => ({ isFresh: true }),
  };
  return {
    agentId: 'agent',
    agent: {},
    sandbox,
    services: { filePool },
  } as ToolContext;
}

runner
  .test('fs_write 与 fs_read', async () => {
    const dir = tempDir('read-write');
    const ctx = createContext(dir);

    const writeResult = await FsWrite.exec({ path: 'hello.txt', content: 'hello world' }, ctx);
    expect.toEqual(writeResult.ok, true);

    const readResult = await FsRead.exec({ path: 'hello.txt' }, ctx);
    expect.toContain(readResult.content, 'hello world');
  })

  .test('fs_edit 支持 replace_all', async () => {
    const dir = tempDir('edit');
    const ctx = createContext(dir);
    fs.writeFileSync(path.join(dir, 'edit.txt'), 'one two two');

    const result = await FsEdit.exec({
      path: 'edit.txt',
      old_string: 'two',
      new_string: 'three',
      replace_all: true,
    }, ctx);

    expect.toEqual(result.ok, true);
    const content = fs.readFileSync(path.join(dir, 'edit.txt'), 'utf-8');
    expect.toContain(content, 'three');
  })

  .test('fs_glob 与 fs_grep', async () => {
    const dir = tempDir('glob');
    const ctx = createContext(dir);
    fs.writeFileSync(path.join(dir, 'a.ts'), 'const a = 1;');
    fs.writeFileSync(path.join(dir, 'b.ts'), 'const b = 2;');
    fs.writeFileSync(path.join(dir, 'c.txt'), 'hello world');

    const globResult = await FsGlob.exec({ pattern: '*.ts' }, ctx);
    expect.toEqual(globResult.matches.length, 2);

    const grepResult = await FsGrep.exec({ pattern: 'const', path: '**/*' }, ctx);
    expect.toBeGreaterThan(grepResult.matches.length, 0);
  })

  .test('fs_multi_edit 批量处理成功与跳过', async () => {
    const dir = tempDir('multi');
    const ctx = createContext(dir);
    fs.writeFileSync(path.join(dir, 'file.txt'), 'alpha beta gamma');

    const result = await FsMultiEdit.exec({
      edits: [
        { path: 'file.txt', find: 'beta', replace: 'BETA' },
        { path: 'file.txt', find: 'missing', replace: 'noop' },
      ],
    }, ctx);

    expect.toEqual(result.ok, false);
    expect.toEqual(result.results[0].status, 'ok');
    expect.toEqual(result.results[1].status, 'skipped');
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
