/**
 * 技能管理器模块(路径1 - 技能管理)
 *
 * 设计原则 (UNIX哲学):
 * - 简洁: 只负责技能文件系统的管理操作
 * - 模块化: 单一职责,易于测试和维护
 * - 隔离: 与Agent运行时完全隔离,不参与Agent使用
 *
 * ⚠️ 重要说明:
 * - 此模块专门用于路径1(技能管理)
 * - 与路径2(Agent运行时)完全独立
 * - 请勿与SkillsManager混淆
 *
 * @see docs/skills-management-implementation-plan.md
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import type {
  SkillInfo,
  ArchivedSkillInfo,
} from './types';
import { logger } from '../../utils/logger';

const execAsync = promisify(exec);

/**
 * 技能管理器类
 *
 * 职责:
 * - 提供所有技能管理操作的统一接口(导入、复制、重命名、归档、导出)
 * - 处理业务逻辑和权限验证
 * - 所有操作严格遵循Specification.md规范
 * - ❌ 不参与Agent运行时
 * - ❌ 不提供技能加载、扫描等Agent使用的功能
 */
export class SkillsManagementManager {
  private skillsDir: string;
  private archivedDir: string;  // 归档目录: skills/.archived/

  constructor(
    skillsDir: string,
    archivedDir?: string  // 可选,默认为 skills/.archived/
  ) {
    this.skillsDir = path.resolve(skillsDir);
    this.archivedDir = archivedDir ? path.resolve(archivedDir) : path.join(this.skillsDir, '.archived');

    logger.log(`[SkillsManagementManager] Initialized with skills directory: ${this.skillsDir}`);
    logger.log(`[SkillsManagementManager] Archived directory: ${this.archivedDir}`);
  }

  // ==================== 公共方法(8个核心操作) ====================

  /**
   * 1. 列出在线技能
   * 扫描skills目录,排除.archived子目录
   * 返回技能清单及其元数据信息
   */
  async listSkills(): Promise<SkillInfo[]> {
    const skills: SkillInfo[] = [];

    try {
      // 1. 读取skills目录
      const entries = await fs.readdir(this.skillsDir, { withFileTypes: true });

      // 2. 遍历每个子目录
      for (const entry of entries) {
        // 排除.archived目录
        if (entry.name === '.archived') continue;

        // 只处理目录
        if (!entry.isDirectory()) continue;

        const skillDir = path.join(this.skillsDir, entry.name);

        // 3. 读取SKILL.md
        const skillMdPath = path.join(skillDir, 'SKILL.md');
        const exists = await this.fileExists(skillMdPath);
        if (!exists) continue; // 跳过没有SKILL.md的目录

        const content = await fs.readFile(skillMdPath, 'utf-8');

        // 4. 解析YAML frontmatter
        const metadata = this.parseSkillMd(content);
        if (!metadata) continue; // 跳过无效的SKILL.md

        // 获取文件统计信息
        const stat = await this.safeGetFileStat(skillMdPath);

        skills.push({
          name: metadata.name || entry.name,
          description: metadata.description || '',
          path: skillMdPath,
          baseDir: skillDir,
          folderName: entry.name,
          createdAt: stat?.birthtime?.toISOString(),
          updatedAt: stat?.mtime?.toISOString(),
        });
      }

      return skills;
    } catch (error: any) {
      logger.error('[SkillsManagementManager] Error listing skills:', error);
      throw error;
    }
  }

