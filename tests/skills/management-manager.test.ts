/**
 * SkillsManagementManager 单元测试
 *
 * 测试覆盖:
 * - 13个核心管理操作
 * - 边界情况处理
 * - 错误处理
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { SkillsManagementManager } from '../../src/core/skills/management-manager';
import { TestRunner, expect } from '../helpers/utils';

const runner = new TestRunner('SkillsManagementManager');

// 测试用的SKILL.md内容
const validSkillMd = `---
name: test-skill
description: A test skill
---

# Test Skill

This is a test skill.`;

const invalidSkillMd = `---
name: INVALID-Name
description: Test
---
`;

// 测试环境设置
let testSkillsDir: string;
let testArchivedDir: string;
let manager: SkillsManagementManager;

async function setupTestEnv() {
  testSkillsDir = path.join(os.tmpdir(), `test-skills-${Date.now()}`);
  testArchivedDir = path.join(testSkillsDir, '.archived');

  await fs.mkdir(testSkillsDir, { recursive: true });
  await fs.mkdir(testArchivedDir, { recursive: true });

  manager = new SkillsManagementManager(testSkillsDir, testArchivedDir);
}

async function cleanupTestEnv() {
  await fs.rm(testSkillsDir, { recursive: true, force: true });
}

async function clearTestDirs() {
  const entries = await fs.readdir(testSkillsDir);
  for (const entry of entries) {
    if (entry === '.archived') continue;
    const fullPath = path.join(testSkillsDir, entry);
    await fs.rm(fullPath, { recursive: true, force: true });
  }

  const archivedEntries = await fs.readdir(testArchivedDir);
  for (const entry of archivedEntries) {
    const fullPath = path.join(testArchivedDir, entry);
    await fs.rm(fullPath, { recursive: true, force: true });
  }
}

// ==================== 测试用例 ====================

runner
  .test('1. listSkills - 返回空列表(无技能时)', async () => {
    await setupTestEnv();
    try {
      const skills = await manager.listSkills();
      expect.toEqual(skills.length, 0);
    } finally {
      await cleanupTestEnv();
    }
  })
  .test('1. listSkills - 正确列出在线技能', async () => {
    await setupTestEnv();
    try {
      // 创建测试技能
      const skillDir = path.join(testSkillsDir, 'test-skill');
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), validSkillMd, 'utf-8');

      // 创建archived目录中的技能(应被过滤)
      const archivedDir = path.join(testArchivedDir, 'archived-skill-a1b2c3d4');
      await fs.mkdir(archivedDir, { recursive: true });
      await fs.writeFile(path.join(archivedDir, 'SKILL.md'), validSkillMd, 'utf-8');

      const skills = await manager.listSkills();

      expect.toEqual(skills.length, 1);
      expect.toEqual(skills[0].name, 'test-skill');
      expect.toEqual(skills[0].description, 'A test skill');
    } finally {
      await cleanupTestEnv();
    }
  })
  .test('1. listSkills - 跳过无效的SKILL.md', async () => {
    await setupTestEnv();
    try {
      // 创建无效技能
      const skillDir = path.join(testSkillsDir, 'invalid-skill');
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), 'invalid content', 'utf-8');

      const skills = await manager.listSkills();
      expect.toEqual(skills.length, 0);
    } finally {
      await cleanupTestEnv();
    }
  })
  .test('2. listArchivedSkills - 返回空列表(无归档技能时)', async () => {
    await setupTestEnv();
    try {
      const skills = await manager.listArchivedSkills();
      expect.toEqual(skills.length, 0);
    } finally {
      await cleanupTestEnv();
    }
  })
  .test('2. listArchivedSkills - 正确解析归档技能名称', async () => {
    await setupTestEnv();
    try {
      // 创建归档技能
      const archivedDir = path.join(testArchivedDir, 'original-skill-a1b2c3d4');
      await fs.mkdir(archivedDir, { recursive: true });
      await fs.writeFile(path.join(archivedDir, 'SKILL.md'), validSkillMd, 'utf-8');

      const skills = await manager.listArchivedSkills();

      expect.toEqual(skills.length, 1);
      expect.toEqual(skills[0].originalName, 'original-skill');
      expect.toEqual(skills[0].archivedName, 'original-skill-a1b2c3d4');
    } finally {
      await cleanupTestEnv();
    }
  })
  .test('3. importSkill - zip文件不存在时抛出错误', async () => {
    await setupTestEnv();
    try {
      let hasError = false;
      try {
        await manager.importSkill('/nonexistent/file.zip');
      } catch (error: any) {
        hasError = true;
        expect.toContain(error.message, 'Zip文件不存在');
      }
      expect.toBeTruthy(hasError);
    } finally {
      await cleanupTestEnv();
    }
  })
  .test('4. copySkill - 成功复制技能并生成8位随机后缀', async () => {
    await setupTestEnv();
    try {
      // 创建源技能
      const sourceDir = path.join(testSkillsDir, 'source-skill');
      await fs.mkdir(sourceDir, { recursive: true });
      await fs.writeFile(path.join(sourceDir, 'SKILL.md'), validSkillMd, 'utf-8');

      // 复制技能
      const newSkillName = await manager.copySkill('source-skill');

      // 验证格式: source-skill-XXXXXXXX
      expect.toBeTruthy(newSkillName.match(/^source-skill-[a-f0-9]{8}$/));

      // 验证文件存在
      const newDir = path.join(testSkillsDir, newSkillName);
      try {
        await fs.access(newDir);
        expect.toBeTruthy(true);
      } catch {
        expect.toBeTruthy(false); // 文件不存在
      }
    } finally {
      await cleanupTestEnv();
    }
  })
  .test('4. copySkill - 技能不存在时抛出错误', async () => {
    await setupTestEnv();
    try {
      let hasError = false;
      try {
        await manager.copySkill('nonexistent-skill');
      } catch (error: any) {
        hasError = true;
        expect.toContain(error.message, '技能不存在');
      }
      expect.toBeTruthy(hasError);
    } finally {
      await cleanupTestEnv();
    }
  })
  .test('5. renameSkill - 成功重命名技能', async () => {
    await setupTestEnv();
    try {
      // 创建源技能
      const sourceDir = path.join(testSkillsDir, 'old-name');
      await fs.mkdir(sourceDir, { recursive: true });
      await fs.writeFile(path.join(sourceDir, 'SKILL.md'), validSkillMd, 'utf-8');

      // 重命名
      await manager.renameSkill('old-name', 'new-name');

      // 验证旧目录不存在
      try {
        await fs.access(sourceDir);
        expect.toBeTruthy(false); // 不应该执行到这里
      } catch {
        expect.toBeTruthy(true); // 目录不存在,符合预期
      }

      // 验证新目录存在
      const newDir = path.join(testSkillsDir, 'new-name');
      await fs.access(newDir);

      // 验证SKILL.md中的name字段已更新
      const content = await fs.readFile(path.join(newDir, 'SKILL.md'), 'utf-8');
      expect.toBeTruthy(content.match(/^name: new-name$/m));
    } finally {
      await cleanupTestEnv();
    }
  })
  .test('5. renameSkill - 技能不存在时抛出错误', async () => {
    await setupTestEnv();
    try {
      let hasError = false;
      try {
        await manager.renameSkill('nonexistent', 'new-name');
      } catch (error: any) {
        hasError = true;
        expect.toContain(error.message, '技能不存在');
      }
      expect.toBeTruthy(hasError);
    } finally {
      await cleanupTestEnv();
    }
  })
  .test('5. renameSkill - 目标名称已存在时抛出错误', async () => {
    await setupTestEnv();
    try {
      // 创建两个技能
      const dir1 = path.join(testSkillsDir, 'skill1');
      const dir2 = path.join(testSkillsDir, 'skill2');
      await fs.mkdir(dir1, { recursive: true });
      await fs.mkdir(dir2, { recursive: true });
      await fs.writeFile(path.join(dir1, 'SKILL.md'), validSkillMd, 'utf-8');
      await fs.writeFile(path.join(dir2, 'SKILL.md'), validSkillMd, 'utf-8');

      let hasError = false;
      try {
        await manager.renameSkill('skill1', 'skill2');
      } catch (error: any) {
        hasError = true;
        expect.toContain(error.message, '技能已存在');
      }
      expect.toBeTruthy(hasError);
    } finally {
      await cleanupTestEnv();
    }
  })
  .test('6. archiveSkill - 成功归档技能并生成8位随机后缀', async () => {
    await setupTestEnv();
    try {
      // 创建技能
      const skillDir = path.join(testSkillsDir, 'to-archive');
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), validSkillMd, 'utf-8');

      // 归档
      await manager.archiveSkill('to-archive');

      // 验证原目录不存在
      try {
        await fs.access(skillDir);
        expect.toBeTruthy(false); // 不应该执行到这里
      } catch {
        expect.toBeTruthy(true); // 目录不存在,符合预期
      }

      // 验证archived目录中有归档文件
      const archivedEntries = await fs.readdir(testArchivedDir);
      expect.toEqual(archivedEntries.length, 1);
      expect.toBeTruthy(archivedEntries[0].match(/^to-archive-[a-f0-9]{8}$/));
    } finally {
      await cleanupTestEnv();
    }
  })
  .test('6. archiveSkill - 技能不存在时抛出错误', async () => {
    await setupTestEnv();
    try {
      let hasError = false;
      try {
        await manager.archiveSkill('nonexistent');
      } catch (error: any) {
        hasError = true;
        expect.toContain(error.message, '技能不存在');
      }
      expect.toBeTruthy(hasError);
    } finally {
      await cleanupTestEnv();
    }
  })
  .test('7. unarchiveSkill - 成功恢复归档技能', async () => {
    await setupTestEnv();
    try {
      // 创建归档技能
      const archivedDir = path.join(testArchivedDir, 'original-name-a1b2c3d4');
      await fs.mkdir(archivedDir, { recursive: true });
      await fs.writeFile(path.join(archivedDir, 'SKILL.md'), validSkillMd, 'utf-8');

      // 恢复
      await manager.unarchiveSkill('original-name-a1b2c3d4');

      // 验证归档目录不存在
      try {
        await fs.access(archivedDir);
        expect.toBeTruthy(false); // 不应该执行到这里
      } catch {
        expect.toBeTruthy(true); // 目录不存在,符合预期
      }

      // 验证技能目录存在
      const skillDir = path.join(testSkillsDir, 'original-name');
      await fs.access(skillDir);
    } finally {
      await cleanupTestEnv();
    }
  })
  .test('7. unarchiveSkill - 归档技能不存在时抛出错误', async () => {
    await setupTestEnv();
    try {
      let hasError = false;
      try {
        await manager.unarchiveSkill('nonexistent-a1b2c3d4');
      } catch (error: any) {
        hasError = true;
        expect.toContain(error.message, '归档技能不存在');
      }
      expect.toBeTruthy(hasError);
    } finally {
      await cleanupTestEnv();
    }
  })
  .test('7. unarchiveSkill - 目标名称已存在时抛出错误', async () => {
    await setupTestEnv();
    try {
      // 创建在线技能
      const skillDir = path.join(testSkillsDir, 'conflict');
      await fs.mkdir(skillDir, { recursive: true });

      // 创建归档技能
      const archivedDir = path.join(testArchivedDir, 'conflict-a1b2c3d4');
      await fs.mkdir(archivedDir, { recursive: true });
      await fs.writeFile(path.join(archivedDir, 'SKILL.md'), validSkillMd, 'utf-8');

      let hasError = false;
      try {
        await manager.unarchiveSkill('conflict-a1b2c3d4');
      } catch (error: any) {
        hasError = true;
        expect.toContain(error.message, '技能已存在');
      }
      expect.toBeTruthy(hasError);
    } finally {
      await cleanupTestEnv();
    }
  })
  .test('8. exportSkill - 成功导出在线技能', async () => {
    await setupTestEnv();
    try {
      // 创建技能
      const skillDir = path.join(testSkillsDir, 'to-export');
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), validSkillMd, 'utf-8');

      // 导出
      const zipPath = await manager.exportSkill('to-export', false);

      // 验证zip文件路径
      expect.toBeTruthy(zipPath.match(/[/\\]to-export\.zip$/));
      await fs.access(zipPath);

      // 清理
      await fs.rm(zipPath, { force: true });
    } finally {
      await cleanupTestEnv();
    }
  })
  .test('8. exportSkill - 成功导出归档技能', async () => {
    await setupTestEnv();
    try {
      // 创建归档技能
      const archivedDir = path.join(testArchivedDir, 'archived-skill-a1b2c3d4');
      await fs.mkdir(archivedDir, { recursive: true });
      await fs.writeFile(path.join(archivedDir, 'SKILL.md'), validSkillMd, 'utf-8');

      // 导出
      const zipPath = await manager.exportSkill('archived-skill-a1b2c3d4', true);

      // 验证zip文件路径
      expect.toBeTruthy(zipPath.match(/[/\\]archived-skill-a1b2c3d4\.zip$/));
      await fs.access(zipPath);

      // 清理
      await fs.rm(zipPath, { force: true });
    } finally {
      await cleanupTestEnv();
    }
  })
  .test('8. exportSkill - 技能不存在时抛出错误', async () => {
    await setupTestEnv();
    try {
      let hasError = false;
      try {
        await manager.exportSkill('nonexistent', false);
      } catch (error: any) {
        hasError = true;
        expect.toContain(error.message, '技能不存在');
      }
      expect.toBeTruthy(hasError);
    } finally {
      await cleanupTestEnv();
    }
  })
  .test('9. getOnlineSkillContent - 成功获取在线技能内容', async () => {
    await setupTestEnv();
    try {
      // 创建技能
      const skillDir = path.join(testSkillsDir, 'test-skill');
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), validSkillMd, 'utf-8');

      // 获取内容
      const content = await manager.getOnlineSkillContent('test-skill');

      expect.toEqual(content, validSkillMd);
    } finally {
      await cleanupTestEnv();
    }
  })
  .test('9. getOnlineSkillContent - 技能不存在时抛出错误', async () => {
    await setupTestEnv();
    try {
      let hasError = false;
      try {
        await manager.getOnlineSkillContent('nonexistent');
      } catch (error: any) {
        hasError = true;
        expect.toContain(error.message, '技能不存在');
      }
      expect.toBeTruthy(hasError);
    } finally {
      await cleanupTestEnv();
    }
  })
  .test('10. getArchivedSkillContent - 成功获取归档技能内容', async () => {
    await setupTestEnv();
    try {
      // 创建归档技能
      const archivedDir = path.join(testArchivedDir, 'test-skill-a1b2c3d4');
      await fs.mkdir(archivedDir, { recursive: true });
      await fs.writeFile(path.join(archivedDir, 'SKILL.md'), validSkillMd, 'utf-8');

      // 获取内容
      const content = await manager.getArchivedSkillContent('test-skill-a1b2c3d4');

      expect.toEqual(content, validSkillMd);
    } finally {
      await cleanupTestEnv();
    }
  })
  .test('10. getArchivedSkillContent - 归档技能不存在时抛出错误', async () => {
    await setupTestEnv();
    try {
      let hasError = false;
      try {
        await manager.getArchivedSkillContent('nonexistent-a1b2c3d4');
      } catch (error: any) {
        hasError = true;
        expect.toContain(error.message, '归档技能不存在');
      }
      expect.toBeTruthy(hasError);
    } finally {
      await cleanupTestEnv();
    }
  })
  .test('11. getOnlineSkillStructure - 成功获取在线技能目录结构', async () => {
    await setupTestEnv();
    try {
      // 创建技能及其子目录
      const skillDir = path.join(testSkillsDir, 'test-skill');
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), validSkillMd, 'utf-8');

      const scriptsDir = path.join(skillDir, 'scripts');
      await fs.mkdir(scriptsDir, { recursive: true });
      await fs.writeFile(path.join(scriptsDir, 'test.sh'), 'echo test', 'utf-8');

      // 获取目录结构
      const structure = await manager.getOnlineSkillStructure('test-skill');

      expect.toEqual((structure as any).name, 'test-skill');
      expect.toEqual((structure as any).type, 'directory');
      expect.toBeTruthy((structure as any).children);
      expect.toBeTruthy((structure as any).children.length >= 2); // SKILL.md and scripts/
    } finally {
      await cleanupTestEnv();
    }
  })
  .test('11. getOnlineSkillStructure - 技能不存在时抛出错误', async () => {
    await setupTestEnv();
    try {
      let hasError = false;
      try {
        await manager.getOnlineSkillStructure('nonexistent');
      } catch (error: any) {
        hasError = true;
        expect.toContain(error.message, '技能不存在');
      }
      expect.toBeTruthy(hasError);
    } finally {
      await cleanupTestEnv();
    }
  })
  .test('12. getArchivedSkillStructure - 成功获取归档技能目录结构', async () => {
    await setupTestEnv();
    try {
      // 创建归档技能及其子目录
      const archivedDir = path.join(testArchivedDir, 'test-skill-a1b2c3d4');
      await fs.mkdir(archivedDir, { recursive: true });
      await fs.writeFile(path.join(archivedDir, 'SKILL.md'), validSkillMd, 'utf-8');

      const scriptsDir = path.join(archivedDir, 'scripts');
      await fs.mkdir(scriptsDir, { recursive: true });
      await fs.writeFile(path.join(scriptsDir, 'test.sh'), 'echo test', 'utf-8');

      // 获取目录结构
      const structure = await manager.getArchivedSkillStructure('test-skill-a1b2c3d4');

      expect.toEqual((structure as any).name, 'test-skill-a1b2c3d4');
      expect.toEqual((structure as any).type, 'directory');
      expect.toBeTruthy((structure as any).children);
      expect.toBeTruthy((structure as any).children.length >= 2); // SKILL.md and scripts/
    } finally {
      await cleanupTestEnv();
    }
  })
  .test('12. getArchivedSkillStructure - 归档技能不存在时抛出错误', async () => {
    await setupTestEnv();
    try {
      let hasError = false;
      try {
        await manager.getArchivedSkillStructure('nonexistent-a1b2c3d4');
      } catch (error: any) {
        hasError = true;
        expect.toContain(error.message, '归档技能不存在');
      }
      expect.toBeTruthy(hasError);
    } finally {
      await cleanupTestEnv();
    }
  })
  .test('2. installSkill - 空来源时抛出错误', async () => {
    await setupTestEnv();
    try {
      let hasError = false;
      try {
        await manager.installSkill('');
      } catch (error: any) {
        hasError = true;
        expect.toContain(error.message, '技能来源不能为空');
      }
      expect.toBeTruthy(hasError);
    } finally {
      await cleanupTestEnv();
    }
  })
  .test('2. installSkill - 只包含空格时抛出错误', async () => {
    await setupTestEnv();
    try {
      let hasError = false;
      try {
        await manager.installSkill('   ');
      } catch (error: any) {
        hasError = true;
        expect.toContain(error.message, '技能来源不能为空');
      }
      expect.toBeTruthy(hasError);
    } finally {
      await cleanupTestEnv();
    }
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
