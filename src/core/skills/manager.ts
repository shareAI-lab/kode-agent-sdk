/**
 * Skills 管理器
 *
 * 设计原则 (UNIX哲学):
 * - 简洁: 只负责扫描和加载skills，不处理业务逻辑
 * - 模块化: 单一职责，易于测试和维护
 * - 热更新: 每次调用都重新扫描文件系统，确保数据最新
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { SkillMetadata, SkillContent } from './types';
import { logger } from '../../utils/logger';

/**
 * Skills 管理器
 */
export class SkillsManager {
  private skillsDir: string;
  private cache: Map<string, SkillMetadata> = new Map();
  private allowedSkills?: string[];
  private skillsDisabled: boolean = false;

  constructor(skillsDir?: string, allowedSkills?: string[]) {
    // 优先使用传入的路径，其次使用环境变量，最后使用默认路径
    // 默认路径：程序当前工作目录下的 .skills/
    const envSkillsDir = process.env.SKILLS_DIR;
    const defaultSkillsDir = path.join(process.cwd(), '.skills');

    this.skillsDir = path.resolve(
      skillsDir ||
      envSkillsDir ||
      defaultSkillsDir
    );

    // 设置允许加载的 skills 白名单
    // 特殊处理：
    // 1. 如果白名单包含 "/*/"，则完全禁用技能功能
    // 2. 如果白名单包含"*"，则视为未设置白名单（加载所有技能）
    if (allowedSkills && allowedSkills.length === 1 && allowedSkills[0] === '/*/') {
      this.skillsDisabled = true;
      this.allowedSkills = [];
      logger.log(`[SkillsManager] Skills disabled (whitelist is "/*/")`);
    } else if (allowedSkills && allowedSkills.length === 1 && allowedSkills[0] === '*') {
      this.allowedSkills = undefined;
      logger.log(`[SkillsManager] Whitelist contains "*", loading all skills`);
    } else {
      this.allowedSkills = allowedSkills;
    }

    logger.log(`[SkillsManager] Initialized with skills directory: ${this.skillsDir}`);
    if (this.skillsDisabled) {
      logger.log(`[SkillsManager] Skills feature is disabled`);
    } else if (this.allowedSkills) {
      logger.log(`[SkillsManager] Allowed skills whitelist: ${this.allowedSkills.join(', ')}`);
    }
  }

  /**
   * 扫描skills目录（支持热更新）
   * 每次调用时重新扫描，确保读取最新数据
   */
  async scan(): Promise<SkillMetadata[]> {
    // 如果技能功能被禁用，直接返回空数组
    if (this.skillsDisabled) {
      logger.log(`[SkillsManager] Skills disabled, skipping scan`);
      return [];
    }

    // 清空缓存
    this.cache.clear();

    try {
      // 检查目录是否存在
      const exists = await this.fileExists(this.skillsDir);
      if (!exists) {
        logger.log(`[SkillsManager] Skills directory does not exist: ${this.skillsDir}`);
        return [];
      }

      // 递归扫描skills目录
      const entries = await this.scanDirectory(this.skillsDir);

      // 提取每个skill的元数据
      for (const entry of entries) {
        const metadata = await this.parseSkillMetadata(entry.skillMdPath, entry.folderName);
        if (metadata) {
          // 如果设置了白名单，只加载白名单中的 skills
          if (this.allowedSkills) {
            if (this.allowedSkills.includes(metadata.name)) {
              this.cache.set(metadata.name, metadata);
            } else {
              logger.log(`[SkillsManager] Skipping skill not in whitelist: ${metadata.name}`);
            }
          } else {
            // 没有设置白名单，加载所有 skills
            this.cache.set(metadata.name, metadata);
          }
        }
      }

      logger.log(`[SkillsManager] Scanned ${this.cache.size} skill(s)`);
      return Array.from(this.cache.values());
    } catch (error: any) {
      logger.error(`[SkillsManager] Error scanning skills directory:`, error.message);
      return [];
    }
  }

