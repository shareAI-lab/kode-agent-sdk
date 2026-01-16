/**
 * 集成测试运行器
 */

import './helpers/env-setup';
import path from 'path';
import fg from 'fast-glob';
import { ensureCleanDir, wait } from './helpers/setup';
import { TEST_ROOT } from './helpers/fixtures';

async function runAll() {
  ensureCleanDir(TEST_ROOT);

  console.log('\n' + '='.repeat(80));
  console.log('KODE SDK - 集成测试套件 (使用真实API)');
  console.log('='.repeat(80));

  const cwd = path.resolve(__dirname);

  const entries = await fg('integration/**/*.test.ts', {
    cwd,
    absolute: false,
    dot: false,
  });

  if (entries.length === 0) {
    console.log('\n⚠️  未发现集成测试文件\n');
    return;
  }

  entries.sort();

  let totalPassed = 0;
  let totalFailed = 0;
  const allFailures: Array<{ suite: string; test: string; error: Error }> = [];

  for (const relativePath of entries) {
    const moduleName = relativePath.replace(/\.test\.ts$/, '').replace(/\//g, ' › ');
    const importPath = './' + relativePath.replace(/\\/g, '/');
    try {
      const testModule = await import(importPath);
      const result = await testModule.run();

      totalPassed += result.passed;
      totalFailed += result.failed;

      for (const failure of result.failures) {
        allFailures.push({
          suite: moduleName,
          test: failure.name,
          error: failure.error,
        });
      }

      // API限流间隔
      await wait(1000);
    } catch (error: any) {
      console.error(`\n✗ 加载测试模块失败: ${moduleName}`);
      console.error(`  ${error.message}\n`);
      totalFailed++;
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log(`总结: ${totalPassed} 通过, ${totalFailed} 失败`);
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
    console.log('✓ 所有集成测试通过\n');
  }

}

runAll().catch(err => {
  console.error('测试运行器错误:', err);
  process.exitCode = 1;
});
