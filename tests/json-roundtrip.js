const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const source = fs.readFileSync('src/app.js', 'utf8');
const start = source.indexOf('const EXPR_OPERATORS');
const end = source.indexOf('\nfunction find(targetId', start);
if (start < 0 || end < 0) throw new Error('Schema functions not found');

const schemaSource = source.slice(start, end)
  .replace(/function normalizeWorkflow[\s\S]*?function workflowForSave\([\s\S]*?\n}\n/g, '');

const context = {
  JSON, Math, String, Number, Array, Object, console,
  deepClone: value => JSON.parse(JSON.stringify(value)),
};
vm.createContext(context);
vm.runInContext(schemaSource + '\nthis.migrateBlock=migrateBlock;this.migrateCondition=migrateCondition;', context);

const workflow = {
  version: 7,
  name: 'Round-trip',
  blocks: [
    {
      id: 'wait', type: 'wait',
      duration: {kind: 'literal', value: 2.75}, unit: 's',
    },
    {
      id: 'wait-window', type: 'wait-window', targetMode: 'process',
      title: {kind: 'literal', value: 'Titre'},
      processName: {kind: 'literal', value: 'chrome'},
      timeout: {kind: 'literal', value: 12}, timeoutUnit: 's',
      interval: {kind: 'literal', value: 317},
    },
    {
      id: 'hotkey', type: 'keyboard-hotkey',
      modifiers: ['CTRL', 'ALT', 'SHIFT'], key: 'F8',
    },
    {
      id: 'change', type: 'change-variable', name: 'compteur',
      amount: {kind: 'binary', op: '*', left: {kind: 'literal', value: 3}, right: {kind: 'literal', value: 4}},
    },
    {
      id: 'if', type: 'if',
      condition: {kind: 'keyboard', mode: 'wait', modifiers: ['CTRL', '', ''], key: 'K'},
      then: [{id: 'nested', type: 'wait', duration: {kind: 'literal', value: 123}, unit: 'ms'}],
      else: [],
    },
  ],
};

const roundTripped = {
  version: 7,
  name: workflow.name,
  blocks: workflow.blocks.map(context.migrateBlock),
};

assert.strictEqual(JSON.stringify(roundTripped), JSON.stringify(workflow));

const legacy = {
  version: 5,
  name: 'Legacy',
  blocks: [
    {id: 'legacy-wait', type: 'wait', ms: 2500},
    {id: 'legacy-hotkey', type: 'keyboard-hotkey', keys: ['CTRL', 'ALT', 'S']},
  ],
};
const migratedLegacy = legacy.blocks.map(context.migrateBlock);
assert.strictEqual(migratedLegacy[0].duration.value, 2500);
assert.strictEqual(migratedLegacy[0].unit, 'ms');
assert.strictEqual(JSON.stringify(migratedLegacy[1].modifiers), JSON.stringify(['CTRL', 'ALT', '']));
assert.strictEqual(migratedLegacy[1].key, 'S');

console.log('JSON round-trip tests: OK');
