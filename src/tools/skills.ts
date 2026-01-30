/**
 * Skills 工具
 *
 * 设计原则 (UNIX哲学):
 * - 简洁: 只负责列出和加载skills，不处理业务逻辑
 * - 模块化: 复用SkillsManager进行实际操作
 * - 组合: 与SDK工具系统无缝集成
 */

import { tool } from '../tools/tool';
import { z } from 'zod';
import type { SkillsManager } from '../core/skills/manager';
import type { ToolContext } from '../core/types';

/**
 * Skills 工具描述
 *
 * 原始描述（已备份，list操作已临时禁用）:
 * const ORIGINAL_DESCRIPTION = `管理和加载skills。
 *
 * 使用此工具来:
 * - 列出所有可用的skills（获取元数据列表）
 * - 加载特定skill的详细内容（包含指令、references、scripts、assets）
 *
 * Skills是可重用的能力单元，可以扩展Agent的功能。`;
 */
const DESCRIPTION = `加载特定skill的详细内容。

使用此工具来:
- 加载特定skill的详细内容（包含指令、references、scripts、assets）
- 需要提供skill_name参数来指定要加载的技能

Skills是可重用的能力单元，可以扩展Agent的功能。`;

/**
 * 创建Skills工具
 *
 * @param skillsManager Skills管理器实例
 * @returns ToolInstance
 */
export function createSkillsTool(skillsManager: SkillsManager) {
  // 临时禁用 list 操作，只保留 load 操作
  // const actionSchema = z.enum(['list', 'load']).describe('操作类型');
  const actionSchema = z.enum(['load']).describe('操作类型');

  const skillsTool = tool({
    name: 'skills',
    description: DESCRIPTION,
    parameters: z.object({
      action: actionSchema,
      skill_name: z.string().optional().describe('技能名称（当action=load时必需）'),
    }),
    async execute(args, ctx: ToolContext) {
      const { action, skill_name } = args;

      // 注释掉 list 操作的代码
      // if (action === 'list') {
      //   // 列出所有skills（使用文件夹名称作为标识符）
      //   const skills = await skillsManager.getSkillsMetadata();
      //
      //   const skillsList = skills.map(s => ({
      //     name: s.name,  // 文件夹名称
      //     description: s.description,
      //   }));
      //
      //   return {
      //     ok: true,
      //     data: {
      //       count: skillsList.length,
      //       skills: skillsList,
      //     },
      //   };
      // } else if (action === 'load') {
      if (action === 'load') {
        // 加载特定skill内容
        if (!skill_name) {
          return {
            ok: false,
            error: 'skill_name is required when action=load',
          };
        }

        const content = await skillsManager.loadSkillContent(skill_name);

        if (!content) {
          return {
            ok: false,
            error: `Skill '${skill_name}' not found`,
          };
        }

        return {
          ok: true,
          data: {
            name: content.metadata.name,
            description: content.metadata.description,
            content: content.content,
            base_dir: content.metadata.baseDir,
            references: content.references,
            scripts: content.scripts,
            assets: content.assets,
          },
        };
      } else {
        return {
          ok: false,
          error: `Unknown action: ${action}`,
        };
      }
    },
    metadata: {
      readonly: true,
      version: '1.0',
    },
  });

  return skillsTool;
}

/**
 * 导出工具创建函数
 */
export default createSkillsTool;