  /**
   * 2. 安装新技能
   * @param source 技能来源(名称/GitHub仓库/Git URL/本地路径)
   * @param onProgress 可选的进度回调函数，用于实时传递安装日志
   * 执行命令: npx -y ai-agent-skills install --agent project [source]
   * 直接安装到.skills目录
   */
  async installSkill(source: string, onProgress?: (data: { type: 'log' | 'error'; message: string }) => void): Promise<void> {
    try {
      // 验证source参数
      if (!source || source.trim().length === 0) {
        throw new Error('技能来源不能为空');
      }

      // 构建命令
      const command = `npx -y ai-agent-skills install --agent project ${source.trim()}`;

      logger.log(`[SkillsManagementManager] 正在安装技能: ${source}`);
      onProgress?.({ type: 'log', message: `正在安装技能: ${source}` });

      // 使用spawn替代execAsync以获取实时输出
      const { spawn } = require('child_process');

      return new Promise((resolve, reject) => {
        // 使用父目录作为工作目录，避免在.skills内再创建.skills
        const cwd = path.dirname(this.skillsDir);
        const child = spawn(command, [], {
          cwd,
          shell: true,
          env: { ...process.env }
        });

        let stdout = '';
        let stderr = '';
        let hasError = false;

        // 检测错误关键词的辅助函数
        const checkErrorKeywords = (text: string): boolean => {
          const trimmed = text.trim();
          // 移除ANSI颜色码
          const cleanText = trimmed.replace(/\u001b\[\d+m/g, '');

          return cleanText.includes('not found') ||
                 cleanText.includes('ERROR') ||
                 cleanText.includes('error:') ||
                 cleanText.includes('Failed to') ||
                 cleanText.includes('Cannot find');
        };

        // 监听标准输出
        child.stdout?.on('data', (data: Buffer) => {
          const message = data.toString();
          stdout += message;
          const trimmed = message.trim();

          // 检测stdout中的错误关键词
          if (checkErrorKeywords(trimmed)) {
            hasError = true;
          }

          logger.log(`[SkillsManagementManager] ${trimmed}`);
          onProgress?.({ type: 'log', message: trimmed });
        });

        // 监听错误输出
        child.stderr?.on('data', (data: Buffer) => {
          const message = data.toString();
          stderr += message;
          const trimmed = message.trim();

          // 检测stderr中的错误关键词
          if (checkErrorKeywords(trimmed)) {
            hasError = true;
          }

          logger.warn(`[SkillsManagementManager] ${trimmed}`);
          onProgress?.({ type: 'error', message: trimmed });
        });

        // 监听进程退出
        child.on('close', (code: number) => {
          // 检查是否有错误标识或退出码非0
          if (code !== 0 || hasError) {
            let errorMsg = '';
            if (hasError) {
              // 从stderr中提取关键错误信息
              const errorLines = stderr.split('\n').filter((line: string) =>
                line.includes('not found') ||
                line.includes('ERROR') ||
                line.includes('error:') ||
                line.includes('Failed') ||
                line.includes('Cannot')
              );
              errorMsg = errorLines.length > 0 ? errorLines[0].trim() : '安装过程中出现错误';
            } else {
              errorMsg = `安装进程退出码: ${code}`;
            }

            logger.error(`[SkillsManagementManager] 安装失败: ${errorMsg}`);
            reject(new Error(`安装技能失败: ${errorMsg}`));
          } else {
            logger.log(`[SkillsManagementManager] 技能已安装: ${source}`);
            resolve();
          }
        });

        // 监听错误
        child.on('error', (error: Error) => {
          const errorMsg = `启动安装进程失败: ${error.message}`;
          logger.error(`[SkillsManagementManager] ${errorMsg}`);
          onProgress?.({ type: 'error', message: errorMsg });
          reject(new Error(`安装技能失败: ${errorMsg}`));
        });
      });
    } catch (error: any) {
      logger.error(`[SkillsManagementManager] 安装技能失败: ${error.message}`);
      onProgress?.({ type: 'error', message: error.message });
      throw new Error(`安装技能失败: ${error.message}`);
    }
  }

  /**
   * 3. 列出归档技能
   * 扫描.archived目录
   * 返回归档技能清单及其元数据信息
   */
  async listArchivedSkills(): Promise<ArchivedSkillInfo[]> {
    const skills: ArchivedSkillInfo[] = [];

    try {
      // 1. 确保.archived目录存在
      const exists = await this.fileExists(this.archivedDir);
      if (!exists) {
        return skills; // 返回空列表
      }

      // 2. 读取.archived目录
      const entries = await fs.readdir(this.archivedDir, { withFileTypes: true });

      // 3. 遍历每个子目录
      for (const entry of entries) {
        // 只处理目录
        if (!entry.isDirectory()) continue;

        const skillDir = path.join(this.archivedDir, entry.name);

        // 4. 读取SKILL.md
        const skillMdPath = path.join(skillDir, 'SKILL.md');
        const skillExists = await this.fileExists(skillMdPath);
        if (!skillExists) continue; // 跳过没有SKILL.md的目录

        const content = await fs.readFile(skillMdPath, 'utf-8');

        // 5. 解析YAML frontmatter
        const metadata = this.parseSkillMd(content);
        if (!metadata) continue; // 跳过无效的SKILL.md

        // 6. 提取原始技能名称(去除-XXXXXXXX后缀)
        const match = entry.name.match(/^(.+)-[a-f0-9]{8}$/);
        const originalName = match ? match[1] : entry.name;

        // 获取文件统计信息
        const stat = await this.safeGetFileStat(skillDir);

        skills.push({
          originalName: originalName,
          archivedName: entry.name,
          archivedPath: skillDir,
          folderName: entry.name,
          archivedAt: stat?.mtime?.toISOString() || new Date().toISOString(),
          name: metadata.name,
          description: metadata.description,
          license: metadata.license,
        });
      }

      return skills;
    } catch (error: any) {
      logger.error('[SkillsManagementManager] Error listing archived skills:', error);
      throw error;
    }
  }

  /**
   * 4. 导入技能
   * @param zipFilePath zip文件路径
   * @param originalFileName 原始上传文件名（可选，用于无嵌套目录时的技能命名）
   * 验证SKILL.md格式,解压并放置在在线技能目录中
   *
   * 检测逻辑：
   * - 如果解压后根目录直接包含SKILL.md，视为无嵌套目录，使用originalFileName作为技能名称
   * - 如果根目录不包含SKILL.md但包含多个子目录，每个子目录都有SKILL.md，则批量导入
   */
  async importSkill(zipFilePath: string, originalFileName?: string): Promise<void> {
    try {
      // 1. 验证zip文件存在
      const exists = await this.fileExists(zipFilePath);
      if (!exists) {
        throw new Error(`Zip文件不存在: ${zipFilePath}`);
      }

      // 2. 创建临时目录
      const tempDir = path.join(os.tmpdir(), `skill-import-${Date.now()}`);
      await fs.mkdir(tempDir, { recursive: true });

      try {
        // 3. 解压zip文件
        await this.extractZip(zipFilePath, tempDir);

        // 4. 检测结构
        const rootSkillMdPath = path.join(tempDir, 'SKILL.md');
        const hasRootSkillMd = await this.fileExists(rootSkillMdPath);

        if (hasRootSkillMd && originalFileName) {
          // 4.1 无嵌套目录结构：根目录直接包含SKILL.md
          // 使用原始文件名（去除.zip扩展名）作为技能名称
          let skillName = originalFileName.replace(/\.zip$/i, '');

          // 验证SKILL.md
          const valid = await this.validateSkillMd(rootSkillMdPath);
          if (!valid) {
            throw new Error('技能格式无效, SKILL.md不符合Specification.md规范');
          }

          // 检测重名，如重名则添加后缀
          let targetDir = path.join(this.skillsDir, skillName);
          if (await this.fileExists(targetDir)) {
            const suffix = await this.generateRandomSuffix();
            const newName = `${skillName}-${suffix}`;
            targetDir = path.join(this.skillsDir, newName);
            logger.log(`[SkillsManagementManager] 导入技能重名，已添加后缀: ${skillName} -> ${newName}`);
            skillName = newName;
          }

          // 移动到在线技能目录
          await this.safeRename(tempDir, targetDir);
          logger.log(`[SkillsManagementManager] 技能已导入: ${skillName}`);
        } else {
          // 4.2 嵌套目录结构：批量导入多个技能目录
          const entries = await fs.readdir(tempDir, { withFileTypes: true });
          for (const entry of entries) {
            if (!entry.isDirectory()) continue;

            const skillDir = path.join(tempDir, entry.name);

            // 验证SKILL.md
            const skillMdPath = path.join(skillDir, 'SKILL.md');
            const valid = await this.validateSkillMd(skillMdPath);
            if (!valid) {
              throw new Error(`技能格式无效: ${entry.name}, SKILL.md不符合Specification.md规范`);
            }

            // 检测重名，如重名则添加后缀
            let targetName = entry.name;
            let targetDir = path.join(this.skillsDir, targetName);

            if (await this.fileExists(targetDir)) {
              // 重名，添加随机后缀
              const suffix = await this.generateRandomSuffix();
              targetName = `${entry.name}-${suffix}`;
              targetDir = path.join(this.skillsDir, targetName);
              logger.log(`[SkillsManagementManager] 导入技能重名，已添加后缀: ${entry.name} -> ${targetName}`);
            }

            // 移动到在线技能目录
            await this.safeRename(skillDir, targetDir);
            logger.log(`[SkillsManagementManager] 技能已导入: ${targetName}`);
          }
        }
      } finally {
        // 5. 清理临时目录
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    } catch (error: any) {
      logger.error('[SkillsManagementManager] Error importing skill:', error);
      throw error;
    }
  }

  /**
   * 5. 复制技能
   * @param skillName 技能名称
   * 新技能名称: {原技能名称}-{XXXXXXXX}
   */
  async copySkill(skillName: string): Promise<string> {
    try {
      // 1. 验证技能存在
      const sourceDir = path.join(this.skillsDir, skillName);
      const exists = await this.fileExists(sourceDir);
      if (!exists) {
        throw new Error(`技能不存在: ${skillName}`);
      }

      // 2. 生成8位随机后缀
      const suffix = await this.generateRandomSuffix();
      const newSkillName = `${skillName}-${suffix}`;
      const targetDir = path.join(this.skillsDir, newSkillName);

      // 3. 递归复制目录
      await fs.cp(sourceDir, targetDir, { recursive: true });
      logger.log(`[SkillsManagementManager] 技能已复制: ${skillName} -> ${newSkillName}`);

      return newSkillName;
    } catch (error: any) {
      logger.error('[SkillsManagementManager] Error copying skill:', error);
      throw error;
    }
  }

  /**
   * 6. 重命名技能
   * @param oldName 旧技能文件夹名称
   * @param newName 新技能文件夹名称
   * 不支持操作归档技能
   */
  async renameSkill(oldName: string, newName: string): Promise<void> {
    try {
      // 1. 验证旧技能存在
      const oldPath = path.join(this.skillsDir, oldName);
      const exists = await this.fileExists(oldPath);
      if (!exists) {
        throw new Error(`技能不存在: ${oldName}`);
      }

      // 2. 验证新名称
      if (!this.isValidSkillName(newName)) {
        throw new Error(`无效的技能名称: ${newName}`);
      }

      const newPath = path.join(this.skillsDir, newName);
      if (await this.fileExists(newPath)) {
        throw new Error(`技能已存在: ${newName}`);
      }

      // 3. 重命名目录（仅修改文件夹名称，不修改SKILL.md内容）
      await this.safeRename(oldPath, newPath);

      logger.log(`[SkillsManagementManager] 技能已重命名: ${oldName} -> ${newName}`);
    } catch (error: any) {
      logger.error('[SkillsManagementManager] Error renaming skill:', error);
      throw error;
    }
  }

  /**
   * 7. 在线技能转归档
   * @param skillName 技能名称
   * 归档名称: {原技能名称}-{XXXXXXXX}
   */
  async archiveSkill(skillName: string): Promise<void> {
    try {
      // 1. 验证技能存在
      const skillDir = path.join(this.skillsDir, skillName);
      const exists = await this.fileExists(skillDir);
      if (!exists) {
        throw new Error(`技能不存在: ${skillName}`);
      }

      // 2. 生成8位随机后缀
      const suffix = await this.generateRandomSuffix();
      const archivedName = `${skillName}-${suffix}`;

      // 3. 确保.archived目录存在
      await fs.mkdir(this.archivedDir, { recursive: true });

      // 4. 移动到.archived目录
      const archivedPath = path.join(this.archivedDir, archivedName);
      await this.safeRename(skillDir, archivedPath);

      logger.log(`[SkillsManagementManager] 技能已归档: ${skillName} -> ${archivedName}`);
    } catch (error: any) {
      logger.error('[SkillsManagementManager] Error archiving skill:', error);
      throw error;
    }
  }

  /**
   * 8. 归档技能转在线
   * @param archivedSkillName archived中的技能名称(含后缀)
   * 移入前检测重名
   */
  async unarchiveSkill(archivedSkillName: string): Promise<void> {
    try {
      // 1. 验证.archived技能存在
      const archivedPath = path.join(this.archivedDir, archivedSkillName);
      const exists = await this.fileExists(archivedPath);
      if (!exists) {
        throw new Error(`归档技能不存在: ${archivedSkillName}`);
      }

      // 2. 提取原始名称(去除-XXXXXXXX后缀)
      const match = archivedSkillName.match(/^(.+)-[a-f0-9]{8}$/);
      if (!match) {
        throw new Error(`无效的归档技能名称: ${archivedSkillName}`);
      }
      const originalName = match[1];

      // 3. 检测重名
      const targetPath = path.join(this.skillsDir, originalName);
      if (await this.fileExists(targetPath)) {
        throw new Error(`技能已存在: ${originalName}`);
      }

      // 4. 移回skills目录
      await this.safeRename(archivedPath, targetPath);

      logger.log(`[SkillsManagementManager] 技能已恢复: ${archivedSkillName} -> ${originalName}`);
    } catch (error: any) {
      logger.error('[SkillsManagementManager] Error unarchiving skill:', error);
      throw error;
    }
  }

  /**
   * 9. 查看在线技能内容
   * @param skillName 技能名称
   * 返回SKILL.md完整内容(包含frontmatter和正文)
   */
  async getOnlineSkillContent(skillName: string): Promise<string> {
    try {
      // 1. 验证技能存在
      const skillDir = path.join(this.skillsDir, skillName);
      const exists = await this.fileExists(skillDir);
      if (!exists) {
        throw new Error(`技能不存在: ${skillName}`);
      }

      // 2. 读取SKILL.md
      const skillMdPath = path.join(skillDir, 'SKILL.md');
      const skillExists = await this.fileExists(skillMdPath);
      if (!skillExists) {
        throw new Error(`SKILL.md不存在: ${skillName}`);
      }

      // 3. 返回完整内容
      const content = await fs.readFile(skillMdPath, 'utf-8');
      return content;
    } catch (error: any) {
      logger.error('[SkillsManagementManager] Error getting online skill content:', error);
      throw error;
    }
  }

  /**
   * 10. 查看归档技能内容
   * @param archivedSkillName 归档技能名称(含8位后缀)
   * 返回SKILL.md完整内容(包含frontmatter和正文)
   */
  async getArchivedSkillContent(archivedSkillName: string): Promise<string> {
    try {
      // 1. 验证归档技能存在
      const skillDir = path.join(this.archivedDir, archivedSkillName);
      const exists = await this.fileExists(skillDir);
      if (!exists) {
        throw new Error(`归档技能不存在: ${archivedSkillName}`);
      }

      // 2. 读取SKILL.md
      const skillMdPath = path.join(skillDir, 'SKILL.md');
      const skillExists = await this.fileExists(skillMdPath);
      if (!skillExists) {
        throw new Error(`SKILL.md不存在: ${archivedSkillName}`);
      }

      // 3. 返回完整内容
      const content = await fs.readFile(skillMdPath, 'utf-8');
      return content;
    } catch (error: any) {
      logger.error('[SkillsManagementManager] Error getting archived skill content:', error);
      throw error;
    }
  }

  /**
   * 11. 查看在线技能文件目录结构
   * @param skillName 技能名称
   * 返回JSON格式的目录树结构
   */
  async getOnlineSkillStructure(skillName: string): Promise<object> {
    try {
      // 1. 验证技能存在
      const skillDir = path.join(this.skillsDir, skillName);
      const exists = await this.fileExists(skillDir);
      if (!exists) {
        throw new Error(`技能不存在: ${skillName}`);
      }

      // 2. 构建目录树
      return await this.buildDirectoryTree(skillDir, skillName);
    } catch (error: any) {
      logger.error('[SkillsManagementManager] Error getting online skill structure:', error);
      throw error;
    }
  }

  /**
   * 12. 查看归档技能文件目录结构
   * @param archivedSkillName 归档技能名称(含8位后缀)
   * 返回JSON格式的目录树结构
   */
  async getArchivedSkillStructure(archivedSkillName: string): Promise<object> {
    try {
      // 1. 验证归档技能存在
      const skillDir = path.join(this.archivedDir, archivedSkillName);
      const exists = await this.fileExists(skillDir);
      if (!exists) {
        throw new Error(`归档技能不存在: ${archivedSkillName}`);
      }

      // 2. 构建目录树
      return await this.buildDirectoryTree(skillDir, archivedSkillName);
    } catch (error: any) {
      logger.error('[SkillsManagementManager] Error getting archived skill structure:', error);
      throw error;
    }
  }

  /**
   * 13. 导出技能
   * @param skillName 技能名称(在线或归档)
   * @param isArchived 是否为归档技能
   * 使用系统zip命令打包,放入临时目录
   */
  async exportSkill(skillName: string, isArchived: boolean): Promise<string> {
    try {
      // 1. 确定技能路径
      let skillDir: string;
      if (isArchived) {
        skillDir = path.join(this.archivedDir, skillName);
      } else {
        skillDir = path.join(this.skillsDir, skillName);
      }

      const exists = await this.fileExists(skillDir);
      if (!exists) {
        throw new Error(`技能不存在: ${skillName}`);
      }

      // 2. 生成zip文件路径
      const zipFileName = `${skillName}.zip`;
      const zipFilePath = path.join(os.tmpdir(), zipFileName);

      // 3. 使用系统zip命令打包
      await this.createZip(skillDir, zipFilePath);

      logger.log(`[SkillsManagementManager] 技能已导出: ${skillName} -> ${zipFilePath}`);

      return zipFilePath;
    } catch (error: any) {
      logger.error('[SkillsManagementManager] Error exporting skill:', error);
      throw error;
    }
  }

  // ==================== 私有辅助方法 ====================

  /**
   * 递归构建目录树
   */
  private async buildDirectoryTree(dirPath: string, relativePath: string = ''): Promise<object> {
    try {
      const stats = await fs.stat(dirPath);
      const name = path.basename(dirPath);

      if (!stats.isDirectory()) {
        return {
          name,
          type: 'file',
          path: relativePath || name,
          size: stats.size,
          modifiedTime: stats.mtime.toISOString(),
        };
      }

      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      const children: object[] = [];

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        const entryRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
          children.push(await this.buildDirectoryTree(fullPath, entryRelativePath));
        } else {
          const stat = await fs.stat(fullPath);
          children.push({
            name: entry.name,
            type: 'file',
            path: entryRelativePath,
            size: stat.size,
            modifiedTime: stat.mtime.toISOString(),
          });
        }
      }

      return {
        name,
        type: 'directory',
        path: relativePath || name,
        children,
      };
    } catch (error: any) {
      logger.error('[SkillsManagementManager] Error building directory tree:', error);
      throw error;
    }
  }

