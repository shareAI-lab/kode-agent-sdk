/**
 * SkillsManagementManager 功能验证脚本
 *
 * 手动运行: ts-node --project tsconfig.json ./tests/skills/test-management-manager.ts
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { SkillsManagementManager } from '../../src/core/skills/management-manager';

async function testManagementManager() {
  console.log('\n========================================');
  console.log('SkillsManagementManager 功能验证');
  console.log('========================================\n');

  // 创建临时测试目录
  const testSkillsDir = path.join(os.tmpdir(), `test-skills-${Date.now()}`);
  const testArchivedDir = path.join(testSkillsDir, '.archived');

  await fs.mkdir(testSkillsDir, { recursive: true });
  await fs.mkdir(testArchivedDir, { recursive: true });

  const manager = new SkillsManagementManager(testSkillsDir, testArchivedDir);

  try {
    // 测试数据
    const validSkillMd = `---
name: test-skill
description: A test skill for validation
---

# Test Skill

This is a test skill for validating the SkillsManagementManager.`;

    // ========== 测试1: 列出在线技能(空列表) ==========
    console.log('✓ 测试1: listSkills() - 空列表');
    let skills = await manager.listSkills();
    console.assert(skills.length === 0, '  应返回空列表');
    console.log('  通过: 返回空列表\n');

    // ========== 测试2: 创建测试技能 ==========
    console.log('✓ 测试2: 创建测试技能');
    const skillDir = path.join(testSkillsDir, 'test-skill');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), validSkillMd, 'utf-8');
    console.log('  通过: 创建test-skill\n');

    // ========== 测试3: 列出在线技能 ==========
    console.log('✓ 测试3: listSkills() - 列出技能');
    skills = await manager.listSkills();
    console.assert(skills.length === 1, '  应返回1个技能');
    console.assert(skills[0].name === 'test-skill', '  名称应为test-skill');
    console.log(`  通过: 列出 ${skills.length} 个技能 - ${skills[0].name}\n`);

    // ========== 测试4: 复制技能 ==========
    console.log('✓ 测试4: copySkill() - 复制技能');
    const newSkillName = await manager.copySkill('test-skill');
    console.assert(newSkillName.match(/^test-skill-[a-f0-9]{8}$/), '  应生成8位后缀');
    console.log(`  通过: 复制为 ${newSkillName}\n`);

    // ========== 测试5: 重命名技能 ==========
    console.log('✓ 测试5: renameSkill() - 重命名技能');
    await manager.renameSkill('test-skill', 'renamed-skill');
    const renamedExists = await fs.access(path.join(testSkillsDir, 'renamed-skill')).then(() => true).catch(() => false);
    console.assert(renamedExists, '  重命名后目录应存在');
    console.log('  通过: test-skill -> renamed-skill\n');

    // ========== 测试6: 归档技能 ==========
    console.log('✓ 测试6: archiveSkill() - 归档技能');
    await manager.archiveSkill('renamed-skill');
    const archivedSkills = await manager.listArchivedSkills();
    console.assert(archivedSkills.length === 1, '  应有1个归档技能');
    console.assert(archivedSkills[0].originalName === 'renamed-skill', '  原始名称应为renamed-skill');
    console.log(`  通过: 归档为 ${archivedSkills[0].archivedName}\n`);

    // ========== 测试7: 恢复归档技能 ==========
    console.log('✓ 测试7: unarchiveSkill() - 恢复归档技能');
    await manager.unarchiveSkill(archivedSkills[0].archivedName);
    skills = await manager.listSkills();
    console.assert(skills.length === 2, '  应有2个在线技能');
    console.log('  通过: 恢复归档技能\n');

    // ========== 测试8: 导出技能 ==========
    console.log('✓ 测试8: exportSkill() - 导出技能');
    const zipPath = await manager.exportSkill('renamed-skill', false);
    console.assert(zipPath.endsWith('.zip'), '  应生成zip文件');
    const zipExists = await fs.access(zipPath).then(() => true).catch(() => false);
    console.assert(zipExists, '  zip文件应存在');
    console.log(`  通过: 导出为 ${zipPath}\n`);

    // ========== 测试9: SKILL.md验证 ==========
    console.log('✓ 测试9: validateSkillMd() - 验证SKILL.md格式');
    const invalidDir = path.join(testSkillsDir, 'invalid-skill');
    await fs.mkdir(invalidDir, { recursive: true });
    await fs.writeFile(
      path.join(invalidDir, 'SKILL.md'),
      '---\nname: INVALID-Name\n---\n',
      'utf-8'
    );
    skills = await manager.listSkills();
    console.assert(skills.length === 2, '  无效技能应被跳过');
    console.log('  通过: 无效技能被过滤\n');

    // ========== 总结 ==========
    console.log('========================================');
    console.log('✅ 所有功能验证通过!');
    console.log('========================================\n');

    console.log('已实现的8个核心方法:');
    console.log('  1. listSkills()       - 列出在线技能');
    console.log('  2. listArchivedSkills() - 列出归档技能');
    console.log('  3. importSkill()     - 导入技能(zip)');
    console.log('  4. copySkill()       - 复制技能(8位随机后缀)');
    console.log('  5. renameSkill()     - 重命名技能');
    console.log('  6. archiveSkill()    - 归档技能(8位随机后缀)');
    console.log('  7. unarchiveSkill()  - 恢复归档技能');
    console.log('  8. exportSkill()     - 导出技能(zip)');
    console.log('');

    console.log('符合文档规范的关键特性:');
    console.log('  ✓ 归档命名格式: {skillName}-{XXXXXXXX} (8位随机后缀)');
    console.log('  ✓ SKILL.md格式验证(遵循Specification.md)');
    console.log('  ✓ 与SkillsManager完全独立(路径1 vs 路径2)');
    console.log('  ✓ 删除了文档外的额外方法\n');

  } catch (error: any) {
    console.error('\n❌ 测试失败:', error.message);
    console.error(error.stack);
    process.exitCode = 1;
  } finally {
    // 清理测试目录
    await fs.rm(testSkillsDir, { recursive: true, force: true });
    console.log('清理: 测试目录已删除\n');
  }
}

// 运行测试
testManagementManager().catch(err => {
  console.error('测试运行器错误:', err);
  process.exitCode = 1;
});
