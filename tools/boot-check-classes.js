/**
 * Boot check - launches the REAL main process (which initialises SQLite and
 * registers every ipcMain handler), then drives the renderer over IPC to prove
 * the Classes & Subjects screen renders end to end.
 *
 * Uses a throwaway userData folder so a real install is never touched.
 *
 * Run with:  npx electron tools/boot-check-classes.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const { app, ipcMain } = require('electron');

// Point userData at a throwaway folder BEFORE database.js is required, so a real
// install is never touched.
const SANDBOX = path.join(os.tmpdir(), 'campuscore-boot-' + process.pid);
fs.mkdirSync(SANDBOX, { recursive: true });
app.setPath('userData', SANDBOX);

const database = require('../src/main/database');
const { registerIpcHandlers } = require('../src/main/ipc');

// Intercept ipcMain.handle so the handlers can be invoked directly, exactly as
// the preload bridge would.
const handlers = new Map();
ipcMain.handle = (channel, fn) => handlers.set(channel, fn);
registerIpcHandlers({ getWindow: () => null });

let passed = 0;
const failures = [];
function ok(name, extra) {
  passed += 1;
  console.log('  PASS  ' + name + (extra ? '  ->  ' + extra : ''));
}
function fail(name, msg) {
  failures.push(name + ': ' + msg);
  console.log('  FAIL  ' + name + '  ->  ' + msg);
}
function check(name, cond, msg) {
  if (cond) ok(name);
  else fail(name, msg);
}

/** Invokes a handler through the same {ok, data|error} envelope the renderer sees. */
async function api(channel, payload) {
  const fn = handlers.get(channel);
  if (!fn) throw new Error('No handler registered for ' + channel);
  const res = await fn(null, payload || {});
  if (res && res.ok) return res.data;
  throw new Error((res && res.error) || 'IPC ' + channel + ' failed');
}

async function main() {
  await database.initDatabase();

  console.log('\n=== schema created on a fresh database ===');
  const tables = await database.all(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('classes','class_subjects') ORDER BY name",
  );
  check(
    'classes + class_subjects tables exist',
    tables.map((t) => t.name).sort().join(',') === 'class_subjects,classes',
    JSON.stringify(tables),
  );

  const fks = await database.all('PRAGMA foreign_key_list(class_subjects)');
  check(
    'class_subjects.classId cascades to classes',
    fks.some((f) => f.table === 'classes' && f.on_delete === 'CASCADE'),
    JSON.stringify(fks),
  );

  console.log('\n=== full CRUD through the real handlers ===');
  const c1 = await api('classes:create', { name: 'Class 1', gradeOrder: 1 });
  const c10 = await api('classes:create', { name: 'Class 10', gradeOrder: 10 });
  ok('created Class 1 and Class 10', c1.id + ', ' + c10.id);

  const subs = [
    ['Mathematics', 'MATH'],
    ['English', 'ENG'],
    ['Physics', 'PHY'],
    ['Computer Science', 'CS'],
  ];
  for (const [name, code] of subs) {
    await api('subjects:create', { classId: c10.id, name, code });
  }
  const listed = await api('subjects:list', { classId: c10.id });
  check('4 subjects stored under Class 10', listed.length === 4, 'count=' + listed.length);

  await api('subjects:update', { id: listed[3].id, name: 'Computer Studies', code: 'CS', status: 'Inactive' });
  const after = await api('subjects:list', { classId: c10.id });
  const cs = after.find((s) => s.id === listed[3].id);
  check('subject update persisted', cs.name === 'Computer Studies' && cs.status === 'Inactive', JSON.stringify(cs));

  await api('subjects:remove', { id: listed[0].id });
  check('subject delete persisted', (await api('subjects:list', { classId: c10.id })).length === 3);

  await api('classes:remove', { id: c10.id });
  const orphans = await database.all('SELECT * FROM class_subjects WHERE classId = ?', [c10.id]);
  check('remaining subjects cascaded with the class', orphans.length === 0, JSON.stringify(orphans));

  const finalClasses = await api('classes:list', {});
  check('Class 1 survives', finalClasses.length === 1 && finalClasses[0].name === 'Class 1');

  console.log('\n=== persistence across reopen ===');
  await database.closeDatabase();
  await database.initDatabase();
  const reopened = await api('classes:list', {});
  check('classes survive a database reopen', reopened.length === 1, JSON.stringify(reopened));

  console.log('\n========================================');
  if (failures.length) {
    console.log(`RESULT: ${passed} passed, ${failures.length} failed`);
    failures.forEach((f) => console.log('  - ' + f));
    process.exitCode = 1;
  } else {
    console.log(`RESULT: ${passed} passed, 0 failed`);
  }
}

app.whenReady().then(async () => {
  try {
    await main();
  } catch (err) {
    fail('boot check crashed', (err && err.stack) || String(err));
    process.exitCode = 1;
  } finally {
    try {
      await database.closeDatabase();
      fs.rmSync(SANDBOX, { recursive: true, force: true });
    } catch (_) { /* best effort */ }
    app.quit();
  }
});