  /**
   * 解析SKILL.md的YAML frontmatter
   */
  private parseSkillMd(content: string): any {
    const match = content.match(/^---\n([\s\S]+?)\n---/);
    if (!match) return null;

    const yamlContent = match[1];
    // 简单YAML解析(只解析基本字段)
    const nameMatch = yamlContent.match(/^name:\s*(.+)$/m);
    const descMatch = yamlContent.match(/^description:\s*(.+)$/m);
    const licenseMatch = yamlContent.match(/^license:\s*(.+)$/m);

    if (!nameMatch) return null;

    return {
      name: nameMatch[1].trim(),
      description: descMatch ? descMatch[1].trim() : '',
      license: licenseMatch ? licenseMatch[1].trim() : undefined,
    };
  }

  /**
   * 验证SKILL.md格式(遵循Specification.md规范)
   */
  private async validateSkillMd(skillMdPath: string): Promise<boolean> {
    const exists = await this.fileExists(skillMdPath);
    if (!exists) return false;

    const content = await fs.readFile(skillMdPath, 'utf-8');
    const metadata = this.parseSkillMd(content);
    if (!metadata) return false;

    // 验证必需字段
    if (!metadata.name || !metadata.description) return false;

    // 验证name字段格式(1-64字符,小写字母数字和连字符)
    const nameRegex = /^[a-z0-9-]{1,64}$/;
    if (!nameRegex.test(metadata.name)) return false;

    // 验证name不以连字符开头或结尾
    if (metadata.name.startsWith('-') || metadata.name.endsWith('-')) return false;

    return true;
  }

