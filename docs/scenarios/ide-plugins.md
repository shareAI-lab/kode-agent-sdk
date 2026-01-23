# Scenario: IDE Plugins

> Build VSCode, JetBrains, or other IDE extensions with AI coding assistants.

---

## Why IDE Plugins Work Well

| Feature | Benefit |
|---------|---------|
| Extension host process | Long-running, like desktop |
| workspace.fs API | File operations available |
| Single user context | No multi-tenancy |
| Rich UI integration | WebView for chat, decorations for highlights |

**Compatibility: 85%** - Requires workspace.fs integration.

---

## VSCode Extension

### Extension Activation

```typescript
// src/extension.ts
import * as vscode from 'vscode';
import { Agent, AgentPool, AnthropicProvider } from '@anthropic/kode-sdk';
import { VSCodeSandbox } from './vscode-sandbox';
import { VSCodeStore } from './vscode-store';

let pool: AgentPool;

export async function activate(context: vscode.ExtensionContext) {
  // Store in extension's global storage
  const store = new VSCodeStore(context.globalStorageUri);
  pool = new AgentPool({ store, maxAgents: 5 });

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('myExtension.startChat', startChat),
    vscode.commands.registerCommand('myExtension.explainCode', explainCode),
    vscode.commands.registerCommand('myExtension.refactor', refactorCode),
  );

  // Create chat webview panel provider
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('myExtension.chatView', new ChatViewProvider(pool))
  );
}

export async function deactivate() {
  // Save all agents before deactivation
  for (const [id, agent] of pool.agents) {
    await agent.persistInfo();
  }
}
```

### VSCode-Specific Sandbox

```typescript
// src/vscode-sandbox.ts
import * as vscode from 'vscode';
import { Sandbox, SandboxConfig } from '@anthropic/kode-sdk';

export class VSCodeSandbox implements Sandbox {
  private workspaceFolder: vscode.WorkspaceFolder;

  constructor(workspaceFolder: vscode.WorkspaceFolder) {
    this.workspaceFolder = workspaceFolder;
  }

  async readFile(relativePath: string): Promise<string> {
    const uri = vscode.Uri.joinPath(this.workspaceFolder.uri, relativePath);
    const content = await vscode.workspace.fs.readFile(uri);
    return new TextDecoder().decode(content);
  }

  async writeFile(relativePath: string, content: string): Promise<void> {
    const uri = vscode.Uri.joinPath(this.workspaceFolder.uri, relativePath);
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
  }

  async listFiles(pattern: string): Promise<string[]> {
    const files = await vscode.workspace.findFiles(pattern);
    return files.map(f => vscode.workspace.asRelativePath(f));
  }

  async executeCommand(command: string): Promise<{ stdout: string; stderr: string }> {
    // Use VSCode's terminal API for command execution
    const terminal = vscode.window.createTerminal({
      name: 'Agent Command',
      cwd: this.workspaceFolder.uri,
    });

    // Note: VSCode terminal doesn't return output directly
    // Consider using child_process if extension has Node.js access
    terminal.sendText(command);

    return { stdout: 'Command sent to terminal', stderr: '' };
  }
}
```

### VSCode-Specific Store

```typescript
// src/vscode-store.ts
import * as vscode from 'vscode';
import { Store, Message, AgentInfo } from '@anthropic/kode-sdk';

export class VSCodeStore implements Store {
  constructor(private storageUri: vscode.Uri) {}

  private getAgentUri(agentId: string, file: string): vscode.Uri {
    return vscode.Uri.joinPath(this.storageUri, agentId, file);
  }

  async saveMessages(agentId: string, messages: Message[]): Promise<void> {
    const uri = this.getAgentUri(agentId, 'messages.json');
    const content = JSON.stringify(messages, null, 2);
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
  }

  async loadMessages(agentId: string): Promise<Message[]> {
    try {
      const uri = this.getAgentUri(agentId, 'messages.json');
      const content = await vscode.workspace.fs.readFile(uri);
      return JSON.parse(new TextDecoder().decode(content));
    } catch {
      return [];
    }
  }

  // ... implement other Store methods
}
```

### Chat WebView

