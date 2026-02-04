/**
 * SkillsManagementManager 单元测试
 *
 * 测试新 API：
 * - listSkills() - 列出在线技能
 * - listArchivedSkills() - 列出归档技能
 * - copySkill() - 复制技能
 * - renameSkill() - 重命名技能
 * - archiveSkill() - 归档技能
 * - unarchiveSkill() - 恢复归档技能
 * - getOnlineSkillContent() - 获取技能内容
 * - getOnlineSkillStructure() - 获取技能目录结构
 * - exportSkill() - 导出技能
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { SkillsManagementManager } from '../../../../src/core/skills/management-manager';
import { TestRunner, expect } from '../../../helpers/utils';
import { TEST_ROOT } from '../../../helpers/fixtures';

const runner = new TestRunner('SkillsManagementManager');

let testSkillsDir: string;
let manager: SkillsManagementManager;

/**
 * 手动创建技能（模拟导入后的结果）
 */
async function createTestSkill(
  skillsDir: string,
  skillName: string,
  options: { description?: string } = {}
): Promise<void> {
  const skillDir = path.join(skillsDir, skillName);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.mkdir(path.join(skillDir, 'references'), { recursive: true });
  await fs.mkdir(path.join(skillDir, 'scripts'), { recursive: true });
  await fs.mkdir(path.join(skillDir, 'assets'), { recursive: true });

  const skillMdContent = `---
name: ${skillName}
description: ${options.description || 'Test skill'}
---

# ${skillName}

This is a test skill.
`;
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), skillMdContent);
}

runner.beforeAll(async () => {
  testSkillsDir = path.join(TEST_ROOT, 'skills-management');
  await fs.mkdir(testSkillsDir, { recursive: true });
  // 新 API：构造函数只接受 skillsDir 和可选的 archivedDir
  manager = new SkillsManagementManager(testSkillsDir);
});

runner.afterAll(async () => {
  await fs.rm(testSkillsDir, { recursive: true, force: true });
});

runner.beforeEach(async () => {
  await fs.rm(testSkillsDir, { recursive: true, force: true });
  await fs.mkdir(testSkillsDir, { recursive: true });
  // 重新创建 manager 实例
  manager = new SkillsManagementManager(testSkillsDir);
});