  /**
   * 生成8位随机后缀
   * 规则: uuidv4 → sha256 → 全小写 → 取前8位
   */
  private async generateRandomSuffix(): Promise<string> {
    // 1. 生成UUID v4
    const uuid = crypto.randomUUID();

    // 2. 计算SHA256
    const hash = crypto.createHash('sha256').update(uuid).digest('hex');

    // 3. 全小写并取前8位
    return hash.toLowerCase().substring(0, 8);
  }

  /**
   * 验证技能名称
   */
  private isValidSkillName(name: string): boolean {
    // 只允许小写字母、数字、连字符
    const nameRegex = /^[a-z0-9-]+$/;
    return nameRegex.test(name) &&
           name.length > 0 &&
           name.length <= 64 &&
           !name.startsWith('-') &&
           !name.endsWith('-') &&
           !name.includes('--');
  }

  /**
   * 检查文件是否存在
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 安全获取文件统计信息
   */
  private async safeGetFileStat(filePath: string): Promise<import('fs').Stats | null> {
    try {
      return await fs.stat(filePath);
    } catch {
      return null;
    }
  }

  /**
   * 解压zip文件
   */
  private async extractZip(zipFilePath: string, targetDir: string): Promise<void> {
    const platform = os.platform();

    try {
      let cmd: string;
      if (platform === 'win32') {
        // Windows: 使用tar命令(Windows 10+内置)
        cmd = `tar -xf "${zipFilePath}" -C "${targetDir}"`;
      } else {
        // Linux/Mac: 使用unzip命令
        cmd = `unzip -q "${zipFilePath}" -d "${targetDir}"`;
      }

      await execAsync(cmd);
    } catch (error: any) {
      throw new Error(`解压失败: ${error.message}`);
    }
  }

