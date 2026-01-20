/**
 * SkillsManagementManager 单元测试
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { SkillsManagementManager } from '../../../../src/core/skills/management-manager';
import { SandboxFactory } from '../../../../src/infra/sandbox-factory';
import { TestRunner, expect } from '../../../helpers/utils';
import { TEST_ROOT } from '../../../helpers/fixtures';

const runner = new TestRunner('SkillsManagementManager');

let testSkillsDir: string;
let manager: SkillsManagementManager;

runner.beforeAll(async () => {
  // 创建临时skills目录
  testSkillsDir = path.join(TEST_ROOT, 'skills-management');
  await fs.mkdir(testSkillsDir, { recursive: true });

  // 创建SkillsManagementManager实例
  manager = new SkillsManagementManager(testSkillsDir, new SandboxFactory());
});

runner.afterAll(async () => {
  // 清理测试目录
  await fs.rm(testSkillsDir, { recursive: true, force: true });
});

runner.beforeEach(async () => {
  // 每个测试前清理测试目录
  await fs.rm(testSkillsDir, { recursive: true, force: true });
  await fs.mkdir(testSkillsDir, { recursive: true });
});

runner
  .test('创建新技能', async () => {
    const skillName = 'test-skill';
    const options = {
      name: skillName,
      description: 'A test skill',
    };

    // 创建技能
    const skillDetail = await manager.createSkill(skillName, options);

    // 验证技能已创建
    expect.toEqual(skillDetail.name, skillName);
    expect.toEqual(skillDetail.description, 'A test skill');
    expect.toBeTruthy(skillDetail.baseDir);

    // 验证目录结构
    const skillDir = path.join(testSkillsDir, skillName);
    const skillMdPath = path.join(skillDir, 'SKILL.md');
    const referencesDir = path.join(skillDir, 'references');
    const scriptsDir = path.join(skillDir, 'scripts');
    const assetsDir = path.join(skillDir, 'assets');

    expect.toBeTruthy(await fs.access(skillMdPath).then(() => true).catch(() => false));
    expect.toBeTruthy(await fs.access(referencesDir).then(() => true).catch(() => false));
    expect.toBeTruthy(await fs.access(scriptsDir).then(() => true).catch(() => false));
    expect.toBeTruthy(await fs.access(assetsDir).then(() => true).catch(() => false));

    // 验证SKILL.md内容
    const content = await fs.readFile(skillMdPath, 'utf-8');
    expect.toContain(content, `name: ${skillName}`);
    expect.toContain(content, 'A test skill');
  })

  .test('拒绝创建无效名称的技能', async () => {
    const invalidNames = [
      'invalid name', // 包含空格
      'invalid/name', // 包含斜杠
      '../escape', // 路径穿越
      '.hidden', // 以点开头
      'a'.repeat(51), // 超过50字符
    ];

    for (const invalidName of invalidNames) {
      let errorThrown = false;
      try {
        await manager.createSkill(invalidName, { name: invalidName });
      } catch (error: any) {
        errorThrown = true;
        expect.toContain(error.message.toLowerCase(), 'invalid');
      }
      expect.toBeTruthy(errorThrown, `Should reject invalid name: ${invalidName}`);
    }
  })

  .test('拒绝创建已存在的技能', async () => {
    const skillName = 'existing-skill';

    // 创建技能
    await manager.createSkill(skillName, { name: skillName });

    // 尝试再次创建同名技能
    let errorThrown = false;
    try {
      await manager.createSkill(skillName, { name: skillName });
    } catch (error: any) {
      errorThrown = true;
      expect.toContain(error.message.toLowerCase(), 'already exists');
    }

    expect.toBeTruthy(errorThrown, 'Should reject duplicate skill name');
  })

  .test('列出在线技能', async () => {
    // 创建多个技能
    await manager.createSkill('skill1', { name: 'skill1', description: 'First skill' });
    await manager.createSkill('skill2', { name: 'skill2', description: 'Second skill' });

    // 列出技能
    const skills = await manager.listSkills();

    expect.toEqual(skills.length, 2);
    expect.toEqual(skills[0].name, 'skill1');
    expect.toEqual(skills[1].name, 'skill2');
  })

  .test('获取技能详细信息', async () => {
    const skillName = 'detail-skill';
    await manager.createSkill(skillName, { name: skillName, description: 'Test detail' });

    // 获取详细信息
    const detail = await manager.getSkillInfo(skillName);

    expect.toBeTruthy(detail);
    expect.toEqual(detail!.name, skillName);
    expect.toEqual(detail!.description, 'Test detail');
    expect.toBeTruthy(detail!.files);
    expect.toBeTruthy(detail!.references);
    expect.toBeTruthy(detail!.scripts);
    expect.toBeTruthy(detail!.assets);
  })

  .test('重命名技能', async () => {
    const oldName = 'old-skill';
    const newName = 'new-skill';

    await manager.createSkill(oldName, { name: oldName, description: 'Will be renamed' });

    // 重命名
    await manager.renameSkill(oldName, newName);

    // 验证旧技能不存在（返回null）
    const oldSkill = await manager.getSkillInfo(oldName);
    expect.toBeFalsy(oldSkill, 'Old skill should not exist');

    // 验证新技能存在
    const newSkill = await manager.getSkillInfo(newName);
    expect.toBeTruthy(newSkill);
    expect.toEqual(newSkill!.name, newName);

    // 验证SKILL.md中的name已更新
    const skillMdPath = path.join(testSkillsDir, newName, 'SKILL.md');
    const content = await fs.readFile(skillMdPath, 'utf-8');
    expect.toContain(content, `name: ${newName}`);
  })

  .test('编辑技能文件', async () => {
    const skillName = 'edit-skill';
    await manager.createSkill(skillName, { name: skillName });

    const newContent = `---
name: ${skillName}
description: Updated description
---

# Updated Content

This is the updated content of SKILL.md.
`;

    // 编辑SKILL.md
    await manager.editSkillFile(skillName, 'SKILL.md', newContent, true);

    // 验证内容已更新
    const skillMdPath = path.join(testSkillsDir, skillName, 'SKILL.md');
    const content = await fs.readFile(skillMdPath, 'utf-8');
    expect.toEqual(content, newContent);
  })

  .test('拒绝编辑archived技能', async () => {
    const skillName = 'to-archive-skill';
    await manager.createSkill(skillName, { name: skillName });

    // 删除技能（移动到archived）
    await manager.deleteSkill(skillName);

    // 尝试编辑archived技能
    let errorThrown = false;
    try {
      await manager.editSkillFile(skillName, 'SKILL.md', 'new content', true);
    } catch (error: any) {
      errorThrown = true;
      expect.toContain(error.message.toLowerCase(), 'archived');
    }

    expect.toBeTruthy(errorThrown, 'Should reject editing archived skill');
  })

  .test('删除技能（移动到archived）', async () => {
    const skillName = 'delete-skill';
    await manager.createSkill(skillName, { name: skillName });

    // 删除技能
    await manager.deleteSkill(skillName);

    // 验证技能不再在线
    let errorThrown = false;
    try {
      await manager.getSkillInfo(skillName);
    } catch (error: any) {
      errorThrown = true;
    }
    expect.toBeTruthy(errorThrown, 'Skill should not be online');

    // 验证技能在archived中
    const archivedSkills = await manager.listArchivedSkills();
    expect.toBeTruthy(archivedSkills.length > 0);
    expect.toEqual(archivedSkills[0].originalName, skillName);

    // 验证archived目录存在（注意：使用 .archived 而非 archived）
    const archivedDir = path.join(testSkillsDir, '.archived');
    expect.toBeTruthy(await fs.access(archivedDir).then(() => true).catch(() => false));
  })

  .test('恢复archived技能', async () => {
    const skillName = 'restore-skill';
    await manager.createSkill(skillName, { name: skillName, description: 'To be restored' });

    // 删除技能
    await manager.deleteSkill(skillName);

    // 获取archived技能名称
    const archivedSkills = await manager.listArchivedSkills();
    expect.toBeTruthy(archivedSkills.length > 0);
    const archivedName = archivedSkills[0].archivedName;

    // 恢复技能
    await manager.restoreSkill(archivedName);

    // 验证技能已恢复
    const restoredSkill = await manager.getSkillInfo(skillName);
    expect.toBeTruthy(restoredSkill);
    expect.toEqual(restoredSkill!.name, skillName);

    // 验证archived列表为空
    const newArchivedSkills = await manager.listArchivedSkills();
    expect.toEqual(newArchivedSkills.length, 0);
  })

  .test('列出archived技能', async () => {
    // 创建并删除多个技能
    await manager.createSkill('skill1', { name: 'skill1' });
    await manager.createSkill('skill2', { name: 'skill2' });

    await manager.deleteSkill('skill1');
    await new Promise(resolve => setTimeout(resolve, 10)); // 确保时间戳不同
    await manager.deleteSkill('skill2');

    // 列出archived技能
    const archivedSkills = await manager.listArchivedSkills();

    expect.toEqual(archivedSkills.length, 2);
    expect.toEqual(archivedSkills[0].originalName, 'skill2'); // 最新删除的在前
    expect.toEqual(archivedSkills[1].originalName, 'skill1');

    // 验证字段
    expect.toBeTruthy(archivedSkills[0].archivedName);
    expect.toBeTruthy(archivedSkills[0].archivedPath);
    expect.toBeTruthy(archivedSkills[0].archivedAt);
  })

  .test('获取技能文件树', async () => {
    const skillName = 'filetree-skill';
    await manager.createSkill(skillName, { name: skillName });

    // 添加一些额外文件
    const skillDir = path.join(testSkillsDir, skillName);
    await fs.writeFile(path.join(skillDir, 'test.txt'), 'test');
    await fs.writeFile(path.join(skillDir, 'references', 'ref1.txt'), 'ref1');
    await fs.writeFile(path.join(skillDir, 'scripts', 'script1.sh'), '#!/bin/bash');

    // 获取文件树
    const fileTree = await manager.getSkillFileTree(skillName);

    expect.toEqual(fileTree.name, '.');
    expect.toEqual(fileTree.type, 'dir');
    expect.toBeTruthy(fileTree.children);

    // 验证包含预期的文件和目录
    const names = fileTree.children!.map(c => c.name);
    expect.toContain(names, 'SKILL.md');
    expect.toContain(names, 'test.txt');
    expect.toContain(names, 'references');
    expect.toContain(names, 'scripts');
    expect.toContain(names, 'assets');
  })

  .test('队列状态查询', async () => {
    const status = manager.getQueueStatus();

    expect.toBeTruthy(typeof status.length === 'number');
    expect.toBeTruthy(typeof status.processing === 'boolean');
    expect.toBeTruthy(Array.isArray(status.tasks));
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
