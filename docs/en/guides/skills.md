# Skills System Guide

KODE SDK provides a complete Skills system supporting modular, reusable capability units that allow Agents to dynamically load and execute specific skills.

> **⚠️ Breaking Changes**
>
> **Default Skills directory has changed from `skills/` to `.skills/`**
>
> - If you haven't set the `SKILLS_DIR` environment variable, SkillsManager now uses `.skills/` as the default directory
> - **Impact**: All code that doesn't explicitly specify the skills directory path
> - **Migration options**:
>   - Option 1: Rename your existing `skills/` directory to `.skills/`
>   - Option 2: Set environment variable `SKILLS_DIR` to the original directory (e.g., `export SKILLS_DIR=./skills`)
>   - Option 3: Explicitly specify the path in code: `new SkillsManager('./skills')`

---

## Core Features

| Feature | Description |
|---------|-------------|
| **Hot Reload** | Skills auto-reload when code changes |
| **Metadata Injection** | Auto-inject skill descriptions into system prompt |
| **Sandbox Isolation** | Each skill has independent file system space |
| **Whitelist Filter** | Selectively load specific skills, supports `["/*/"]` (fully disabled) and `["*"]` (load all) special configs |

---

## Directory Structure

```
.skills/
├── skill-name/              # Skill directory
│   ├── SKILL.md            # Skill definition (required)
│   ├── metadata.json       # Skill metadata (optional)
│   ├── references/         # Reference documents
│   ├── scripts/            # Executable scripts
│   └── assets/             # Static resources
└── .archived/              # Archived skills
    └── archived-skill/
```

### SKILL.md Format

```markdown
<!-- skill: skill-name -->
<!-- version: 1.0.0 -->
<!-- author: Your Name -->

# Skill Name

Brief description of the skill's functionality.

## Use Cases

- Case 1
- Case 2

## Usage Guide

Detailed instructions for using this skill...
```

### metadata.json Format

```json
{
  "name": "skill-name",
  "description": "Skill description",
  "version": "1.0.0",
  "author": "Author",
  "baseDir": "/path/to/skill"
}
```

---

## Environment Variables

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

## SkillsManager (Agent Runtime)

SkillsManager is used at Agent runtime for hot updates and dynamic loading.

### Basic Usage

```typescript
import { SkillsManager } from '@shareai-lab/kode-sdk';

// Create Skills manager
const skillsManager = new SkillsManager(
  './.skills',          // Skills directory path (default is .skills)
  ['skill1', 'skill2']  // Optional: whitelist
);

// Scan all skills
const skills = await skillsManager.getSkillsMetadata();
console.log(`Found ${skills.length} skills`);

// Load specific skill content
const skillContent = await skillsManager.loadSkillContent('skill-name');
if (skillContent) {
  console.log('Metadata:', skillContent.metadata);
  console.log('Content:', skillContent.content);
  console.log('References:', skillContent.references);
  console.log('Scripts:', skillContent.scripts);
}
```

### Hot Reload

SkillsManager rescans the file system on each call to ensure fresh data:

```typescript
await skillsManager.getSkillsMetadata();  // Scan 1
// ... modify files ...
await skillsManager.getSkillsMetadata();  // Scan 2, gets latest data
```

### Whitelist Filtering

Limit Agent to only load specific skills:

```typescript
// Only load whitelisted skills
const manager = new SkillsManager('./.skills', ['allowed-skill-1', 'allowed-skill-2']);
const skills = await manager.getSkillsMetadata();
// Returns only whitelisted skills

// Special config: load all skills
const managerAll = new SkillsManager('./.skills', ['*']);

// Special config: fully disable skills feature
const managerDisabled = new SkillsManager('./.skills', ['/*/']);
```

---

## SkillsManagementManager (Management Operations)

SkillsManagementManager provides complete skill management operations including install, import, export, archive, and more.

### Basic Operations

```typescript
import { SkillsManagementManager } from '@shareai-lab/kode-sdk';

const manager = new SkillsManagementManager('./.skills');

// List all online skills
const skills = await manager.listSkills();

// List archived skills
const archived = await manager.listArchivedSkills();
```

### Skill Install & Import

