/**
 * 单元测试运行器
 */

globalThis.fetch = (async () => { throw new Error('Live fetch is disabled in unit tests'); }) as typeof fetch;

import path from 'path';
import fg from 'fast-glob';
import { ensureCleanDir } from './helpers/setup';
import { TEST_ROOT } from './helpers/fixtures';

async function runAll() {
  ensureCleanDir(TEST_ROOT);

  console.log('\n' + '='.repeat(80));
  console.log('KODE SDK - 单元测试套件');
  console.log('='.repeat(80));

  const cwd = path.resolve(__dirname);

  const entries = await fg('unit/**/*.test.ts', {
    cwd,
    absolute: false,
    dot: false,
    followSymbolicLinks: false,
  });

  if (entries.length === 0) {
    console.log('\n⚠️  未发现单元测试文件\n');
    return;
  }

  entries.sort();

  let totalPassed = 0;
  let totalFailed = 0;
  let skippedSuites = 0;
  const allFailures: Array<{ suite: string; test: string; error: Error }> = [];

  for (const relativePath of entries) {
    if (relativePath === 'unit/infra/db/postgres-store.test.ts' && process.env.KODE_TEST_POSTGRES !== '1') {
      skippedSuites++;
      console.log('PostgresStore: skipped (set KODE_TEST_POSTGRES=1 to run against a test database)');
      continue;
    }
    const moduleName = relativePath.replace(/\.test\.ts$/, '').replace(/\//g, ' › ');
    const importPath = './' + relativePath.replace(/\\/g, '/');
    try {
      const testModule = await import(importPath);
      const result = await testModule.run();

      if (result.output) {
        process.stdout.write(result.output + '\n');
      }

      totalPassed += result.passed;
      totalFailed += result.failed;

      for (const failure of result.failures) {
        allFailures.push({
          suite: moduleName,
          test: failure.name,
          error: failure.error,
        });
      }
    } catch (error: any) {
      console.error(`\n✗ 加载测试模块失败: ${moduleName}`);
      console.error(`  ${error.message}\n`);
      totalFailed++;
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log(`总结: ${totalPassed} 通过, ${totalFailed} 失败, ${skippedSuites} 套件跳过`);
  console.log('='.repeat(80) + '\n');

  if (allFailures.length > 0) {
    console.log('失败详情:');
    for (const { suite, test, error } of allFailures) {
      console.log(`  [${suite}] ${test}`);
      console.log(`    ${error.message}`);
    }
    console.log('');
  }

  if (totalFailed > 0) {
    process.exitCode = 1;
  } else {
    console.log('✓ 所有单元测试通过\n');
  }
}

runAll().catch(err => {
  console.error('测试运行器错误:', err);
  process.exitCode = 1;
});
