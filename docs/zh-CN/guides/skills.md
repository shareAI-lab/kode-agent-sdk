# Skills 系统指南

KODE SDK 提供完整的 Skills 系统，支持模块化、可重用的能力单元，使 Agent 能够动态加载和执行特定技能。

> **⚠️ Breaking Changes - 重大变更**
>
> **默认 Skills 目录已从 `skills/` 更改为 `.skills/`**
>
> - 如果您未设置 `SKILLS_DIR` 环境变量，SkillsManager 现在将使用 `.skills/` 作为默认目录
> - **影响范围**：所有未显式指定 skills 目录路径的代码
> - **迁移方案**：
>   - 方案 1：将现有的 `skills/` 目录重命名为 `.skills/`
>   - 方案 2：设置环境变量 `SKILLS_DIR` 指向原目录（如 `export SKILLS_DIR=./skills`）
>   - 方案 3：在代码中显式指定路径：`new SkillsManager('./skills')`

---

## 核心特性

| 特性 | 说明 |
|------|------|
| **热重载** | Skills 代码修改后自动重新加载 |
| **元数据注入** | 自动将技能描述注入到系统提示 |
| **沙箱隔离** | 每个技能有独立的文件系统空间 |
| **白名单机制** | 选择性加载特定技能，支持 `["/*/"`](完全禁用) 和 `["*"]`(加载所有) 特殊配置 |

---

## 目录结构

```
.skills/
├── skill-name/              # 技能目录
│   ├── SKILL.md            # 技能定义（必需）
│   ├── metadata.json       # 技能元数据（可选）
│   ├── references/         # 参考资料
│   ├── scripts/            # 可执行脚本
│   └── assets/             # 静态资源
└── .archived/              # 已归档技能
    └── archived-skill/
```

### SKILL.md 格式

```markdown
<!-- skill: skill-name -->
<!-- version: 1.0.0 -->
<!-- author: Your Name -->

# 技能名称

简短描述技能的功能。

## 使用场景

- 场景1
- 场景2

## 使用指南

使用此技能的详细说明...
```

### metadata.json 格式

```json
{
  "name": "skill-name",
  "description": "技能描述",
  "version": "1.0.0",
  "author": "作者",
  "baseDir": "/path/to/skill"
}
```

---

## 环境变量配置

<!-- tabs:start -->
#### **Linux / macOS**
```bash
export SKILLS_DIR=/path/to/.skills
```

#### **Windows (PowerShell)**
```powershell
$env:SKILLS_DIR="C:\path\to\.skills"
```

#### **Windows (CMD)**
```cmd
set SKILLS_DIR=C:\path\to\.skills
```
<!-- tabs:end -->

---

## SkillsManager（Agent 运行时）

SkillsManager 是 Agent 在运行时使用的技能管理器，支持热更新和动态加载。

### 基本用法

```typescript
import { SkillsManager } from '@shareai-lab/kode-sdk';

// 创建 Skills 管理器
const skillsManager = new SkillsManager(
  './.skills',          // 技能目录路径（默认为 .skills）
  ['skill1', 'skill2']  // 可选：白名单
);

// 扫描所有技能
const skills = await skillsManager.getSkillsMetadata();
console.log(`Found ${skills.length} skills`);

// 加载特定技能内容
const skillContent = await skillsManager.loadSkillContent('skill-name');
if (skillContent) {
  console.log('Metadata:', skillContent.metadata);
  console.log('Content:', skillContent.content);
  console.log('References:', skillContent.references);
  console.log('Scripts:', skillContent.scripts);
}
```

### 热更新机制

SkillsManager 每次调用都会重新扫描文件系统，确保数据最新：

```typescript
await skillsManager.getSkillsMetadata();  // 扫描1
// ... 修改文件 ...
await skillsManager.getSkillsMetadata();  // 扫描2，获取最新数据
```

### 白名单过滤

通过白名单机制，可以限制 Agent 只加载特定技能：

```typescript
// 只加载白名单中的技能
const manager = new SkillsManager('./.skills', ['allowed-skill-1', 'allowed-skill-2']);
const skills = await manager.getSkillsMetadata();
// 只返回白名单中的技能

// 特殊配置：加载所有技能
const managerAll = new SkillsManager('./.skills', ['*']);

// 特殊配置：完全禁用技能功能
const managerDisabled = new SkillsManager('./.skills', ['/*/']);
```

---

## SkillsManagementManager（管理操作）

SkillsManagementManager 提供技能的完整管理操作，包括安装、导入、导出、归档等。

### 基本操作