  /**
   * 获取所有skills的元数据列表（供LLM选择）
   */
  async getSkillsMetadata(): Promise<SkillMetadata[]> {
    // 每次调用时重新扫描，支持热更新
    return await this.scan();
  }

  /**
   * 加载指定skill的完整内容
   */
  async loadSkillContent(skillName: string): Promise<SkillContent | null> {
    // 先扫描确保元数据最新
    await this.scan();

    const metadata = this.cache.get(skillName);
    if (!metadata) {
      return null;
    }

    try {
      // 读取SKILL.md内容
      const content = await fs.readFile(metadata.path, 'utf-8');

      // 扫描子目录
      const references = await this.listSubdirectory(metadata.baseDir, 'references');
      const scripts = await this.listSubdirectory(metadata.baseDir, 'scripts');
      const assets = await this.listSubdirectory(metadata.baseDir, 'assets');

      return {
        metadata,
        content,
        references,
        scripts,
        assets,
      };
    } catch (error: any) {
      logger.error(`[SkillsManager] Error loading skill content:`, error.message);
      return null;
    }
  }

  /**
   * 递归扫描目录，查找所有SKILL.md
   * 返回格式: { skillMdPath: string, folderName: string }[]
   */
  private async scanDirectory(dir: string): Promise<Array<{ skillMdPath: string; folderName: string }>> {
    const skills: Array<{ skillMdPath: string; folderName: string }> = [];

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          // 检查是否有SKILL.md
          const skillMdPath = path.join(fullPath, 'SKILL.md');
          if (await this.fileExists(skillMdPath)) {
            // 返回SKILL.md路径和文件夹名称
            skills.push({ skillMdPath, folderName: entry.name });
          } else {
            // 递归扫描子目录
            const subSkills = await this.scanDirectory(fullPath);
            skills.push(...subSkills);
          }
        }
      }
    } catch (error: any) {
      logger.warn(`[SkillsManager] Error reading directory ${dir}:`, error.message);
    }

    return skills;
  }

  /**
   * 解析SKILL.md，提取元数据
   * @param skillMdPath SKILL.md文件的完整路径
   * @param folderName 技能文件夹名称（作为技能标识符）
   */
  private async parseSkillMetadata(skillMdPath: string, folderName: string): Promise<SkillMetadata | null> {
    try {
      const content = await fs.readFile(skillMdPath, 'utf-8');

      // 提取YAML frontmatter
      const match = content.match(/^---\n([\s\S]+?)\n---/);
      if (!match) {
        logger.warn(`[SkillsManager] Invalid SKILL.md (missing YAML frontmatter): ${skillMdPath}`);
        return null;
      }

      const yaml = match[1];
      const descMatch = yaml.match(/^description:\s*(.+)$/m);

      // 使用文件夹名称作为技能标识符，而不是从YAML中读取name
      return {
        name: folderName,
        description: descMatch ? descMatch[1].trim() : '',
        path: skillMdPath,
        baseDir: path.dirname(skillMdPath),
      };
    } catch (error: any) {
      logger.warn(`[SkillsManager] Error parsing ${skillMdPath}:`, error.message);
      return null;
    }
  }

  /**
   * 列出子目录下的文件
   */
  private async listSubdirectory(baseDir: string, subdir: string): Promise<string[]> {
    const fullPath = path.join(baseDir, subdir);

    if (!(await this.fileExists(fullPath))) {
      return [];
    }

    const files: string[] = [];
    try {
      const entries = await fs.readdir(fullPath, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isFile()) {
          files.push(path.join(fullPath, entry.name));
        }
      }
    } catch (error: any) {
      // 目录不存在或无权限访问，返回空数组
      logger.debug(`[SkillsManager] Subdirectory not accessible: ${fullPath}`);
    }

    return files;
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
}
