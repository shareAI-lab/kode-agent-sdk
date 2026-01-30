/**
 * Skills 完整内容加载测试
 *
 * 验证 loadSkillContent 正确加载完整的 SKILL.md 内容
 * 包括 YAML frontmatter（name、description 等）和正文
 */

import { TestRunner, expect } from '../../helpers/utils';
import { SkillsManager } from '../../../src/core/skills/manager';
import * as fs from 'fs/promises';
import * as path from 'path';

const runner = new TestRunner('Skills - 完整内容加载验证');

async function createTestSkill(baseDir: string, folderName: string, yamlName: string, description: string) {
  const skillDir = path.join(baseDir, folderName);
  await fs.mkdir(skillDir, { recursive: true });

  const skillContent = `---
name: ${yamlName}
description: ${description}
license: Apache-2.0
metadata:
  author: test-author
  version: "1.0"
---

# ${yamlName}

This is the complete skill instruction for ${yamlName}.

## Features

- Feature 1
- Feature 2

## Usage

Use this skill when you need to ${description.toLowerCase()}.
`;
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), skillContent);
  return skillDir;
}

runner
  .test('应该加载完整的SKILL.md内容，包括YAML frontmatter和正文', async () => {
    const testDir = path.join(process.cwd(), 'test-skills-full-' + Date.now());
    await fs.mkdir(testDir, { recursive: true });
    const manager = new SkillsManager(testDir);

    try {
      await createTestSkill(testDir, 'test-skill', 'yaml-test-name', 'Test description for full content');

      // 加载技能内容
      const content = await manager.loadSkillContent('test-skill');

      expect.toBeTruthy(content);
      expect.toBeTruthy(content!.content);

      // 验证完整的 SKILL.md 内容
      const fullContent = content!.content;

      // 1. 验证包含 YAML frontmatter 的开始标记
      expect.toContain(fullContent, '---');

      // 2. 验证包含 YAML 中的 name 字段
      expect.toContain(fullContent, 'name: yaml-test-name');

      // 3. 验证包含 YAML 中的 description 字段
      expect.toContain(fullContent, 'description: Test description for full content');

      // 4. 验证包含 YAML 中的 license 字段
      expect.toContain(fullContent, 'license: Apache-2.0');

      // 5. 验证包含 YAML 中的 metadata 字段
      expect.toContain(fullContent, 'metadata:');
      expect.toContain(fullContent, 'author: test-author');
      expect.toContain(fullContent, 'version: "1.0"');

      // 6. 验证包含 YAML frontmatter 的结束标记
      expect.toContain(fullContent, '---\n');

      // 7. 验证包含正文标题
      expect.toContain(fullContent, '# yaml-test-name');

      // 8. 验证包含正文内容
      expect.toContain(fullContent, 'This is the complete skill instruction');
      expect.toContain(fullContent, '## Features');
      expect.toContain(fullContent, '- Feature 1');
      expect.toContain(fullContent, '- Feature 2');
      expect.toContain(fullContent, '## Usage');
    } finally {
      await fs.rm(testDir, { recursive: true, force: true });
    }
  })

  .test('返回的metadata应该包含文件夹名称和description', async () => {
    const testDir = path.join(process.cwd(), 'test-skills-meta-' + Date.now());
    await fs.mkdir(testDir, { recursive: true });
    const manager = new SkillsManager(testDir);

    try {
      await createTestSkill(testDir, 'folder-skill', 'yaml-skill-name', 'Meta description test');

      const content = await manager.loadSkillContent('folder-skill');

      expect.toBeTruthy(content);
      expect.toBeTruthy(content!.metadata);

      // metadata.name 应该是文件夹名称
      expect.toEqual(content!.metadata.name, 'folder-skill');

      // metadata.description 应该从 YAML 中提取
      expect.toEqual(content!.metadata.description, 'Meta description test');

      // metadata.path 应该指向 SKILL.md
      expect.toContain(content!.metadata.path, 'SKILL.md');

      // metadata.baseDir 应该是文件夹路径
      expect.toContain(content!.metadata.baseDir, 'folder-skill');
    } finally {
      await fs.rm(testDir, { recursive: true, force: true });
    }
  })

  .test('content字段应该包含完整的原始SKILL.md内容（未解析）', async () => {
    const testDir = path.join(process.cwd(), 'test-skills-raw-' + Date.now());
    await fs.mkdir(testDir, { recursive: true });
    const manager = new SkillsManager(testDir);

    try {
      const yamlName = 'raw-content-skill';
      await createTestSkill(testDir, 'raw-skill', yamlName, 'Raw content verification');

      const content = await manager.loadSkillContent('raw-skill');

      expect.toBeTruthy(content);

      // 读取原始文件进行对比
      const originalContent = await fs.readFile(content!.metadata.path, 'utf-8');

      // content 字段应该与原始文件完全一致
      expect.toEqual(content!.content, originalContent);
    } finally {
      await fs.rm(testDir, { recursive: true, force: true });
    }
  })

  .test('工具返回的数据应该包含完整的content字段', async () => {
    const testDir = path.join(process.cwd(), 'test-skills-tool-' + Date.now());
    await fs.mkdir(testDir, { recursive: true });
    const manager = new SkillsManager(testDir);

    try {
      await createTestSkill(testDir, 'tool-test-skill', 'tool-yaml-name', 'Tool content test');

      const content = await manager.loadSkillContent('tool-test-skill');

      // 验证返回的数据结构
      expect.toBeTruthy(content);
      expect.toBeTruthy(content!.metadata);
      expect.toBeTruthy(content!.content);

      // 验证 content 字段包含完整信息
      const skillContent = content!.content;

      // 应该包含 YAML 中的 name（不是文件夹名）
      expect.toContain(skillContent, 'name: tool-yaml-name');

      // 应该包含 YAML 中的 description
      expect.toContain(skillContent, 'description: Tool content test');

      // 应该包含完整的元数据
      expect.toContain(skillContent, 'license: Apache-2.0');
      expect.toContain(skillContent, 'author: test-author');

      // 应该包含正文
      expect.toContain(skillContent, '# tool-yaml-name');
      expect.toContain(skillContent, 'This is the complete skill instruction');
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
