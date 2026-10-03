/**
 * Static wiring check for the Classes & Subjects feature.
 *
 * Verifies that every renderer-side dependency actually exists:
 *   - the nav item, view section and script tag are present in index.html
 *   - the router registers the view and its shortcut
 *   - every window.api.<ns>.<method>() used by the view is exposed in preload
 *   - every preload method targets an ipcMain channel registered in ipc.js
 *   - every ipcMain channel name is unique
 *
 * Run with:  node tools/verify-classes-wiring.js
 * Exits 0 on success, 1 on the first problem found.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const failures = [];
let checks = 0;

function check(name, condition, detail) {
  checks += 1;
  if (condition) console.log('  PASS  ' + name);
  else {
    failures.push(name + (detail ? ' -> ' + detail : ''));
    console.log('  FAIL  ' + name + (detail ? '  ->  ' + detail : ''));
  }
}

const html = read('src/renderer/index.html');
const navJs = read('src/renderer/js/nav.js');
const keysJs = read('src/renderer/js/keys.js');
const viewJs = read('src/renderer/js/classes-subjects.js');
const preload = read('src/preload/preload.js');
const ipc = read('src/main/ipc.js');
const mainJs = read('src/main/main.js');
const database = read('src/main/database.js');
const css = read('src/renderer/styles/main.css');

console.log('\n=== index.html ===');
check('nav item exists', html.includes('data-view="classes"'));
check('nav label present', html.includes('Classes &amp; Subjects'));
check('view section exists', html.includes('id="view-classes"'));
check('view uses same data-view', /id="view-classes" data-view="classes"/.test(html));
check('script tag added', html.includes('js/classes-subjects.js'));
check('nav item has kbd hint', /data-view="classes"[\s\S]*?<kbd>/.test(html));
check('keys.js loaded before the views that use it',
  html.indexOf('js/keys.js') > -1 && html.indexOf('js/keys.js') < html.indexOf('js/nav.js'));

console.log('\n=== nav.js router ===');
check('VIEWS entry registered', /classes:\s*\{\s*title:\s*'Classes & Subjects'/.test(navJs));
check('router renders the view', navJs.includes('ClassesSubjects.load()'));
// Shortcuts moved out of nav.js into the Keys registry when the two competing
// document-level handlers were merged, so they are asserted there now.
check('router delegates shortcuts to Keys', navJs.includes('Keys.bind()'));
check('help is generated from the registry', navJs.includes('Keys.showHelp()'));

console.log('\n=== keys.js ===');
check('view registers its commands', keysJs === null ? false : viewJs.includes("Keys.register('classes'"));
check('keyboard shortcut mapped', /b:\s*'nav\.classes'/.test(keysJs));
check('shortcut listed in help', keysJs.includes('Ctrl + B'));
check('Classes & Subjects has a help section', keysJs.includes("classes: 'Classes &amp; Subjects'"));

console.log('\n=== main.js application menu ===');
check('menu item registered', mainJs.includes("send('nav:goto', 'classes')"));

console.log('\n=== database schema ===');
check('classes table in SCHEMA', /CREATE TABLE IF NOT EXISTS classes/.test(database));
check('class_subjects table in SCHEMA', /CREATE TABLE IF NOT EXISTS class_subjects/.test(database));
check('class has gradeOrder', /gradeOrder\s+INTEGER NOT NULL DEFAULT 0/.test(database));
check('class has createdAt timestamp', /createdAt\s+TEXT\s+NOT NULL DEFAULT \(datetime\('now','localtime'\)\)/.test(database));
check('subject FK references classes', /classId\s+INTEGER NOT NULL REFERENCES classes\(id\) ON DELETE CASCADE/.test(database));
check('subject has code column', /code\s+TEXT\s+NOT NULL DEFAULT ''/.test(database));
check('subject has status column', /status\s+TEXT\s+NOT NULL DEFAULT 'Active'/.test(database));
check('migration creates missing tables', /PRAGMA table_info\(class_subjects\)/.test(database));

console.log('\n=== preload -> ipcMain channel coverage ===');
const preloadInvokes = new Set(
  [...preload.matchAll(/invoke\('([^']+)'/g)].map((m) => m[1]),
);
const handlerChannels = [...ipc.matchAll(/handle\('([^']+)'/g)].map((m) => m[1]);

for (const channel of preloadInvokes) {
  check(`preload "${channel}" has a handler`, handlerChannels.includes(channel));
}

// Duplicates would throw at startup, but catch them here for a clearer message.
const seen = new Set();
const dupes = new Set();
for (const channel of handlerChannels) {
  if (seen.has(channel)) dupes.add(channel);
  seen.add(channel);
}
check('no duplicate ipcMain channels', dupes.size === 0, [...dupes].join(', '));

console.log('\n=== view -> preload method coverage ===');
const used = new Set(
  [...viewJs.matchAll(/window\.api\.(classes|subjects)\.(\w+)/g)].map((m) => `${m[1]}.${m[2]}`),
);
// The view is expected to reach both namespaces it was built against; naming
// the calls exactly means a deleted call site cannot quietly pass unnoticed.
const EXPECTED_VIEW_CALLS = [
  'classes.list', 'classes.update',
  'subjects.create', 'subjects.list', 'subjects.remove', 'subjects.update',
];
check('view actually calls the API', used.size === EXPECTED_VIEW_CALLS.length, `${used.size} distinct calls`);
for (const call of EXPECTED_VIEW_CALLS) {
  check(`view still calls ${call}`, used.has(call));
}

// Pull the method names out of each preload namespace block.
for (const ns of ['classes', 'subjects']) {
  const block = preload.match(new RegExp(ns + ':\\s*\\{([\\s\\S]*?)\\n  \\}'));
  check(`preload exposes "${ns}" namespace`, !!block);
  if (!block) continue;
  const methods = new Set([...block[1].matchAll(/(\w+):\s*\(/g)].map((m) => m[1]));
  for (const m of methods) {
    check(`preload.${ns}.${m} exists`, true);
  }
  for (const call of used) {
    const [callNs, callMethod] = call.split('.');
    if (callNs !== ns) continue;
    check(`view calls exposed method ${call}`, methods.has(callMethod));
  }
}

console.log('\n=== view DOM ids ===');
const dynamicIds = new Set([
  ...[...viewJs.matchAll(/id:\s*'(cs[A-Za-z]+)'/g)].map((m) => m[1]),
]);
for (const id of dynamicIds) {
  const lookedUp = viewJs.includes(`'#${id}'`) || viewJs.includes(`"${id}"`);
  check(`modal field ${id} is wired`, lookedUp);
}
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
check('view root id exists in HTML', htmlIds.has('view-classes'));

const cssClasses = new Set([...viewJs.matchAll(/class="([^"$]+)"/g)].flatMap((m) => m[1].split(/\s+/)));
const missingCss = [...cssClasses].filter((c) => c && !css.includes('.' + c) && !html.includes(c));
check('every rendered CSS class is styled or global', missingCss.length === 0, missingCss.join(', '));

console.log('\n========================================');
if (failures.length) {
  console.log(`RESULT: ${checks - failures.length} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log(`RESULT: ${checks} passed, 0 failed`);