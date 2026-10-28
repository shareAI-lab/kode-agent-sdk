const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-package-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const native = process.argv.includes('--native');
const docs = ['README.md', 'README.zh-CN.md', 'docs/en/getting-started/quickstart.md', 'docs/zh-CN/getting-started/quickstart.md'];
const snippets = docs.map((file) => {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const match = source.match(/<!-- runnable:getting-started -->\s*```typescript\n([\s\S]*?)\n```/);
  assert.ok(match, `Missing runnable example: ${file}`);
  return match[1];
});
for (let index = 1; index < snippets.length; index++) {
  assert.equal(snippets[index], snippets[0], `Getting-started example drifted: ${docs[index]}`);
}


const resumeDocs = ['docs/en/guides/resume-fork.md', 'docs/zh-CN/guides/resume-fork.md'];
const resumeSnippets = resumeDocs.map(file => {
  const match = fs.readFileSync(path.join(root, file), 'utf8').match(/<!-- runnable:resume-helper -->\s*```typescript\n([\s\S]*?)\n```/);
  assert.ok(match, `Missing resume helper: ${file}`);
  return match[1];
});
assert.equal(resumeSnippets[0], resumeSnippets[1], 'Bilingual resume helpers drifted');

try {
  const packed = JSON.parse(execFileSync(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', temp], {
    cwd: root, encoding: 'utf8', env: { ...process.env, npm_config_cache: path.join(temp, 'cache') },
  }))[0];
  assert.ok(packed.files.some((file) => file.path === 'dist/index.js'));
  assert.ok(packed.files.some((file) => file.path === 'dist/index.d.ts'));
  assert.ok(!packed.files.some((file) => file.path.startsWith('src/')));
  const consumer = path.join(temp, 'consumer');
  fs.mkdirSync(consumer);
  const sourcePackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const dependencies = { [sourcePackage.name]: `file:${path.join(temp, packed.filename)}` };
  const devDependencies = { ...sourcePackage.devDependencies };
  delete devDependencies[sourcePackage.name];
  const manifest = { name: 'kode-packed-consumer', version: '1.0.0', private: true, dependencies, devDependencies };
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  lock.name = manifest.name;
  lock.version = manifest.version;
  lock.packages[''] = manifest;
  lock.packages[`node_modules/${sourcePackage.name}`] = {
    version: sourcePackage.version, resolved: dependencies[sourcePackage.name], integrity: packed.integrity,
    dependencies: sourcePackage.dependencies, engines: sourcePackage.engines,
  };
  fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(consumer, 'package-lock.json'), JSON.stringify(lock, null, 2));
  execFileSync(npm, ['ci', '--offline', ...(native ? [] : ['--ignore-scripts']), '--no-audit', '--no-fund'], { cwd: consumer, stdio: 'inherit' });
  if (native) {
    fs.writeFileSync(path.join(consumer, 'check-native.cjs'), `const assert = require('node:assert/strict');
const { SqliteStore } = require('@shareai-lab/kode-sdk');
(async () => {
  const store = new SqliteStore('./consumer.sqlite', './consumer-files');
  try { assert.equal((await store.healthCheck()).healthy, true); }
  finally { await store.close(); }
  console.log('Packed SDK native SqliteStore initialized, healthy and closed');
})().catch(error => { console.error(error); process.exitCode = 1; });
`);
    execFileSync(process.execPath, ['check-native.cjs'], { cwd: consumer, stdio: 'inherit', timeout: 10000 });
  }
  fs.writeFileSync(path.join(consumer, 'check.cjs'), `const assert = require('node:assert/strict');
const sdk = require('@shareai-lab/kode-sdk');
for (const name of ['Agent', 'JSONStore', 'LocalSandbox', 'SandboxFactory', 'AnthropicProvider', 'SqliteStore', 'PostgresStore']) assert.equal(typeof sdk[name], 'function', name);
assert.equal(require('@shareai-lab/kode-sdk/dist/core/agent').Agent, sdk.Agent);
assert.equal(require('@shareai-lab/kode-sdk/dist/core/agent.js').Agent, sdk.Agent);
assert.equal(typeof require('@shareai-lab/kode-sdk/dist/infra/providers').OpenAIProvider, 'function');
`);
  fs.writeFileSync(path.join(consumer, 'check.mjs'), `import { Agent, JSONStore } from '@shareai-lab/kode-sdk';
import assert from 'node:assert/strict';
assert.equal(typeof Agent.create, 'function');
assert.equal(typeof JSONStore, 'function');
`);
  fs.writeFileSync(path.join(consumer, 'getting-started.ts'), snippets[0]);
  fs.writeFileSync(path.join(consumer, 'resume-helper.ts'), resumeSnippets[0]);
  execFileSync(process.execPath, ['check.cjs'], { cwd: consumer, stdio: 'inherit' });
  execFileSync(process.execPath, ['check.mjs'], { cwd: consumer, stdio: 'inherit' });
  execFileSync(process.execPath, [path.join(consumer, 'node_modules/typescript/bin/tsc'), '--strict', '--skipLibCheck',
    '--target', 'ES2020', '--module', 'Node16', '--moduleResolution', 'node16', 'getting-started.ts', 'resume-helper.ts'], { cwd: consumer, stdio: 'inherit' });
  fs.writeFileSync(path.join(consumer, 'run-doc.cjs'), `const Module = require('node:module');
const sdk = require('@shareai-lab/kode-sdk');
const load = Module._load;
class DocMock {
  model = 'offline'; maxWindowSize = 200000; maxOutputTokens = 128; temperature = 0;
  toConfig() { return { provider: 'mock', model: this.model }; }
  async complete() { return { role: 'assistant', content: [{ type: 'text', text: 'DOC_OK' }] }; }
  async *stream() {
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'DOC_OK' } };
    yield { type: 'content_block_stop', index: 0 };
  }
}
Module._load = function(name, ...args) { return name === '@shareai-lab/kode-sdk' ? { ...sdk, AnthropicProvider: DocMock } : load.call(this, name, ...args); };
globalThis.fetch = async () => { throw new Error('Live fetch is disabled in the packed documentation check'); };
process.env.ANTHROPIC_API_KEY = 'offline-placeholder';
require('./getting-started.js');
`);
  const output = execFileSync(process.execPath, ['run-doc.cjs'], { cwd: consumer, encoding: 'utf8', timeout: 10000 });
  assert.equal(output.trim(), 'DOC_OK');

  fs.writeFileSync(path.join(consumer, 'run-resume.cjs'), `const assert = require('node:assert/strict');
const sdk = require('@shareai-lab/kode-sdk');
const { resumeOneTurn } = require('./resume-helper.js');
class ResumeModel {
  model = 'offline-resume'; maxWindowSize = 200000; maxOutputTokens = 128; temperature = 0;
  toConfig() { return { provider: 'mock', model: this.model }; }
  async complete() { return { role: 'assistant', content: [{ type: 'text', text: 'RESUME_DOC_OK' }] }; }
  async *stream() {
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'RESUME_DOC_OK' } };
    yield { type: 'content_block_stop', index: 0 };
  }
}
globalThis.fetch = async () => { throw new Error('Live fetch is disabled in resume documentation check'); };
(async () => {
  const store = new sdk.JSONStore('./resume-store');
  const sandbox = new sdk.LocalSandbox({ workDir: './resume-workspace', watchFiles: false });
  const templates = new sdk.AgentTemplateRegistry();
  templates.register({ id: 'resume-doc', systemPrompt: 'Offline documentation test' });
  const deps = { store, templateRegistry: templates, toolRegistry: new sdk.ToolRegistry(), sandboxFactory: new sdk.SandboxFactory(), modelFactory: () => new ResumeModel() };
  let id;
  try {
    const agent = await sdk.Agent.create({ templateId: 'resume-doc', model: new ResumeModel(), sandbox }, deps);
    await agent.chat('first'); id = agent.agentId;
  } finally { await sandbox.dispose(); }
  assert.equal(await resumeOneTurn(id, deps, './resume-workspace', 'continue'), 'RESUME_DOC_OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
`);
  const resumeOutput = execFileSync(process.execPath, ['run-resume.cjs'], { cwd: consumer, encoding: 'utf8', timeout: 10000 });
  assert.equal(resumeOutput.trim(), 'RESUME_DOC_OK');

  console.log('Fresh tarball installation, CJS/ESM/deep imports, getting-started/resume helper types and exact documentation flows with mock providers passed. ' +
    (native ? 'Native consumer installation and SqliteStore health/close passed.' : 'Native install scripts are disabled; use --native after populating the dependency and native binary/build caches.'));
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
