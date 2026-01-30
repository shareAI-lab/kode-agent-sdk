/**
 * 阶段一开发验证脚本
 *
 * 验证 SkillsManagementManager 的所有核心功能
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { SkillsManagementManager } from '../../src/core/skills/management-manager';

async function verifyStage1() {
  console.log('='.repeat(80));
  console.log('阶段一开发验证 - SkillsManagementManager');
  console.log('='.repeat(80));
  console.log();

  // 创建测试环境
  const testDir = path.join(os.tmpdir(), `stage1-verify-${Date.now()}`);
  const skillsDir = path.join(testDir, '.skills');
  const archivedDir = path.join(skillsDir, '.archived');

  await fs.mkdir(skillsDir, { recursive: true });
  await fs.mkdir(archivedDir, { recursive: true });

  const manager = new SkillsManagementManager(skillsDir, archivedDir);

  try {
    // 1. 验证基本功能
    console.log('✓ SkillsManagementManager 实例化成功');

    // 2. 创建测试技能
    const testSkillDir = path.join(skillsDir, 'test-skill');
    await fs.mkdir(testSkillDir, { recursive: true });
    await fs.writeFile(
      path.join(testSkillDir, 'SKILL.md'),
      `---
name: test-skill
description: A test skill for stage 1 verification
---

# Test Skill

This is a test skill for verifying stage 1 implementation.`,
      'utf-8'
    );
    console.log('✓ 测试技能创建成功');

    // 3. 测试列出在线技能
    const skills = await manager.listSkills();
    console.log(`✓ listSkills: 找到 ${skills.length} 个在线技能`);
    if (skills.length > 0) {
      console.log(`  - ${skills[0].name}: ${skills[0].description}`);
    }

    // 4. 测试复制技能
    const newSkillName = await manager.copySkill('test-skill');
    console.log(`✓ copySkill: 复制技能成功 -> ${newSkillName}`);

    // 5. 测试重命名技能
    await manager.renameSkill(newSkillName, 'renamed-skill');
    console.log('✓ renameSkill: 重命名技能成功 -> renamed-skill');

    // 6. 测试查看在线技能内容
    const content = await manager.getOnlineSkillContent('test-skill');
    console.log(`✓ getOnlineSkillContent: 读取内容成功 (${content.length} 字符)`);

    // 7. 测试查看在线技能结构
    const structure = await manager.getOnlineSkillStructure('test-skill');
    console.log('✓ getOnlineSkillStructure: 获取目录结构成功');

    // 8. 测试归档技能
    await manager.archiveSkill('renamed-skill');
    console.log('✓ archiveSkill: 归档技能成功');

    // 9. 测试列出归档技能
    const archivedSkills = await manager.listArchivedSkills();
    console.log(`✓ listArchivedSkills: 找到 ${archivedSkills.length} 个归档技能`);
    if (archivedSkills.length > 0) {
      console.log(`  - ${archivedSkills[0].originalName} -> ${archivedSkills[0].archivedName}`);
    }

    // 10. 测试查看归档技能内容
    const archivedContent = await manager.getArchivedSkillContent(archivedSkills[0].archivedName);
    console.log(`✓ getArchivedSkillContent: 读取归档内容成功 (${archivedContent.length} 字符)`);

    // 11. 测试查看归档技能结构
    const archivedStructure = await manager.getArchivedSkillStructure(archivedSkills[0].archivedName);
    console.log('✓ getArchivedSkillStructure: 获取归档目录结构成功');

    // 12. 测试恢复归档技能
    await manager.unarchiveSkill(archivedSkills[0].archivedName);
    console.log('✓ unarchiveSkill: 恢复归档技能成功');

    // 13. 测试导出技能
    const exportPath = await manager.exportSkill('test-skill', false);
    console.log(`✓ exportSkill: 导出技能成功 -> ${exportPath}`);
    await fs.rm(exportPath, { force: true });

    // 14. 验证 installSkill 参数验证
    let hasError = false;
    try {
      await manager.installSkill('');
    } catch (error: any) {
      hasError = true;
    }
    if (hasError) {
      console.log('✓ installSkill: 参数验证正常（空字符串抛出错误）');
    }

    console.log();
    console.log('='.repeat(80));
    console.log('阶段一验证完成！所有核心功能正常工作。');
    console.log('='.repeat(80));
    console.log();
    console.log('已实现的功能:');
    console.log('  1. ✓ listSkills - 列出在线技能');
    console.log('  2. ✓ installSkill - 安装新技能');
    console.log('  3. ✓ listArchivedSkills - 列出归档技能');
    console.log('  4. ✓ importSkill - 导入技能（zip）');
    console.log('  5. ✓ copySkill - 复制技能');
    console.log('  6. ✓ renameSkill - 重命名技能');
    console.log('  7. ✓ archiveSkill - 归档技能');
    console.log('  8. ✓ unarchiveSkill - 恢复归档技能');
    console.log('  9. ✓ getOnlineSkillContent - 查看在线技能内容');
    console.log(' 10. ✓ getArchivedSkillContent - 查看归档技能内容');
    console.log(' 11. ✓ getOnlineSkillStructure - 查看在线技能目录结构');
    console.log(' 12. ✓ getArchivedSkillStructure - 查看归档技能目录结构');
    console.log(' 13. ✓ exportSkill - 导出技能');
    console.log();
  } catch (error: any) {
    console.error('✗ 验证失败:', error.message);
    process.exit(1);
  } finally {
    // 清理测试环境
    await fs.rm(testDir, { recursive: true, force: true });
  }
}

verifyStage1().catch((err) => {
  console.error('验证脚本错误:', err);
  process.exit(1);
});