```typescript
// Install skill (from GitHub repo, Git URL, or online skill library)
await manager.installSkill('github:user/repo');

// Import skill (from zip file)
await manager.importSkill('/path/to/skill.zip');
```

### Skill Copy, Rename & Archive

```typescript
// Copy skill (auto-add random suffix)
const newSkillName = await manager.copySkill('skill-name');

// Rename skill
await manager.renameSkill('old-name', 'new-name');

// Archive skill (move to .archived directory)
await manager.archiveSkill('skill-name');

// Restore archived skill
await manager.unarchiveSkill('archived-skill-abc12345');
```

### View Skill Content & Structure

```typescript
// View online skill content (complete SKILL.md)
const content = await manager.getOnlineSkillContent('skill-name');

// View archived skill content
const archivedContent = await manager.getArchivedSkillContent('archived-skill-abc12345');

// Get online skill file directory structure
const structure = await manager.getOnlineSkillStructure('skill-name');

// Get archived skill file directory structure
const archivedStructure = await manager.getArchivedSkillStructure('archived-skill-abc12345');
```

### Export Skills

```typescript
// Export online skill to zip file
const zipPath = await manager.exportSkill('skill-name', false);

// Export archived skill to zip file
const archivedZipPath = await manager.exportSkill('archived-skill-abc12345', true);
```

---

## Agent Integration

### Register Skills Tool

```typescript
import { Agent, createSkillsTool, SkillsManager } from '@shareai-lab/kode-sdk';

const deps = createDependencies();

// Create Skills manager (default uses .skills directory)
const skillsManager = new SkillsManager('./.skills');

// Register Skills tool
const skillsTool = createSkillsTool(skillsManager);
deps.toolRegistry.register('skills', () => skillsTool);

// Create Agent
const agent = await Agent.create({
  templateId: 'my-agent',
  tools: ['skills', 'fs_read', 'fs_write'],
}, deps);
```

### Skills Tool Usage

Agent can dynamically load skills via the `skills` tool:

```
User: I need to format code

Agent: Let me load the code formatting skill.

[Calls skills tool, action=load, skill_name=code-formatter]

Agent: Code formatting skill loaded. Now I can help you format code.
```

---

## Best Practices

### 1. Skill Design Principles

- **Single Responsibility**: Each skill does one thing
- **Composable**: Skills can call each other
- **Well Documented**: Provide clear usage instructions
- **Version Control**: Use semantic versioning

### 2. Whitelist Management

```typescript
// Production: use whitelist to limit loaded skills
const allowedSkills = ['safe-skill-1', 'safe-skill-2'];
const manager = new SkillsManager('./.skills', allowedSkills);

// Development: load all skills
const devManager = new SkillsManager('./.skills', ['*']);

// Production: fully disable skills feature
const disabledManager = new SkillsManager('./.skills', ['/*/']);
```

### 3. Error Handling

```typescript
const content = await skillsManager.loadSkillContent('skill-name');
if (!content) {
  console.error('Skill not found or failed to load');
  // Fallback handling
}
```

---

## Monitoring

### Monitor Events

```typescript
// Listen to skill tool calls
agent.on('tool_executed', (event) => {
  if (event.call.name === 'skills') {
    console.log('Skill loaded:', event.call.input.skill_name);
  }
});

// Listen to tool manual updates
agent.on('tool_manual_updated', (event) => {
  console.log('Tools manual updated:', event.tools);
});
```

---

## Troubleshooting

### Common Issues

**Skill not found**
- Check skills directory path
- Confirm SKILL.md file exists
- Check whitelist configuration

**Hot reload not working**
- Confirm file saved successfully
- Check file system permissions
- Review logs for scan timing

**Sandbox permission error**
- Check sandbox work directory configuration
- Confirm file path is within allowed range
- Check sandbox logs

### Debug Tips

```typescript
// Enable verbose logging
process.env.LOG_LEVEL = 'debug';

// Check skill metadata
console.log(JSON.stringify(skills, null, 2));

// Verify skills directory
const fs = require('fs');
console.log(fs.readdirSync('./skills'));
```

---

## References

- [Tools Guide](./tools.md)
- [Events Guide](./events.md)
- [API Reference](../reference/api.md)
