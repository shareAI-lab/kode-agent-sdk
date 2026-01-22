/**
 * Store 模块 - Agent 持久化
 *
 * 本文件已重构为模块化结构，实际实现已拆分到 store/ 目录下：
 * - store/types.ts        - 接口和类型定义
 * - store/json-store.ts   - JSONStore 文件存储实现
 * - db/sqlite/            - SQLite 数据库实现
 * - db/postgres/          - PostgreSQL 数据库实现
 *
 * 本文件仅做向后兼容的导出
 */

// 重导出所有内容以保持向后兼容
export * from './store/index';
