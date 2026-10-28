import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { LocalSandbox } from '../../../src';
import { TestRunner, expect } from '../../helpers/utils';

const runner = new TestRunner('LocalSandbox filesystem boundary');

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kode-boundary-'));
  const work = path.join(directory, 'work');
  const outside = path.join(directory, 'outside');
  await fs.mkdir(work); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'sentinel.txt'), 'OUTSIDE_SENTINEL');
  await fs.symlink(outside, path.join(work, 'linked-directory'));
  await fs.symlink(path.join(outside, 'sentinel.txt'), path.join(work, 'linked-file'));
  const sandbox = new LocalSandbox({ workDir: work, watchFiles: false, enforceBoundary: true });
  return { directory, work, outside, sandbox, async close() { await sandbox.dispose(); await fs.rm(directory, { recursive: true, force: true }); } };
}

runner.test('symlink targets outside the sandbox cannot be read or statted', async () => {
  const ctx = await fixture();
  try {
    await expect.toThrow(async () => { await ctx.sandbox.fs.read('linked-file'); }, 'outside sandbox');
    await expect.toThrow(async () => { await ctx.sandbox.fs.stat('linked-directory/sentinel.txt'); }, 'outside sandbox');
  } finally { await ctx.close(); }
});

runner.test('symlink writes cannot overwrite or create files outside the sandbox', async () => {
  const ctx = await fixture();
  try {
    await expect.toThrow(async () => { await ctx.sandbox.fs.write('linked-file', 'changed'); }, 'outside sandbox');
    await expect.toThrow(async () => { await ctx.sandbox.fs.write('linked-directory/new.txt', 'changed'); }, 'outside sandbox');
    expect.toEqual(await fs.readFile(path.join(ctx.outside, 'sentinel.txt'), 'utf8'), 'OUTSIDE_SENTINEL');
    expect.toEqual(await fs.stat(path.join(ctx.outside, 'new.txt')).then(() => true, () => false), false);
  } finally { await ctx.close(); }
});

runner.test('absolute paths use the same normalization for boundary checks and filesystem operations', async () => {
  const ctx = await fixture();
  try {
    const inside = path.join(ctx.work, 'sentinel.txt');
    await fs.writeFile(inside, 'INSIDE_SENTINEL');
    await fs.mkdir(path.join(ctx.outside, 'nested'));
    await fs.symlink(path.join(ctx.outside, 'nested'), path.join(ctx.work, 'parent-link'));
    await fs.utimes(inside, 1000, 1000);
    await fs.utimes(path.join(ctx.outside, 'sentinel.txt'), 2000, 2000);
    const ambiguous = ctx.work + path.sep + 'parent-link' + path.sep + '..' + path.sep + 'sentinel.txt';
    expect.toEqual(await ctx.sandbox.fs.read(ambiguous), 'INSIDE_SENTINEL');
    expect.toEqual((await ctx.sandbox.fs.stat(ambiguous)).mtimeMs, (await fs.stat(inside)).mtimeMs);
    await ctx.sandbox.fs.write(ambiguous, 'inside changed');
    expect.toEqual(await fs.readFile(inside, 'utf8'), 'inside changed');
    expect.toEqual(await fs.readFile(path.join(ctx.outside, 'sentinel.txt'), 'utf8'), 'OUTSIDE_SENTINEL');
    expect.toDeepEqual(await ctx.sandbox.fs.glob('parent-link/../sentinel.txt'), ['sentinel.txt']);
    expect.toDeepEqual(await ctx.sandbox.fs.glob('parent-link/../*.txt'), ['sentinel.txt']);
  } finally { await ctx.close(); }
});

runner.test('nested symbolic link targets preserve parent traversal when checking existing files', async () => {
  const ctx = await fixture();
  try {
    await fs.writeFile(path.join(ctx.work, 'sentinel.txt'), 'INSIDE_SENTINEL');
    await fs.mkdir(path.join(ctx.outside, 'nested'));
    await fs.symlink(path.join(ctx.outside, 'nested'), path.join(ctx.work, 'parent-link'));
    await fs.symlink('parent-link/../sentinel.txt', path.join(ctx.work, 'nested-target'));
    await expect.toThrow(async () => { await ctx.sandbox.fs.read('nested-target'); }, 'outside sandbox');
    await expect.toThrow(async () => { await ctx.sandbox.fs.stat('nested-target'); }, 'outside sandbox');
    await expect.toThrow(async () => { await ctx.sandbox.fs.write('nested-target', 'changed'); }, 'outside sandbox');
    expect.toEqual(await fs.readFile(path.join(ctx.outside, 'sentinel.txt'), 'utf8'), 'OUTSIDE_SENTINEL');
  } finally { await ctx.close(); }
});

