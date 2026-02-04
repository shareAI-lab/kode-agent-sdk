/**
 * SkillsManagementManager Archived 功能单元测试
 *
 * 测试目标：
 * - 验证归档目录默认为 .archived（隐藏目录）
 * - 验证支持自定义归档目录
 * - 验证 listSkills 排除 .archived 目录中的技能
 * - 验证 listArchivedSkills 正确获取归档技能
 * - 验证 archiveSkill 将技能移动到 .archived
 * - 验证 unarchiveSkill 从 .archived 恢复技能
 * - 验证归档技能的内容和结构查询
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { TestRunner, expect } from '../../../helpers/utils';
import { SkillsManagementManager } from '../../../../src/core/skills/management-manager';

const runner = new TestRunner('SkillsManagementManager - Archived 功能');

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

runner
  .test('应该使用默认的 .archived 归档目录', async () => {
    const testRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-test-'));
    const skillsDir = path.join(testRootDir, 'skills');
    await fs.mkdir(skillsDir, { recursive: true });

    try {
      const manager = new SkillsManagementManager(skillsDir);

      await createTestSkill(skillsDir, 'test-skill', { description: 'Test skill' });
      await manager.archiveSkill('test-skill');

      // 验证 .archived 目录存在
      const archivedDir = path.join(skillsDir, '.archived');
      const exists = await fs.access(archivedDir).then(() => true).catch(() => false);
      expect.toBeTruthy(exists);
    } finally {
      await fs.rm(testRootDir, { recursive: true, force: true }).catch(() => {});
    }
  })

  .test('应该支持自定义归档目录', async () => {
    const testRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-test-'));
    const skillsDir = path.join(testRootDir, 'skills');
    await fs.mkdir(skillsDir, { recursive: true });

    try {
      const customArchivedDir = path.join(testRootDir, 'custom-archived');
      const customManager = new SkillsManagementManager(skillsDir, customArchivedDir);

      await createTestSkill(skillsDir, 'test-skill', { description: 'Test skill' });
      await customManager.archiveSkill('test-skill');

      // 验证自定义归档目录存在
      const exists = await fs.access(customArchivedDir).then(() => true).catch(() => false);
      expect.toBeTruthy(exists);

      // 验证默认的 .archived 目录不存在
      const defaultArchivedDir = path.join(skillsDir, '.archived');
      const defaultExists = await fs.access(defaultArchivedDir).then(() => true).catch(() => false);
      expect.toBeFalsy(defaultExists);
    } finally {
      await fs.rm(testRootDir, { recursive: true, force: true }).catch(() => {});
    }
  })

  .test('应该只返回在线技能，不包含 .archived 中的技能', async () => {
    const testRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-test-'));
    const skillsDir = path.join(testRootDir, 'skills');
    await fs.mkdir(skillsDir, { recursive: true });

    try {
      const manager = new SkillsManagementManager(skillsDir);

      await createTestSkill(skillsDir, 'online-skill', { description: 'Online skill' });
      await createTestSkill(skillsDir, 'archived-skill', { description: 'Archived skill' });

      await manager.archiveSkill('archived-skill');

      const onlineSkills = await manager.listSkills();

      expect.toEqual(onlineSkills.length, 1);
      expect.toEqual(onlineSkills[0].name, 'online-skill');
      expect.toBeFalsy(onlineSkills[0].baseDir.includes('.archived'));
    } finally {
      await fs.rm(testRootDir, { recursive: true, force: true }).catch(() => {});
    }
  })

  .test('应该返回 .archived 目录中的所有技能', async () => {
    const testRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-test-'));
    const skillsDir = path.join(testRootDir, 'skills');
    await fs.mkdir(skillsDir, { recursive: true });

    try {
      const manager = new SkillsManagementManager(skillsDir);

      await createTestSkill(skillsDir, 'skill1', { description: 'Skill 1' });
      await createTestSkill(skillsDir, 'skill2', { description: 'Skill 2' });

      await manager.archiveSkill('skill1');
      await manager.archiveSkill('skill2');

      const archivedSkills = await manager.listArchivedSkills();

      expect.toEqual(archivedSkills.length, 2);
      const names = archivedSkills.map(s => s.originalName).sort();
      expect.toEqual(names.join(','), 'skill1,skill2');
    } finally {
      await fs.rm(testRootDir, { recursive: true, force: true }).catch(() => {});
    }
  })

  .test('应该将技能移动到 .archived 目录并添加随机后缀', async () => {
    const testRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-test-'));
    const skillsDir = path.join(testRootDir, 'skills');
    await fs.mkdir(skillsDir, { recursive: true });

    try {
      const manager = new SkillsManagementManager(skillsDir);

      await createTestSkill(skillsDir, 'test-skill', { description: 'Test' });
      await manager.archiveSkill('test-skill');

      // 验证技能不再在线列表中
      const onlineSkills = await manager.listSkills();
      expect.toBeFalsy(onlineSkills.find(s => s.name === 'test-skill'));

      // 验证技能在归档列表中
      const archivedSkills = await manager.listArchivedSkills();
      expect.toBeTruthy(archivedSkills.find(s => s.originalName === 'test-skill'));

      // 验证归档目录结构（名称格式：{原名称}-{8位随机后缀}）
      const archivedDir = path.join(skillsDir, '.archived');
      const entries = await fs.readdir(archivedDir);
      expect.toEqual(entries.length, 1);
      expect.toBeTruthy(entries[0].startsWith('test-skill-'));
      expect.toEqual(entries[0].length, 'test-skill-'.length + 8);
    } finally {
      await fs.rm(testRootDir, { recursive: true, force: true }).catch(() => {});
    }
  })

  .test('应该将技能从 .archived 移回 skills 目录', async () => {
    const testRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-test-'));
    const skillsDir = path.join(testRootDir, 'skills');
    await fs.mkdir(skillsDir, { recursive: true });

    try {
      const manager = new SkillsManagementManager(skillsDir);

      await createTestSkill(skillsDir, 'test-skill', { description: 'Test' });
      await manager.archiveSkill('test-skill');

      const archivedSkills = await manager.listArchivedSkills();
      expect.toEqual(archivedSkills.length, 1);

      await manager.unarchiveSkill(archivedSkills[0].archivedName);

      // 验证技能回到在线列表
      const onlineSkills = await manager.listSkills();
      expect.toBeTruthy(onlineSkills.find(s => s.name === 'test-skill'));

      // 验证技能不再在归档列表中
      const newArchivedSkills = await manager.listArchivedSkills();
      expect.toBeFalsy(newArchivedSkills.find(s => s.originalName === 'test-skill'));
    } finally {
      await fs.rm(testRootDir, { recursive: true, force: true }).catch(() => {});
    }
  })

  .test('恢复时如果目标技能已存在应该抛出错误', async () => {
    const testRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-test-'));
    const skillsDir = path.join(testRootDir, 'skills');
    await fs.mkdir(skillsDir, { recursive: true });

    try {
      const manager = new SkillsManagementManager(skillsDir);

      await createTestSkill(skillsDir, 'skill1', { description: 'Skill 1' });
      await manager.archiveSkill('skill1');

      // 重新创建同名技能
      await createTestSkill(skillsDir, 'skill1', { description: 'Skill 1 again' });

      const archivedSkills = await manager.listArchivedSkills();
      let errorThrown = false;
      try {
        await manager.unarchiveSkill(archivedSkills[0].archivedName);
      } catch (error: any) {
        errorThrown = true;
        expect.toBeTruthy(error.message.includes('已存在'));
      }
      expect.toBeTruthy(errorThrown);
    } finally {
      await fs.rm(testRootDir, { recursive: true, force: true }).catch(() => {});
    }
  })

  .test('.archived 目录不存在时应该返回空数组', async () => {
    const testRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-test-'));
    const skillsDir = path.join(testRootDir, 'skills');
    await fs.mkdir(skillsDir, { recursive: true });

    try {
      const manager = new SkillsManagementManager(skillsDir);

      const archivedSkills = await manager.listArchivedSkills();

      expect.toEqual(archivedSkills.length, 0);
    } finally {
      await fs.rm(testRootDir, { recursive: true, force: true }).catch(() => {});
    }
  })

  .test('应该能获取归档技能的内容', async () => {
    const testRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-test-'));
    const skillsDir = path.join(testRootDir, 'skills');
    await fs.mkdir(skillsDir, { recursive: true });

    try {
      const manager = new SkillsManagementManager(skillsDir);

      await createTestSkill(skillsDir, 'content-skill', { description: 'Content test' });
      await manager.archiveSkill('content-skill');

      const archivedSkills = await manager.listArchivedSkills();
      const content = await manager.getArchivedSkillContent(archivedSkills[0].archivedName);

      expect.toContain(content, 'name: content-skill');
      expect.toContain(content, 'description: Content test');
    } finally {
      await fs.rm(testRootDir, { recursive: true, force: true }).catch(() => {});
    }
  })

  .test('应该能获取归档技能的目录结构', async () => {
    const testRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-test-'));
    const skillsDir = path.join(testRootDir, 'skills');
    await fs.mkdir(skillsDir, { recursive: true });

    try {
      const manager = new SkillsManagementManager(skillsDir);

      await createTestSkill(skillsDir, 'structure-skill', { description: 'Structure test' });
      await manager.archiveSkill('structure-skill');

      const archivedSkills = await manager.listArchivedSkills();
      const structure = await manager.getArchivedSkillStructure(archivedSkills[0].archivedName) as any;

      expect.toEqual(structure.type, 'directory');
      expect.toBeTruthy(structure.children);
      expect.toBeTruthy(Array.isArray(structure.children));

      const names = structure.children.map((c: any) => c.name);
      expect.toContain(names, 'SKILL.md');
      expect.toContain(names, 'references');
      expect.toContain(names, 'scripts');
      expect.toContain(names, 'assets');
    } finally {
      await fs.rm(testRootDir, { recursive: true, force: true }).catch(() => {});
    }
  })

  .test('手动创建的归档技能应能被正确解析', async () => {
    const testRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-test-'));
    const skillsDir = path.join(testRootDir, 'skills');
    await fs.mkdir(skillsDir, { recursive: true });

    try {
      const manager = new SkillsManagementManager(skillsDir);

      // 手动创建归档目录和技能
      const archivedDir = path.join(skillsDir, '.archived');
      await fs.mkdir(archivedDir, { recursive: true });

      const skillDir = path.join(archivedDir, 'manual-skill-abcd1234');
      await fs.mkdir(skillDir, { recursive: true });

      const skillMdContent = `---
name: manual-skill
description: Manually created archived skill
---

# Manual Skill
`;
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), skillMdContent);

      const archivedSkills = await manager.listArchivedSkills();

      expect.toEqual(archivedSkills.length, 1);
      expect.toEqual(archivedSkills[0].originalName, 'manual-skill');
      expect.toEqual(archivedSkills[0].archivedName, 'manual-skill-abcd1234');
    } finally {
      await fs.rm(testRootDir, { recursive: true, force: true }).catch(() => {});
    }
  })

  .test('手动创建的归档技能应能被恢复', async () => {
    const testRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-test-'));
    const skillsDir = path.join(testRootDir, 'skills');
    await fs.mkdir(skillsDir, { recursive: true });

    try {
      const manager = new SkillsManagementManager(skillsDir);

      // 手动创建归档目录和技能
      const archivedDir = path.join(skillsDir, '.archived');
      await fs.mkdir(archivedDir, { recursive: true });

      const skillDir = path.join(archivedDir, 'restore-skill-12345678');
      await fs.mkdir(skillDir, { recursive: true });

      const skillMdContent = `---
name: restore-skill
description: Skill to restore
---

# Restore Skill
`;
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), skillMdContent);

      // 恢复技能
      await manager.unarchiveSkill('restore-skill-12345678');

      // 验证技能恢复成功
      const onlineSkills = await manager.listSkills();
      expect.toBeTruthy(onlineSkills.find(s => s.name === 'restore-skill'));
    } finally {
      await fs.rm(testRootDir, { recursive: true, force: true }).catch(() => {});
    }
  })

  .test('导出归档技能应能正常工作', async () => {
    const testRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-test-'));
    const skillsDir = path.join(testRootDir, 'skills');
    await fs.mkdir(skillsDir, { recursive: true });

    try {
      const manager = new SkillsManagementManager(skillsDir);

      await createTestSkill(skillsDir, 'export-skill', { description: 'Export test' });
      await manager.archiveSkill('export-skill');

      const archivedSkills = await manager.listArchivedSkills();
      const zipPath = await manager.exportSkill(archivedSkills[0].archivedName, true);

      // 验证 zip 文件已创建
      const exists = await fs.access(zipPath).then(() => true).catch(() => false);
      expect.toBeTruthy(exists);

      // 清理 zip 文件
      await fs.rm(zipPath, { force: true });
    } finally {
      await fs.rm(testRootDir, { recursive: true, force: true }).catch(() => {});
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