```typescript
// src/chat-view-provider.ts
import * as vscode from 'vscode';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  constructor(private pool: AgentPool) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.getHtmlContent();

    // Handle messages from webview
    webviewView.webview.onDidReceiveMessage(async (message) => {
      if (message.type === 'chat') {
        const agent = await this.getOrCreateAgent();

        // Stream responses to webview
        agent.subscribeProgress({ kinds: ['text_chunk'] }, (event) => {
          webviewView.webview.postMessage({
            type: 'text_chunk',
            text: event.text,
          });
        });

        await agent.chat(message.text);

        webviewView.webview.postMessage({ type: 'done' });
      }
    });
  }

  private getHtmlContent(): string {
    return `<!DOCTYPE html>
    <html>
      <head>
        <style>
          /* Chat UI styles */
        </style>
      </head>
      <body>
        <div id="chat-container"></div>
        <input id="input" type="text" placeholder="Ask about the code...">
        <script>
          const vscode = acquireVsCodeApi();

          document.getElementById('input').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
              vscode.postMessage({ type: 'chat', text: e.target.value });
              e.target.value = '';
            }
          });

          window.addEventListener('message', (e) => {
            if (e.data.type === 'text_chunk') {
              // Append to chat
            }
          });
        </script>
      </body>
    </html>`;
  }
}
```

---

## Context-Aware Coding Assistant

```typescript
// Provide code context to the agent
async function explainCode() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const selection = editor.selection;
  const selectedText = editor.document.getText(selection);
  const fileName = editor.document.fileName;
  const languageId = editor.document.languageId;

  const agent = await getOrCreateAgent();

  // Include file context
  const context = `
File: ${fileName}
Language: ${languageId}

Selected code:
\`\`\`${languageId}
${selectedText}
\`\`\`
`;

  await agent.chat(`Explain this code:\n${context}`);
}

// Inline code actions
async function refactorCode() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const selection = editor.selection;
  const selectedText = editor.document.getText(selection);

  const agent = await getOrCreateAgent();

  // Custom tool to apply edits
  agent.registerTool({
    name: 'apply_edit',
    description: 'Replace the selected code with improved version',
    parameters: {
      type: 'object',
      properties: {
        newCode: { type: 'string', description: 'The refactored code' },
      },
      required: ['newCode'],
    },
    execute: async ({ newCode }) => {
      await editor.edit(editBuilder => {
        editBuilder.replace(selection, newCode);
      });
      return 'Code replaced successfully';
    },
  });

  await agent.chat(`Refactor this code to be cleaner and more efficient:\n${selectedText}`);
}
```

---

## JetBrains Plugin (Kotlin)

```kotlin
// For JetBrains, run KODE SDK as a sidecar Node.js process
// and communicate via JSON-RPC or WebSocket

class AgentService(private val project: Project) {
    private var process: Process? = null

    fun start() {
        val nodeScript = PluginUtil.getPluginPath() + "/agent-runtime/index.js"
        process = ProcessBuilder("node", nodeScript)
            .directory(File(project.basePath))
            .start()

        // Read output
        thread {
            process?.inputStream?.bufferedReader()?.forEachLine { line ->
                handleAgentOutput(line)
            }
        }
    }

    fun sendMessage(message: String) {
        process?.outputStream?.let {
            it.write("$message\n".toByteArray())
            it.flush()
        }
    }
}
```

---

## Best Practices for IDE Plugins

### 1. Workspace-Scoped Agents

```typescript
// One agent per workspace
function getAgentId(workspaceFolder: vscode.WorkspaceFolder): string {
  return `workspace-${hashString(workspaceFolder.uri.toString())}`;
}
```

### 2. Respect User Settings

```typescript
const config = vscode.workspace.getConfiguration('myExtension');
const apiKey = config.get<string>('apiKey');
const modelId = config.get<string>('model') || 'claude-sonnet-4-20250514';
```

### 3. Progress Indication

```typescript
await vscode.window.withProgress({
  location: vscode.ProgressLocation.Notification,
  title: 'AI Assistant',
  cancellable: true,
}, async (progress, token) => {
  token.onCancellationRequested(() => {
    agent.stop();
  });

  progress.report({ message: 'Thinking...' });
  await agent.chat(message);
});
```

### 4. Diagnostic Integration

```typescript
// Show agent suggestions as diagnostics
const diagnosticCollection = vscode.languages.createDiagnosticCollection('ai-suggestions');

agent.subscribeProgress({ kinds: ['suggestion'] }, (event) => {
  const diagnostic = new vscode.Diagnostic(
    new vscode.Range(event.line, 0, event.line, 100),
    event.message,
    vscode.DiagnosticSeverity.Information
  );
  diagnosticCollection.set(editor.document.uri, [diagnostic]);
});
```

---

See [Desktop Apps Guide](./desktop-apps.md) for more patterns that apply to IDE plugins.