runner.test('dangling nested symbolic link targets cannot create outside files', async () => {
  const ctx = await fixture();
  try {
    await fs.mkdir(path.join(ctx.outside, 'nested'));
    await fs.symlink(path.join(ctx.outside, 'nested'), path.join(ctx.work, 'parent-link'));
    await fs.symlink('parent-link/../not-created.txt', path.join(ctx.work, 'dangling-nested-target'));
    await expect.toThrow(async () => { await ctx.sandbox.fs.write('dangling-nested-target', 'blocked'); }, 'outside sandbox');
    expect.toEqual(await fs.stat(path.join(ctx.outside, 'not-created.txt')).then(() => true, () => false), false);
  } finally { await ctx.close(); }
});

runner.test('glob cannot enumerate an outside cwd or symlink directory', async () => {
  const ctx = await fixture();
  try {
    await expect.toThrow(async () => { await ctx.sandbox.fs.glob('*.txt', { cwd: ctx.outside }); }, 'outside sandbox');
    expect.toDeepEqual(await ctx.sandbox.fs.glob('**/*.txt'), []);
  } finally { await ctx.close(); }
});

runner.test('explicit allowPaths permits the same symlink target', async () => {
  const ctx = await fixture();
  const sandbox = new LocalSandbox({ workDir: ctx.work, allowPaths: [ctx.outside], watchFiles: false });
  try {
    expect.toEqual(await sandbox.fs.read('linked-file'), 'OUTSIDE_SENTINEL');
    await sandbox.fs.write('linked-directory/allowed.txt', 'allowed');
    expect.toEqual(await fs.readFile(path.join(ctx.outside, 'allowed.txt'), 'utf8'), 'allowed');
    expect.toDeepEqual((await sandbox.fs.glob('*.txt', { cwd: ctx.outside })).sort(), ['../outside/allowed.txt', '../outside/sentinel.txt']);
  } finally { await sandbox.dispose(); await ctx.close(); }
});

runner.test('explicitly disabled boundaries retain unrestricted read and glob behavior', async () => {
  const ctx = await fixture();
  const sandbox = new LocalSandbox({ workDir: ctx.work, enforceBoundary: false, watchFiles: false });
  try {
    expect.toEqual(await sandbox.fs.read('linked-file'), 'OUTSIDE_SENTINEL');
    expect.toDeepEqual(await sandbox.fs.glob('linked-directory/*.txt'), ['linked-directory/sentinel.txt']);
  } finally { await sandbox.dispose(); await ctx.close(); }
});

runner.test('dangling links to outside targets cannot create those targets', async () => {
  const ctx = await fixture();
  try {
    await fs.symlink(path.join(ctx.outside, 'not-created.txt'), path.join(ctx.work, 'dangling'));
    await expect.toThrow(async () => { await ctx.sandbox.fs.write('dangling', 'blocked'); }, 'outside sandbox');
    expect.toEqual(await fs.stat(path.join(ctx.outside, 'not-created.txt')).then(() => true, () => false), false);
  } finally { await ctx.close(); }
});

runner.test('a symlink used as the configured work directory retains its boundary', async () => {
  const ctx = await fixture();
  const linkedRoot = path.join(ctx.directory, 'work-alias');
  await fs.symlink(ctx.work, linkedRoot);
  const sandbox = new LocalSandbox({ workDir: linkedRoot, watchFiles: false });
  try {
    await sandbox.fs.write('..notes', 'inside');
    expect.toEqual(await sandbox.fs.read('..notes'), 'inside');
    await expect.toThrow(async () => { await sandbox.fs.read('linked-file'); }, 'outside sandbox');
  } finally { await sandbox.dispose(); await ctx.close(); }
});

runner.test('retargeting a symlink is checked on the next operation and glob traversal is rejected', async () => {
  const ctx = await fixture();
  const link = path.join(ctx.work, 'changing');
  await fs.writeFile(path.join(ctx.work, 'inside.txt'), 'inside');
  await fs.symlink(path.join(ctx.work, 'inside.txt'), link);
  try {
    expect.toEqual(await ctx.sandbox.fs.read('changing'), 'inside');
    await fs.unlink(link);
    await fs.symlink(path.join(ctx.outside, 'sentinel.txt'), link);
    await expect.toThrow(async () => { await ctx.sandbox.fs.read('changing'); }, 'outside sandbox');
    await expect.toThrow(async () => { await ctx.sandbox.fs.glob('../outside/*.txt'); }, 'outside sandbox');
  } finally { await ctx.close(); }
});

runner.test('deep new directories do not consume the symbolic link limit', async () => {
  const ctx = await fixture();
  try {
    const file = Array.from({ length: 70 }, () => 'd').join('/') + '/note.txt';
    await ctx.sandbox.fs.write(file, 'deep inside');
    expect.toEqual(await ctx.sandbox.fs.read(file), 'deep inside');
  } finally { await ctx.close(); }
});

export async function run() { return runner.run(); }
