const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, chmodSync, rmSync, readFileSync, realpathSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');

function runSetup({ installExit = 0, buildExit = 0, supportedNode = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'kode-quickstart-'));
  const repo = path.join(root, 'repo with spaces');
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'calls');
  mkdirSync(repo);
  mkdirSync(bin);
  copyFileSync(path.resolve(__dirname, '../quickstart.sh'), path.join(repo, 'quickstart.sh'));
  writeFileSync(path.join(bin, 'node'), `#!/bin/bash\nexit ${supportedNode ? 0 : 1}\n`);
  writeFileSync(path.join(bin, 'npm'), `#!/bin/bash\nprintf '%s:%s\\n' "$PWD" "$*" >> "$SETUP_LOG"\nif [ "$1" = ci ]; then exit ${installExit}; fi\nexit ${buildExit}\n`);
  chmodSync(path.join(bin, 'node'), 0o755);
  chmodSync(path.join(bin, 'npm'), 0o755);
  try {
    const result = spawnSync('/bin/bash', [path.join(repo, 'quickstart.sh')], {
      cwd: root,
      env: { PATH: `${bin}:/usr/bin:/bin`, SETUP_LOG: log },
      encoding: 'utf8',
      timeout: 5000,
    });
    let calls = '';
    try { calls = readFileSync(log, 'utf8'); } catch {}
    return { ...result, calls, repo };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('setup runs from its own directory and offers a no-key first request', () => {
  const result = runSetup();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls, `${result.repo}:ci\n${result.repo}:run build\n`);
  assert.match(result.stdout, /--mock/);
});

test('failed installation stops before build and success output', () => {
  const result = runSetup({ installExit: 17 });
  assert.equal(result.status, 17);
  assert.equal(result.calls, `${result.repo}:ci\n`);
  assert.doesNotMatch(result.stdout, /SDK is ready/);
});

test('failed build is reported as failure', () => {
  const result = runSetup({ buildExit: 19 });
  assert.equal(result.status, 19);
  assert.doesNotMatch(result.stdout, /SDK is ready/);
});

test('unsupported Node version stops before dependency installation', () => {
  const result = runSetup({ supportedNode: false });
  assert.equal(result.status, 1);
  assert.equal(result.calls, '');
  assert.match(result.stdout, /20\.18\.1/);
});

test('package metadata preserves root, file and directory entry resolution', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kode-package-resolution-'));
  const pkg = path.join(dir, 'node_modules/@shareai-lab/kode-sdk');
  try {
    mkdirSync(path.join(pkg, 'dist/core'), { recursive: true });
    mkdirSync(path.join(pkg, 'dist/infra/providers'), { recursive: true });
    copyFileSync(path.resolve(__dirname, '../package.json'), path.join(pkg, 'package.json'));
    for (const file of ['dist/index.js', 'dist/core/agent.js', 'dist/infra/providers/index.js']) {
      writeFileSync(path.join(pkg, file), 'module.exports = {};');
    }
    const resolve = createRequire(path.join(dir, 'consumer.cjs')).resolve;
    for (const [specifier, target] of [
      ['@shareai-lab/kode-sdk', 'dist/index.js'],
      ['@shareai-lab/kode-sdk/dist/core/agent', 'dist/core/agent.js'],
      ['@shareai-lab/kode-sdk/dist/core/agent.js', 'dist/core/agent.js'],
      ['@shareai-lab/kode-sdk/dist/infra/providers', 'dist/infra/providers/index.js'],
    ]) {
      assert.equal(resolve(specifier), realpathSync(path.join(pkg, target)));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