  /**
   * 跨平台的安全重命名方法
   * Windows上使用"复制-删除"方式避免EPERM错误
   */
  private async safeRename(oldPath: string, newPath: string): Promise<void> {
    const platform = os.platform();

    try {
      if (platform === 'win32') {
        // Windows: 使用复制-删除方式（更可靠）
        await fs.cp(oldPath, newPath, { recursive: true });
        await fs.rm(oldPath, { recursive: true, force: true });
      } else {
        // Unix-like系统: 直接使用rename
        await fs.rename(oldPath, newPath);
      }
    } catch (error: any) {
      logger.error(`[SkillsManagementManager] safeRename failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * 创建zip文件
   */
  private async createZip(sourceDir: string, zipFilePath: string): Promise<void> {
    const platform = os.platform();

    try {
      let cmd: string;
      if (platform === 'win32') {
        // Windows: 使用PowerShell的Compress-Archive
        cmd = `powershell -Command "Compress-Archive -Path '${sourceDir}\\*' -DestinationPath '${zipFilePath}' -Force"`;
      } else {
        // Linux/Mac: 使用zip命令
        cmd = `cd "${sourceDir}" && zip -r "${zipFilePath}" .`;
      }

      await execAsync(cmd);
    } catch (error: any) {
      throw new Error(`创建zip失败: ${error.message}`);
    }
  }
}