```typescript
import { SkillsManagementManager } from '@shareai-lab/kode-sdk';

const manager = new SkillsManagementManager('./.skills');

// 列出所有在线技能
const skills = await manager.listSkills();

// 列出已归档技能
const archived = await manager.listArchivedSkills();
```

### 技能安装与导入

```typescript
// 安装技能（从 GitHub 仓库、Git URL 或在线技能库）
await manager.installSkill('github:user/repo');

// 导入技能（从 zip 文件）
await manager.importSkill('/path/to/skill.zip');
```

### 技能复制、重命名与归档

```typescript
// 复制技能（自动添加随机后缀）
const newSkillName = await manager.copySkill('skill-name');

// 重命名技能
await manager.renameSkill('old-name', 'new-name');

// 归档技能（移动到 .archived 目录）
await manager.archiveSkill('skill-name');

// 恢复已归档技能
await manager.unarchiveSkill('archived-skill-abc12345');
```

### 查看技能内容与结构

```typescript
// 查看在线技能内容（SKILL.md 完整内容）
const content = await manager.getOnlineSkillContent('skill-name');

// 查看归档技能内容
const archivedContent = await manager.getArchivedSkillContent('archived-skill-abc12345');

// 获取在线技能文件目录结构
const structure = await manager.getOnlineSkillStructure('skill-name');

// 获取归档技能文件目录结构
const archivedStructure = await manager.getArchivedSkillStructure('archived-skill-abc12345');
```

### 导出技能

```typescript
// 导出在线技能到 zip 文件
const zipPath = await manager.exportSkill('skill-name', false);

// 导出归档技能到 zip 文件
const archivedZipPath = await manager.exportSkill('archived-skill-abc12345', true);
```

---

## Agent 集成

### 注册 Skills 工具

```typescript
import { Agent, createSkillsTool, SkillsManager } from '@shareai-lab/kode-sdk';

const deps = createDependencies();

// 创建 Skills 管理器（默认使用 .skills 目录）
const skillsManager = new SkillsManager('./.skills');

// 注册 Skills 工具
const skillsTool = createSkillsTool(skillsManager);
deps.toolRegistry.register('skills', () => skillsTool);

// 创建 Agent
const agent = await Agent.create({
  templateId: 'my-agent',
  tools: ['skills', 'fs_read', 'fs_write'],
}, deps);
```

### Skills 工具使用

Agent 可以通过 `skills` 工具动态加载技能：

```
用户: 我需要处理代码格式化

Agent: 我来加载代码格式化技能。

[调用 skills 工具，action=load, skill_name=code-formatter]

Agent: 已加载代码格式化技能。现在我可以帮你格式化代码了。
```

---

## 最佳实践

### 1. 技能设计原则

- **单一职责**：每个技能只做一件事
- **可组合**：技能之间可以互相调用
- **文档完整**：提供清晰的使用说明
- **版本控制**：使用语义化版本号

### 2. 白名单管理

```typescript
// 生产环境：使用白名单限制加载的技能
const allowedSkills = ['safe-skill-1', 'safe-skill-2'];
const manager = new SkillsManager('./.skills', allowedSkills);

// 开发环境：加载所有技能
const devManager = new SkillsManager('./.skills', ['*']);

// 生产环境：完全禁用技能功能
const disabledManager = new SkillsManager('./.skills', ['/*/']);
```

### 3. 错误处理

```typescript
const content = await skillsManager.loadSkillContent('skill-name');
if (!content) {
  console.error('技能未找到或加载失败');
  // 降级处理
}
```

---

## 监控

### Monitor 事件

```typescript
// 监听技能工具调用
agent.on('tool_executed', (event) => {
  if (event.call.name === 'skills') {
    console.log('加载技能:', event.call.input.skill_name);
  }
});

// 监听工具说明书更新
agent.on('tool_manual_updated', (event) => {
  console.log('工具说明书更新:', event.tools);
});
```

---

## 故障排除

### 常见问题

**技能未找到**
- 检查技能目录路径是否正确
- 确认 SKILL.md 文件存在
- 检查白名单配置

**热更新不生效**
- 确认文件保存成功
- 检查文件系统权限
- 查看日志确认扫描时间

**沙箱权限错误**
- 检查沙箱工作目录配置
- 确认文件路径在允许范围内
- 查看沙箱日志

### 调试技巧

```typescript
// 启用详细日志
process.env.LOG_LEVEL = 'debug';

// 检查技能元数据
console.log(JSON.stringify(skills, null, 2));

// 验证技能目录
const fs = require('fs');
console.log(fs.readdirSync('./skills'));
```

---

## 参考资料

- [工具系统指南](./tools.md)
- [事件系统指南](./events.md)
- [API 参考](../reference/api.md)
