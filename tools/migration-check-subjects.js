/**
 * Migration check for the subject -> class assignment model.
 *
 * Builds a database in the shape an older build left behind (subjects with
 * className '*' or a single class name, no subject_classes table, no classIds
 * column), boots the real database layer over it, and asserts that:
 *
 *   - initDatabase() completes without throwing;
 *   - every legacy subject ends up assigned to a real class;
 *   - a subject that only ever had a single class keeps exactly that class;
 *   - no '*' or empty className survives anywhere;
 *   - restarting is idempotent.
 *
 * Run with:  npx electron tools/migration-check-subjects.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const sqlite3 = require('sqlite3').verbose();
const { app, ipcMain } = require('electron');

const SANDBOX = path.join(os.tmpdir(), 'campuscore-mig-' + process.pid);
const DB_DIR = path.join(SANDBOX, 'data');
const DB_FILE = path.join(DB_DIR, 'campuscore.db');

let passed = 0;
const failures = [];
function ok(name, extra) {
  passed += 1;
  console.log('  PASS  ' + name + (extra ? '  ->  ' + extra : ''));
}
function fail(name, detail) {
  failures.push(name);
  console.log('  FAIL  ' + name + (detail ? '  ->  ' + detail : ''));
}
function eq(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) ok(name, JSON.stringify(actual));
  else fail(name, 'expected ' + JSON.stringify(expected) + ' but got ' + JSON.stringify(actual));
}
function check(name, cond, detail) {
  if (cond) ok(name); else fail(name, detail);
}

/**
 * Writes a pre-migration database: the old `subjects` shape, seeded with a
 * wildcard row and class-specific rows, plus the classes they refer to.
 */
function seedLegacyDatabase() {
  fs.mkdirSync(DB_DIR, { recursive: true });
  return new Promise((resolve, reject) => {
    const conn = new sqlite3.Database(DB_FILE, (err) => {
      if (err) return reject(err);
      conn.exec(
        `
        CREATE TABLE classes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE COLLATE NOCASE,
          gradeOrder INTEGER NOT NULL DEFAULT 0,
          createdAt TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );
        INSERT INTO classes (id, name, gradeOrder) VALUES (1, 'Class 1', 1);
        INSERT INTO classes (id, name, gradeOrder) VALUES (2, 'Class 2', 2);

        -- The pre-migration shape: no classIds, no createdAt, no junction table.
        CREATE TABLE subjects (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL COLLATE NOCASE,
          className TEXT NOT NULL DEFAULT '*',
          maxMarks REAL NOT NULL DEFAULT 100,
          sortOrder INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO subjects (name, className, maxMarks, sortOrder) VALUES ('English', '*', 100, 1);
        INSERT INTO subjects (name, className, maxMarks, sortOrder) VALUES ('Maths', '*', 100, 2);
        INSERT INTO subjects (name, className, maxMarks, sortOrder) VALUES ('Science', 'Class 2', 50, 3);
        INSERT INTO subjects (name, className, maxMarks, sortOrder) VALUES ('History', 'Class 1', 75, 4);
      `,
        (err2) => {
          if (err2) return reject(err2);
          conn.close(() => resolve());
        },
      );
    });
  });
}

async function main() {
  fs.mkdirSync(SANDBOX, { recursive: true });
  app.setPath('userData', SANDBOX);
  await app.whenReady();

  await seedLegacyDatabase();
  console.log('=== migrating a pre-multi-class database ===');

  // The exact call the app makes on start-up. It used to throw here.
  const database = require('../src/main/database');
  try {
    await database.initDatabase();
    ok('initDatabase migrated the legacy database without throwing');
  } catch (err) {
    fail('initDatabase migrated the legacy database without throwing', (err && err.stack) || String(err));
    console.log('\nRESULT: ' + passed + ' passed, ' + failures.length + ' failed');
    app.exit(1);
    return;
  }

  const { registerIpcHandlers } = require('../src/main/ipc');
  const handlers = new Map();
  ipcMain.handle = (channel, fn) => handlers.set(channel, fn);
  registerIpcHandlers({ getWindow: () => null });
  const api = async (channel, payload) => {
    const res = await handlers.get(channel)({}, payload || {});
    if (res && res.ok === false) throw new Error(channel + ' -> ' + res.error);
    return res ? res.data : res;
  };

  const rows = await database.all(
    'SELECT id, name, className, classIds FROM subjects ORDER BY sortOrder',
  );
  eq('every legacy subject survived', rows.map((r) => r.name),
    ['English', 'Maths', 'Science', 'History']);
  eq('no wildcard className survives',
    rows.filter((r) => r.className === '*' || !r.className).map((r) => r.name), []);

  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  eq('wildcard row became both classes', byName.English.className, 'Class 1, Class 2');
  eq('wildcard row recorded both ids', JSON.parse(byName.English.classIds), [1, 2]);
  eq('class-specific row kept its single class', byName.Science.className, 'Class 2');
  eq('class-specific row recorded one id', JSON.parse(byName.Science.classIds), [2]);
  eq('second class-specific row kept its class', byName.History.className, 'Class 1');

  const orphan = await database.all(
    `SELECT s.name FROM subjects s
      WHERE NOT EXISTS (SELECT 1 FROM subject_classes sc WHERE sc.subjectId = s.id)`,
  );
  eq('no subject left without an assignment', orphan.map((o) => o.name), []);

  // The junction table is what the app filters on, so it has to agree.
  const forClass1 = await api('grades:list-subjects', { studentClass: 'Class 1' });
  eq('Class 1 resolves its subjects', forClass1.map((s) => s.name).sort(),
    ['English', 'History', 'Maths']);
  const forClass2 = await api('grades:list-subjects', { studentClass: 'Class 2' });
  eq('Class 2 resolves its subjects', forClass2.map((s) => s.name).sort(),
    ['English', 'Maths', 'Science']);
  check(
    'a resolved subject reports the class names it is assigned to',
    forClass1.every((s) => (s.classNames || []).length > 0),
    JSON.stringify(forClass1.map((s) => [s.name, s.classNames])),
  );

  // --- idempotence -----------------------------------------------------
  const before = rows.map((r) => [r.name, r.className]).sort();
  await database.closeDatabase();
  await database.initDatabase();
  const after = (await database.all('SELECT name, className FROM subjects ORDER BY sortOrder'))
    .map((r) => [r.name, r.className])
    .sort();
  eq('a second start changes nothing', after, before);

  await database.closeDatabase();

  console.log('\n========================================');
  console.log('RESULT: ' + passed + ' passed, ' + failures.length + ' failed');
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log('  - ' + f));
  }
  console.log('========================================');

  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  app.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error('\nMIGRATION CHECK CRASHED:\n' + ((err && err.stack) || String(err)));
  app.exit(1);
});