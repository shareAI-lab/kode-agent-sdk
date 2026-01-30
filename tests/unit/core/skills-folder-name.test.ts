/**
 * Skills Manager 文件夹名称测试
 *
 * 测试SkillsManager使用文件夹名称作为技能标识符
 */

import { TestRunner, expect } from '../../helpers/utils';
import { SkillsManager } from '../../../src/core/skills/manager';
import * as fs from 'fs/promises';
import * as path from 'path';

const runner = new TestRunner('SkillsManager - 文件夹名称作为标识符');

async function createTestSkill(baseDir: string, folderName: string, yamlName: string, description: string) {
  const skillDir = path.join(baseDir, folderName);
  await fs.mkdir(skillDir, { recursive: true });

  const skillContent = `---
name: ${yamlName}
description: ${description}
---

# Test Skill

This skill tests folder name as identifier.
`;
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), skillContent);
  return skillDir;
}

runner
  .test('应该使用文件夹名称作为技能标识符，而非YAML中的name字段', async () => {
    // 创建临时测试目录
    const testDir = path.join(process.cwd(), 'test-skills-' + Date.now());
    await fs.mkdir(testDir, { recursive: true });
    const manager = new SkillsManager(testDir);

    try {
      // 创建测试skill：文件夹名称与YAML中的name不同
      await createTestSkill(testDir, 'folder-name-skill', 'yaml-name-skill', 'Test skill with different folder name');

      // 扫描skills
      const skills = await manager.getSkillsMetadata();

      expect.toEqual(skills.length, 1);
      // 关键验证：使用文件夹名称，而非YAML中的name
      expect.toEqual(skills[0].name, 'folder-name-skill');
      // 验证不等于YAML中的name
      if (skills[0].name === 'yaml-name-skill') {
        throw new Error('Expected folder name, not YAML name');
      }
      expect.toEqual(skills[0].description, 'Test skill with different folder name');
    } finally {
      await fs.rm(testDir, { recursive: true, force: true });
    }
  })

  .test('应该在列表中显示文件夹名称', async () => {
    const testDir = path.join(process.cwd(), 'test-skills-' + Date.now());
    await fs.mkdir(testDir, { recursive: true });
    const manager = new SkillsManager(testDir);

    try {
      // 创建多个skill
      await createTestSkill(testDir, 'skill-a', 'different-name-a', 'Skill A');
      await createTestSkill(testDir, 'skill-b', 'different-name-b', 'Skill B');

      // 扫描skills
      const skills = await manager.getSkillsMetadata();

      expect.toEqual(skills.length, 2);
      // 验证返回的名称是文件夹名称
      const skillNames = skills.map(s => s.name).sort();
      expect.toEqual(skillNames[0], 'skill-a');
      expect.toEqual(skillNames[1], 'skill-b');
    } finally {
      await fs.rm(testDir, { recursive: true, force: true });
    }
  })

  .test('应该使用文件夹名称加载技能内容', async () => {
    const testDir = path.join(process.cwd(), 'test-skills-' + Date.now());
    await fs.mkdir(testDir, { recursive: true });
    const manager = new SkillsManager(testDir);

    try {
      // 创建测试skill
      await createTestSkill(testDir, 'load-test-skill', 'yaml-load-name', 'Test loading with folder name');

      // 使用文件夹名称加载
      const content = await manager.loadSkillContent('load-test-skill');

      expect.toBeTruthy(content);
      expect.toEqual(content!.metadata.name, 'load-test-skill');
      // 验证不等于YAML中的name
      if (content!.metadata.name === 'yaml-load-name') {
        throw new Error('Expected folder name, not YAML name');
      }
    } finally {
      await fs.rm(testDir, { recursive: true, force: true });
    }
  })

  .test('应该返回null当使用YAML中的name加载（非文件夹名）', async () => {
    const testDir = path.join(process.cwd(), 'test-skills-' + Date.now());
    await fs.mkdir(testDir, { recursive: true });
    const manager = new SkillsManager(testDir);

    try {
      // 创建测试skill
      await createTestSkill(testDir, 'correct-folder-name', 'wrong-yaml-name', 'Test skill');

      // 使用YAML中的name（错误的方式）应该返回null
      const content1 = await manager.loadSkillContent('wrong-yaml-name');
      expect.toEqual(content1, null);

      // 使用文件夹名称（正确的方式）应该成功
      const content2 = await manager.loadSkillContent('correct-folder-name');
      expect.toBeTruthy(content2);
    } finally {
      await fs.rm(testDir, { recursive: true, force: true });
    }
  })

  .test('白名单应该匹配文件夹名称', async () => {
    const testDir = path.join(process.cwd(), 'test-skills-' + Date.now());
    await fs.mkdir(testDir, { recursive: true });

    try {
      // 创建两个skill
      await createTestSkill(testDir, 'allowed-skill', 'yaml-allowed', 'Allowed skill');
      await createTestSkill(testDir, 'blocked-skill', 'yaml-blocked', 'Blocked skill');

      // 创建只允许 'allowed-skill' 的manager
      const managerWithWhitelist = new SkillsManager(testDir, ['allowed-skill']);
      const skills = await managerWithWhitelist.getSkillsMetadata();

      expect.toEqual(skills.length, 1);
      expect.toEqual(skills[0].name, 'allowed-skill');

      // 验证可以加载白名单中的skill
      const content = await managerWithWhitelist.loadSkillContent('allowed-skill');
      expect.toBeTruthy(content);

      // 验证不能加载非白名单中的skill
      const blockedContent = await managerWithWhitelist.loadSkillContent('blocked-skill');
      expect.toEqual(blockedContent, null);
    } finally {
      await fs.rm(testDir, { recursive: true, force: true });
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
