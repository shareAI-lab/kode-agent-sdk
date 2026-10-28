const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');

function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? files(file) : [file];
  });
}

const program = ts.createProgram([path.join(root, 'src/index.ts')], { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS });
const checker = program.getTypeChecker();
const moduleSymbol = checker.getSymbolAtLocation(program.getSourceFile(path.join(root, 'src/index.ts')));
const exportsSet = new Set(checker.getExportsOfModule(moduleSymbol).map((symbol) => symbol.name));
const configSymbol = checker.getExportsOfModule(moduleSymbol).find((symbol) => symbol.name === 'AgentConfig');
const configProperties = new Set(checker.getDeclaredTypeOfSymbol(configSymbol).getProperties().map((symbol) => symbol.name));
const docs = ['README.md', 'README.zh-CN.md', 'examples/README.md', 'examples/README.en.md',
  ...files(path.join(root, 'docs')).filter((file) => file.endsWith('.md')).map((file) => path.relative(root, file))];
let checkedBlocks = 0;
const runnable = [];
for (const file of docs) {
  const content = fs.readFileSync(path.join(root, file), 'utf8');
  const complete = content.match(/<!-- runnable:getting-started -->\s*```typescript\n([\s\S]*?)\n```/);
  if (complete) runnable.push(complete[1]);
  for (const match of content.matchAll(/```(?:ts|typescript)\n([\s\S]*?)\n```/g)) {
    const source = ts.createSourceFile(file, match[1], ts.ScriptTarget.Latest, true);
    checkedBlocks++;
    function visit(node) {
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'Agent.create') {
        assert.equal(node.arguments.length, 2, `${file}: Agent.create requires config and deps`);
        if (ts.isObjectLiteralExpression(node.arguments[0])) {
          for (const property of node.arguments[0].properties) {
            if (ts.isSpreadAssignment(property) || !property.name) continue;
            const name = property.name.getText(source).replace(/^['"]|['"]$/g, '');
            assert.ok(configProperties.has(name), `${file}: unknown AgentConfig field ${name}`);
          }
        }
      }
      if (ts.isCallExpression(node) && ['createStore', 'createExtendedStore'].includes(node.expression.getText(source))) {
        assert.equal(node.arguments.length, 1, `${file}: store factories require an explicit configuration`);
      }
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'pool.destroy') {
        assert.fail(`${file}: AgentPool has no destroy(); distinguish shutdown from deleting persisted sessions`);
      }
      if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'modelConfig' && ts.isObjectLiteralExpression(node.initializer)) {
        assert.ok(node.initializer.properties.some((property) => ts.isSpreadAssignment(property) || property.name?.getText(source) === 'model'), `${file}: modelConfig requires model`);
      }
      if (ts.isImportDeclaration(node) && node.moduleSpecifier.text === '@shareai-lab/kode-sdk') {
        const bindings = node.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const name of bindings.elements) {
            assert.ok(exportsSet.has((name.propertyName || name.name).text), `${file}: missing public export ${(name.propertyName || name.name).text}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
}
assert.equal(runnable.length, 4, 'Expected four complete getting-started examples');
for (const snippet of runnable) assert.equal(snippet, runnable[0], 'Getting-started examples drifted');
for (const directory of ['', 'examples']) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, directory, 'package.json'), 'utf8'));
  for (const [name, command] of Object.entries(pkg.scripts)) {
    const target = command.match(/ts-node(?: --project \S+)?\s+(\S+\.ts)/)?.[1];
    if (target) assert.ok(fs.existsSync(path.resolve(root, directory, target)), `Missing script target ${directory}:${name}`);
  }
}
console.log(`Statically audited ${checkedBlocks} TypeScript documentation blocks for API shape/imports and checked script targets. Four complete examples match; test:package compiles and runs their shared flow. Partial snippets are not all typechecked.`);
