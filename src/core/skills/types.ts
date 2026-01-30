/**
 * Skills 核心类型定义
 *
 * 设计原则 (UNIX哲学):
 * - 简洁: 类型定义清晰，职责单一
 * - 模块化: 类型独立，易于维护和扩展
 */

/**
 * Skill 元数据
 */
export interface SkillMetadata {
  /** skill名称 */
  name: string;
  /** skill描述 */
  description: string;
  /** SKILL.md文件路径 */
  path: string;
  /** skill根目录（用于解析references等） */
  baseDir: string;
}

/**
 * Skill 完整内容
 */
export interface SkillContent {
  /** 元数据 */
  metadata: SkillMetadata;
  /** SKILL.md的markdown内容 */
  content: string;
  /** references目录下的文件列表 */
  references: string[];
  /** scripts目录下的文件列表 */
  scripts: string[];
  /** assets目录下的文件列表 */
  assets: string[];
}

/**
 * Sandbox 配置
 * 参考 docs/sandbox-support-evaluation.md 中的设计
 */
export interface SandboxConfig {
  /** 是否启用sandbox隔离（默认false，本地开发直接执行） */
  enabled: boolean;
  /** 工作目录 */
  workDir?: string;
  /** 是否强制边界检查 */
  enforceBoundary?: boolean;
  /** 允许访问的路径白名单 */
  allowPaths?: string[];
}

/**
 * 技能基本信息
 */
export interface SkillInfo {
  /** 技能名称 */
  name: string;
  /** 技能描述 */
  description: string;
  /** SKILL.md路径 */
  path: string;
  /** 技能根目录 */
  baseDir: string;
  /** 文件夹名称（技能目录名） */
  folderName: string;
  /** 创建时间 */
  createdAt?: string;
  /** 更新时间 */
  updatedAt?: string;
}

/**
 * 技能详细信息
 */
export interface SkillDetail extends SkillInfo {
  /** 文件树结构 */
  files: SkillFileTree;
  /** references目录文件 */
  references: string[];
  /** scripts目录文件 */
  scripts: string[];
  /** assets目录文件 */
  assets: string[];
}

/**
 * 文件树节点
 */
export interface SkillFileTree {
  /** 文件/目录名 */
  name: string;
  /** 类型 */
  type: 'file' | 'dir';
  /** 相对于技能根目录的路径 */
  path: string;
  /** 文件大小（字节） */
  size?: number;
  /** 修改时间 */
  modifiedTime?: string;
  /** 子节点（目录） */
  children?: SkillFileTree[];
}

/**
 * 创建技能选项
 */
export interface CreateSkillOptions {
  /** 技能名称（必须与目录名一致） */
  name: string;
  /** 技能描述 */
  description?: string;
  /** 模板类型 */
  template?: 'basic' | 'advanced';
}

/**
 * Archived技能信息
 */
export interface ArchivedSkillInfo {
  /** 原始技能名称 */
  originalName: string;
  /** archived目录中的名称（含时间戳） */
  archivedName: string;
  /** archived目录中的完整路径 */
  archivedPath: string;
  /** 文件夹名称（归档目录名） */
  folderName: string;
  /** 归档时间 */
  archivedAt: string;
  /** 技能名称（从SKILL.md解析） */
  name?: string;
  /** 技能描述（从SKILL.md解析） */
  description?: string;
  /** 许可证（从SKILL.md解析） */
  license?: string;
  /** 其他元数据 */
  metadata?: Record<string, string>;
}