runner
  .test('列出在线技能', async () => {
    // 手动创建多个技能
    await createTestSkill(testSkillsDir, 'skill1', { description: 'First skill' });
    await createTestSkill(testSkillsDir, 'skill2', { description: 'Second skill' });

    const skills = await manager.listSkills();

    expect.toEqual(skills.length, 2);
    const names = skills.map(s => s.name).sort();
    expect.toEqual(names[0], 'skill1');
    expect.toEqual(names[1], 'skill2');
  })

  .test('列出技能时排除 .archived 目录', async () => {
    await createTestSkill(testSkillsDir, 'online-skill', { description: 'Online' });

    // 手动创建 .archived 目录中的技能
    const archivedDir = path.join(testSkillsDir, '.archived');
    await fs.mkdir(archivedDir, { recursive: true });
    await createTestSkill(archivedDir, 'archived-skill-12345678', { description: 'Archived' });

    const skills = await manager.listSkills();

    expect.toEqual(skills.length, 1);
    expect.toEqual(skills[0].name, 'online-skill');
  })

  .test('复制技能', async () => {
    await createTestSkill(testSkillsDir, 'original-skill', { description: 'Original' });

    const newSkillName = await manager.copySkill('original-skill');

    // 验证新技能名称格式：{原名称}-{8位随机后缀}
    expect.toBeTruthy(newSkillName.startsWith('original-skill-'));
    expect.toEqual(newSkillName.length, 'original-skill-'.length + 8);

    // 验证两个技能都存在
    const skills = await manager.listSkills();
    expect.toEqual(skills.length, 2);
  })

  .test('复制不存在的技能应抛出错误', async () => {
    let errorThrown = false;
    try {
      await manager.copySkill('non-existent-skill');
    } catch (error: any) {
      errorThrown = true;
      expect.toContain(error.message, '不存在');
    }
    expect.toBeTruthy(errorThrown, 'Should throw error for non-existent skill');
  })

  .test('重命名技能', async () => {
    await createTestSkill(testSkillsDir, 'old-name', { description: 'Will be renamed' });

    await manager.renameSkill('old-name', 'new-name');

    const skills = await manager.listSkills();
    expect.toEqual(skills.length, 1);
    expect.toEqual(skills[0].folderName, 'new-name');

    // 验证旧目录不存在
    const oldExists = await fs.access(path.join(testSkillsDir, 'old-name')).then(() => true).catch(() => false);
    expect.toBeFalsy(oldExists);

    // 验证新目录存在
    const newExists = await fs.access(path.join(testSkillsDir, 'new-name')).then(() => true).catch(() => false);
    expect.toBeTruthy(newExists);
  })

  .test('重命名为无效名称应抛出错误', async () => {
    await createTestSkill(testSkillsDir, 'valid-skill', { description: 'Test' });

    const invalidNames = [
      'Invalid Name',   // 包含空格和大写
      'invalid/name',   // 包含斜杠
      '-start-dash',    // 以连字符开头
      'end-dash-',      // 以连字符结尾
    ];

    for (const invalidName of invalidNames) {
      let errorThrown = false;
      try {
        await manager.renameSkill('valid-skill', invalidName);
      } catch (error: any) {
        errorThrown = true;
      }
      expect.toBeTruthy(errorThrown, `Should reject invalid name: ${invalidName}`);
    }
  })

  .test('重命名为已存在的名称应抛出错误', async () => {
    await createTestSkill(testSkillsDir, 'skill-a', { description: 'A' });
    await createTestSkill(testSkillsDir, 'skill-b', { description: 'B' });

    let errorThrown = false;
    try {
      await manager.renameSkill('skill-a', 'skill-b');
    } catch (error: any) {
      errorThrown = true;
      expect.toContain(error.message, '已存在');
    }
    expect.toBeTruthy(errorThrown, 'Should reject duplicate name');
  })

  .test('归档技能', async () => {
    await createTestSkill(testSkillsDir, 'to-archive', { description: 'Will be archived' });

    await manager.archiveSkill('to-archive');

    // 验证技能不在在线列表中
    const onlineSkills = await manager.listSkills();
    expect.toEqual(onlineSkills.length, 0);

    // 验证技能在归档列表中
    const archivedSkills = await manager.listArchivedSkills();
    expect.toEqual(archivedSkills.length, 1);
    expect.toEqual(archivedSkills[0].originalName, 'to-archive');

    // 验证归档目录存在
    const archivedDir = path.join(testSkillsDir, '.archived');
    const exists = await fs.access(archivedDir).then(() => true).catch(() => false);
    expect.toBeTruthy(exists);
  })

  .test('恢复归档技能', async () => {
    await createTestSkill(testSkillsDir, 'to-restore', { description: 'Will be restored' });
    await manager.archiveSkill('to-restore');

    // 获取归档技能名称
    const archivedSkills = await manager.listArchivedSkills();
    expect.toEqual(archivedSkills.length, 1);
    const archivedName = archivedSkills[0].archivedName;

    // 恢复技能
    await manager.unarchiveSkill(archivedName);

    // 验证技能回到在线列表
    const onlineSkills = await manager.listSkills();
    expect.toEqual(onlineSkills.length, 1);
    expect.toEqual(onlineSkills[0].folderName, 'to-restore');

    // 验证归档列表为空
    const newArchivedSkills = await manager.listArchivedSkills();
    expect.toEqual(newArchivedSkills.length, 0);
  })

  .test('恢复时目标已存在应抛出错误', async () => {
    await createTestSkill(testSkillsDir, 'conflict-skill', { description: 'Original' });
    await manager.archiveSkill('conflict-skill');

    // 重新创建同名技能
    await createTestSkill(testSkillsDir, 'conflict-skill', { description: 'New' });

    // 获取归档技能名称
    const archivedSkills = await manager.listArchivedSkills();
    const archivedName = archivedSkills[0].archivedName;

    // 尝试恢复（应该失败）
    let errorThrown = false;
    try {
      await manager.unarchiveSkill(archivedName);
    } catch (error: any) {
      errorThrown = true;
      expect.toContain(error.message, '已存在');
    }
    expect.toBeTruthy(errorThrown, 'Should reject restore when target exists');
  })

  .test('获取在线技能内容', async () => {
    await createTestSkill(testSkillsDir, 'content-skill', { description: 'Content test' });

    const content = await manager.getOnlineSkillContent('content-skill');

    expect.toContain(content, 'name: content-skill');
    expect.toContain(content, 'description: Content test');
    expect.toContain(content, '# content-skill');
  })

  .test('获取不存在技能的内容应抛出错误', async () => {
    let errorThrown = false;
    try {
      await manager.getOnlineSkillContent('non-existent');
    } catch (error: any) {
      errorThrown = true;
      expect.toContain(error.message, '不存在');
    }
    expect.toBeTruthy(errorThrown, 'Should throw for non-existent skill');
  })

  .test('获取在线技能目录结构', async () => {
    await createTestSkill(testSkillsDir, 'structure-skill', { description: 'Structure test' });

    // 添加额外文件
    const skillDir = path.join(testSkillsDir, 'structure-skill');
    await fs.writeFile(path.join(skillDir, 'test.txt'), 'test content');
    await fs.writeFile(path.join(skillDir, 'references', 'ref1.md'), '# Reference');

    const structure = await manager.getOnlineSkillStructure('structure-skill') as any;

    expect.toEqual(structure.name, 'structure-skill');
    expect.toEqual(structure.type, 'directory');
    expect.toBeTruthy(structure.children);
    expect.toBeTruthy(Array.isArray(structure.children));

    // 验证包含预期的文件和目录
    const names = structure.children.map((c: any) => c.name);
    expect.toContain(names, 'SKILL.md');
    expect.toContain(names, 'test.txt');
    expect.toContain(names, 'references');
    expect.toContain(names, 'scripts');
    expect.toContain(names, 'assets');
  })

  .test('列出归档技能', async () => {
    await createTestSkill(testSkillsDir, 'archive1', { description: 'Archive 1' });
    await createTestSkill(testSkillsDir, 'archive2', { description: 'Archive 2' });

    await manager.archiveSkill('archive1');
    await new Promise(resolve => setTimeout(resolve, 10)); // 确保时间戳不同
    await manager.archiveSkill('archive2');

    const archivedSkills = await manager.listArchivedSkills();

    expect.toEqual(archivedSkills.length, 2);

    // 验证字段存在
    expect.toBeTruthy(archivedSkills[0].originalName);
    expect.toBeTruthy(archivedSkills[0].archivedName);
    expect.toBeTruthy(archivedSkills[0].archivedPath);
    expect.toBeTruthy(archivedSkills[0].archivedAt);
  })

  .test('.archived 目录不存在时返回空数组', async () => {
    const archivedSkills = await manager.listArchivedSkills();
    expect.toEqual(archivedSkills.length, 0);
  })

  .test('自定义归档目录', async () => {
    const customArchivedDir = path.join(TEST_ROOT, 'custom-archived');
    await fs.mkdir(customArchivedDir, { recursive: true });

    try {
      const customManager = new SkillsManagementManager(testSkillsDir, customArchivedDir);

      await createTestSkill(testSkillsDir, 'custom-archive-skill', { description: 'Custom' });
      await customManager.archiveSkill('custom-archive-skill');

      // 验证技能在自定义归档目录中
      const entries = await fs.readdir(customArchivedDir);
      expect.toBeTruthy(entries.length > 0);
      expect.toBeTruthy(entries[0].startsWith('custom-archive-skill-'));

      // 验证默认 .archived 目录不存在
      const defaultArchived = path.join(testSkillsDir, '.archived');
      const defaultExists = await fs.access(defaultArchived).then(() => true).catch(() => false);
      expect.toBeFalsy(defaultExists);
    } finally {
      await fs.rm(customArchivedDir, { recursive: true, force: true });
    }
  });

export async function run() {
  return runner.run();
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
