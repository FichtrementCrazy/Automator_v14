const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
const electron = {
  app: { whenReady() { return { then() {} }; }, on() {}, getPath() { return ''; }, quit() {} },
  BrowserWindow: function() {},
  ipcMain: { handle() {} },
  dialog: {},
  shell: {},
};
electron.BrowserWindow.getAllWindows = () => [];
const childProcess = { spawn() {} };
const sandbox = {
  require: name => name === 'electron' ? electron : name === 'child_process' ? childProcess : require(name),
  console, process: { ...process, platform: 'win32' }, Buffer,
  setTimeout, clearTimeout, setInterval, clearInterval,
};
vm.createContext(sandbox);
vm.runInContext(source + '\nthis.__cmd = standaloneCmdContent;', sandbox, { filename: 'main.js' });

const workflow = {
  version: 7,
  name: 'Mon workflow',
  blocks: [
    { id: 'hotkey', type: 'keyboard-hotkey', modifiers: ['WIN', '', ''], key: 'M' },
    { id: 'wait', type: 'wait', duration: { kind: 'literal', value: 100 }, unit: 'ms' },
    {
      id: 'while', type: 'while',
      condition: { kind: 'not', item: { kind: 'keyboard', mode: 'test', modifiers: ['', '', ''], key: 'K' } },
      children: [
        { id: 'click', type: 'mouse-click', button: 'right', x: { kind: 'literal', value: 1035 }, y: { kind: 'literal', value: 334 }, captureMode: 'coords' },
        { id: 'wait2', type: 'wait', duration: { kind: 'literal', value: 100 }, unit: 'ms' },
        { id: 'repeat', type: 'repeat', count: { kind: 'literal', value: 6 }, children: [{ id: 'down', type: 'keyboard-key', key: 'DOWN' }] },
        { id: 'enter', type: 'keyboard-key', key: 'ENTER' },
        { id: 'log', type: 'log', message: { kind: 'literal', value: "Afficher l'arrière plan suivant" } },
        { id: 'wait3', type: 'wait', duration: { kind: 'literal', value: 1 }, unit: 's' },
      ],
    },
    { id: 'stop-log', type: 'log', message: { kind: 'literal', value: 'Stop' } },
  ],
};

const cmd = sandbox.__cmd(workflow);
assert(cmd.includes('## BLOCKFLOW-PS ##'));
assert(cmd.includes('## END-BLOCKFLOW-PS ##'));
assert(!cmd.includes('$args[0]'));
assert(!cmd.includes('ReadAllText($p)'));
assert(!cmd.includes('INPUT::new'));

const startMarker = '## BLOCKFLOW-PS ##\r\n';
const endMarker = '\r\n## END-BLOCKFLOW-PS ##';
const start = cmd.indexOf(startMarker);
const end = cmd.indexOf(endMarker, start + startMarker.length);
assert(start >= 0 && end > start);
const encoded = cmd.slice(start + startMarker.length, end).replace(/\s/g, '');
const ps = Buffer.from(encoded, 'base64').toString('utf16le').replace(/^\uFEFF/, '');
assert(ps.includes('function IsHotkeyDown'));
assert(ps.includes('function WaitHotkey'));
assert(ps.includes('function RunList'));
assert(ps.includes("[BFWinRun]::IsKeyDown"));
assert(ps.includes('GetAsyncKeyState'));
assert(ps.includes('FromBase64String'));
const jsonMarker = "$workflowJson=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('";
assert(ps.includes(jsonMarker));
const b64 = ps.split(jsonMarker)[1].split("'))")[0];
const roundTrip = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
assert.deepStrictEqual(roundTrip, workflow);
console.log('Standalone export tests: OK');
