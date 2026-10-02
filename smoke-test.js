/**
 * Electron smoke test - runs the REAL main-process modules (database.js,
 * ipc.js, grading.js) against a throwaway database and invokes every IPC
 * handler, verifying CRUD, marks entry/clearing and report generation.
 *
 * Run with:  npx electron smoke-test.js
 * Exits 0 on success, 1 on the first failure.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_DB_DIR = path.join(os.tmpdir(), 'campuscore-smoke-' + process.pid);

let passed = 0;
const failures = [];

function ok(name, extra) {
  passed += 1;
  console.log('  PASS  ' + name + (extra ? '  ->  ' + extra : ''));
}

function fail(name, message) {
  failures.push(name + ': ' + message);
  console.log('  FAIL  ' + name + '  ->  ' + message);
}

function check(name, condition, message, extra) {
  if (condition) ok(name, extra);
  else fail(name, message);
}

function eq(name, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (same) ok(name, String(actual));
  else fail(name, `expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
}

/** Runs an async block and returns the thrown Error (or null). */
async function expectError(fn) {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
}

function cleanup() {
  try {
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  } catch (_) {
    /* best effort */
  }
}

const SECTIONS = [];
function section(title, fn) {
  SECTIONS.push({ title, fn });
}

/* =================================================================== */
/* 0. Migration: rollNo no longer global unique                        */
/* =================================================================== */

section('Migration: composite rollNo uniqueness', async () => {
  const migrationDir = path.join(os.tmpdir(), 'campuscore-migration-test-' + process.pid);
  fs.mkdirSync(migrationDir, { recursive: true });
  const oldDbFile = path.join(migrationDir, 'campuscore.db');

  // Simulate an existing database with the OLD schema (UNIQUE on rollNo)
  const sqlite3 = require('sqlite3').verbose();
  await new Promise((resolve, reject) => {
    const conn = new sqlite3.Database(oldDbFile, (err) => (err ? reject(err) : resolve()));
    conn.run(`
      CREATE TABLE students (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        rollNo        TEXT    NOT NULL UNIQUE,
        name          TEXT    NOT NULL,
        studentClass  TEXT    NOT NULL DEFAULT 'Class 1',
        guardian      TEXT    NOT NULL DEFAULT '',
        phone         TEXT    NOT NULL DEFAULT '',
        createdAt     TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
      );
      CREATE INDEX idx_students_name  ON students(name);
      CREATE INDEX idx_students_class ON students(studentClass);
      INSERT INTO students (rollNo, name, studentClass) VALUES ('1', 'Student A', 'Class 1');
    `, (err) => {
      if (err) reject(err);
      else {
        conn.close(resolve);
      }
    });
  });

  // Now open with the new code — it should migrate automatically
  const database = require('./src/main/database');
  await database.initDatabase();

  // Point the module at our throwaway DB instead of the default location
  // We need to force re-init with our path. Close first.
  await database.closeDatabase();

  // Re-open by temporarily redirecting userData
  const electron = require('electron');
  const { app } = electron;
  const origPath = app.getPath('userData');
  app.setPath('userData', migrationDir);
  await database.initDatabase();

  // Verify the composite index exists and old autoindex is gone
  const indexes = await database.all(
    "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='students'",
  );
  check('composite index exists', indexes.some((i) => i.name === 'idx_students_roll_class'),
    JSON.stringify(indexes.map((i) => i.name)));
  check('old autoindex removed', !indexes.some((i) => i.name === 'sqlite_autoindex_students_1'),
    JSON.stringify(indexes.map((i) => i.name)));

  // Verify data survived
  const count = await database.get('SELECT COUNT(*) AS c FROM students');
  ok('data survived migration', count.c === 1, 'count=' + count.c);

  // Verify same rollNo in different class is now allowed
  await database.run(
    "INSERT INTO students (rollNo, name, studentClass) VALUES ('1', 'Student B', 'Class 2')",
  );
  const dupCount = await database.get("SELECT COUNT(*) AS c FROM students WHERE rollNo = '1'");
  ok('same rollNo in different class now works', dupCount.c === 2, 'count=' + dupCount.c);

  await database.closeDatabase();
  app.setPath('userData', origPath);
});

/* =================================================================== */
/* 0b. Migration: CappusCore -> CampusCore data carry-over             */
/* =================================================================== */

section('Migration: renamed app carries over old data', async () => {
  const { app } = require('electron');
  const database = require('./src/main/database');
  const sqlite3 = require('sqlite3').verbose();

  // userData is <root>/CampusCore; the pre-rename install lived next to it
  // in <root>/CappusCore with a cappuscore.db.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'campuscore-rename-'));
  const legacyDir = path.join(root, 'CappusCore', 'data');
  const newDir = path.join(root, 'CampusCore');
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.mkdirSync(newDir, { recursive: true });

  const legacyFile = path.join(legacyDir, 'cappuscore.db');
  await new Promise((resolve, reject) => {
    // NOTE: the open callback must only reject. Resolving there would settle the
    // promise with undefined before exec() has run.
    const conn = new sqlite3.Database(legacyFile, (err) => { if (err) reject(err); });
    // A realistic pre-rename database: full column set plus other tables, so the
    // carry-over is proven against a real install rather than a toy fixture.
    // exec, not run: run() would only execute the first statement.
    conn.exec(`
      CREATE TABLE students (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rollNo TEXT NOT NULL,
        name TEXT NOT NULL,
        studentClass TEXT NOT NULL DEFAULT 'Class 1',
        guardian TEXT NOT NULL DEFAULT '',
        phone TEXT NOT NULL DEFAULT '',
        createdAt TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
      CREATE TABLE subjects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        maxMarks REAL NOT NULL DEFAULT 100,
        sortOrder INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO students (rollNo, name, studentClass) VALUES ('OLD-1', 'Legacy Student', 'Class 9');
      INSERT INTO subjects (name, maxMarks, sortOrder) VALUES ('Legacy Subject', 100, 1);
      INSERT INTO settings (key, value) VALUES ('schoolName', 'Legacy School');
    `, (err) => (err ? reject(err) : conn.close(() => resolve())));
  });

  // Creating the database above is not enough. sqlite3 can still be holding the
  // written pages when the handle closes, so the file on disk can be empty or
  // carry only a header page. A real pre-rename install was closed long ago and
  // is fully flushed, so poll the invariant that actually matters - the rows
  // being readable from a separate connection - instead of trusting file size.
  async function readLegacyRows() {
    return new Promise((resolve, reject) => {
      const conn = new sqlite3.Database(legacyFile, (err) => { if (err) reject(err); });
      conn.all('SELECT name FROM students', (err, rows) => {
        if (err) { conn.close(); reject(err); return; }
        conn.close(() => resolve(rows || []));
      });
    });
  }

  let onDisk = [];
  for (let i = 0; i < 100; i += 1) {
    onDisk = await readLegacyRows();
    if (onDisk.some((r) => r.name === 'Legacy Student')) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  check('legacy fixture is on disk', fs.statSync(legacyFile).size > 0,
    'legacy db is still empty');
  check('legacy fixture rows persisted', onDisk.some((r) => r.name === 'Legacy Student'),
    JSON.stringify(onDisk));

  const origPath = app.getPath('userData');
  try {
    app.setPath('userData', newDir);
    await database.initDatabase();

    // A fresh install has no students and no saved settings, so finding the
    // legacy rows proves the data was carried over rather than starting empty.
    const students = await database.all('SELECT rollNo, name FROM students');
    check('legacy student carried over', students.some((r) => r.name === 'Legacy Student'),
      JSON.stringify(students));
    const school = await database.get("SELECT value FROM settings WHERE key = 'schoolName'");
    check('legacy settings carried over', school && school.value === 'Legacy School',
      JSON.stringify(school));
    check('database uses new filename', database.getDatabaseFile().endsWith('campuscore.db'),
      database.getDatabaseFile());
    check('database lives under new userData', database.getDatabaseFile().startsWith(newDir),
      database.getDatabaseFile());

    // A second start must be a no-op, not a re-copy.
    await database.closeDatabase();
    const file = database.getDatabaseFile();
    const stamp = fs.statSync(file).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    await database.initDatabase();
    check('carry-over runs only once', fs.statSync(file).mtimeMs === stamp,
      'mtime changed on second start');
  } finally {
    // Always restore userData: a throw here would leave every later section
    // pointed at this throwaway database and cascade unrelated failures.
    await database.closeDatabase();
    app.setPath('userData', origPath);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* =================================================================== */
/* 1. Database initialisation                                          */
/* =================================================================== */

section('Database initialisation', async (ctx) => {
  const dbFile = await ctx.database.initDatabase();
  ctx.dbFile = dbFile;
  check('database file created', fs.existsSync(dbFile), 'no file at ' + dbFile, dbFile);
  check('database lives under userData', dbFile.startsWith(TEST_DB_DIR), dbFile);

  const journal = await ctx.q1('PRAGMA journal_mode');
  eq('journal_mode is WAL', String(journal.journal_mode).toLowerCase(), 'wal');

  const tables = (await ctx.qall("SELECT name FROM sqlite_master WHERE type='table'"))
    .map((r) => r.name);
  for (const t of [
    'students',
    'invoices',
    'payments',
    'subjects',
    'marks',
    'reportRemarks',
    'settings',
  ]) {
    check(`table ${t} exists`, tables.includes(t), 'missing: ' + tables.join(','));
  }

  const seeded = await ctx.qall('SELECT name FROM subjects ORDER BY sortOrder');
  eq('subjects seeded', seeded.length, 7);

  const settings = await ctx.api('settings:get-all');
  check('default settings returned', !!settings.schoolName, JSON.stringify(settings));
});

/* =================================================================== */
/* 2. Students CRUD                                                    */
/* =================================================================== */

section('Students CRUD', async (ctx) => {
  const alice = await ctx.api('students:create', {
    rollNo: 'A-001',
    name: 'Alice Khan',
    studentClass: 'Class 1',
    guardian: 'Mr. Khan',
    phone: '0300-1111111',
  });
  check('student created with id', Number(alice.id) > 0, 'id=' + alice.id, 'id=' + alice.id);
  eq('created student rollNo', alice.rollNo, 'A-001');
  ctx.alice = alice;

  const bob = await ctx.api('students:create', {
    rollNo: 'A-002',
    name: 'Bob Ali',
    studentClass: 'Class 1',
    guardian: 'Mrs. Ali',
    phone: '0300-2222222',
  });
  check('second student created', Number(bob.id) > 0, 'id=' + bob.id);
  ctx.bob = bob;

  const carol = await ctx.api('students:create', {
    rollNo: 'B-001',
    name: 'Carol Iqbal',
    studentClass: 'Class 2',
  });
  check('third student created', Number(carol.id) > 0, 'id=' + carol.id);
  ctx.carol = carol;

  const dupe = await expectError(() =>
    ctx.api('students:create', {
      rollNo: 'a-001',
      name: 'Duplicate',
      studentClass: 'Class 1',
    }),
  );
  check('duplicate rollNo in same class rejected', !!dupe && /already exists/i.test(dupe.message), String(dupe));

  // Same roll number in a DIFFERENT class should be allowed
  const sameRollDiffClass = await ctx.api('students:create', {
    rollNo: 'A-001',
    name: 'Ali Khan',
    studentClass: 'Class 2',
  });
  check('same rollNo in different class allowed', Number(sameRollDiffClass.id) > 0, 'id=' + sameRollDiffClass.id);

  const noRoll = await expectError(() =>
    ctx.api('students:create', { rollNo: '', name: 'No Roll', studentClass: 'Class 1' }),
  );
  check('empty rollNo rejected', !!noRoll && /required/i.test(noRoll.message), String(noRoll));

  const fetched = await ctx.api('students:get', { id: alice.id });
  eq('students:get returns the row', fetched.name, 'Alice Khan');

  const all = await ctx.api('students:list', {});
  eq('students:list count', all.length, 4);

  const searched = await ctx.api('students:list', { search: 'Bob' });
  eq('students:list search filters', searched.length, 1);
  eq('students:list search hits the right row', searched[0].id, ctx.bob.id);

  const renamed = await ctx.api('students:update', {
    id: bob.id,
    rollNo: 'A-002',
    name: 'Bob Ali Jr',
    studentClass: 'Class 1',
    guardian: 'Mrs. Ali',
    phone: '0300-2222222',
  });
  eq('students:update renames', renamed.name, 'Bob Ali Jr');

  const reread = await ctx.api('students:get', { id: bob.id });
  eq('update was persisted', reread.name, 'Bob Ali Jr');

  const missing = await expectError(() => ctx.api('students:get', { id: 999999 }));
  check('unknown student id errors', !!missing, String(missing));
});

/* =================================================================== */
/* 3. Invoices, payments and status                                    */
/* =================================================================== */

section('Invoices, payments and status', async (ctx) => {
  const inv1 = await ctx.api('invoices:create', {
    studentId: ctx.alice.id,
    feeMonth: '2026-01',
    description: 'January Tuition',
    amountDue: 5000,
    discount: 500,
    amountPaid: 2000,
  });
  check('invoice created', Number(inv1.id) > 0, 'id=' + inv1.id);
  eq('partially paid invoice status', inv1.status, 'Partial');
  eq('invoice number format', /^INV-\d{4}-\d{4}$/.test(inv1.invoiceNo), true);
  ctx.inv1 = inv1;

  const inv2 = await ctx.api('invoices:create', {
    studentId: ctx.bob.id,
    feeMonth: '2026-01',
    amountDue: 3000,
    amountPaid: 3000,
  });
  eq('fully paid invoice status', inv2.status, 'Paid');
  ctx.inv2 = inv2;

  const inv3 = await ctx.api('invoices:create', {
    studentId: ctx.carol.id,
    feeMonth: '2026-02',
    amountDue: 4000,
  });
  eq('unpaid invoice status', inv3.status, 'Unpaid');
  ctx.inv3 = inv3;

  const opening = await ctx.qall('SELECT * FROM payments WHERE invoiceId = ?', [inv1.id]);
  eq('opening payment row created', opening.length, 1);
  eq('opening payment amount', opening[0].amount, 2000);

  const paid = await ctx.api('invoices:add-payment', {
    invoiceId: inv1.id,
    amount: 2500,
    method: 'Cash',
  });
  eq('invoice becomes Paid', paid.status, 'Paid');
  eq('amountPaid updated', paid.amountPaid, 4500);

  const payments = await ctx.api('invoices:payments', { invoiceId: inv1.id });
  eq('two payments recorded', payments.length, 2);

  const overpay = await expectError(() =>
    ctx.api('invoices:add-payment', { invoiceId: inv3.id, amount: 99999 }),
  );
  check(
    'overpayment rejected',
    !!overpay && /exceeds the outstanding/i.test(overpay.message),
    String(overpay),
  );

  const badMethod = await expectError(() =>
    ctx.api('invoices:add-payment', { invoiceId: inv3.id, amount: 10, method: 'Crypto' }),
  );
  check('unknown payment method rejected', !!badMethod, String(badMethod));

  const dupeMonth = await expectError(() =>
    ctx.api('invoices:create', { studentId: ctx.alice.id, feeMonth: '2026-01', amountDue: 100 }),
  );
  check('duplicate student+month rejected', !!dupeMonth, String(dupeMonth));

  const badDiscount = await expectError(() =>
    ctx.api('invoices:create', {
      studentId: ctx.alice.id,
      feeMonth: '2026-09',
      amountDue: 100,
      discount: 500,
    }),
  );
  check('discount over amount rejected', !!badDiscount, String(badDiscount));

  const nextNo = await ctx.api('invoices:next-number', {});
  check('next invoice number generated', /^INV-\d{4}-\d{4}$/.test(nextNo), JSON.stringify(nextNo));

  const list = await ctx.api('invoices:list', {});
  eq('invoices:list count', list.length, 3);

  const byMonth = await ctx.api('invoices:list', { month: '2026-01' });
  eq('invoices filtered by month', byMonth.length, 2);

  const byStatus = await ctx.api('invoices:list', { status: 'Unpaid' });
  eq('invoices filtered by status', byStatus.length, 1);

  const detail = await ctx.api('invoices:get', { id: inv1.id });
  eq('invoices:get returns the invoice', detail.invoice.id, inv1.id);
  eq('invoices:get includes the student', detail.student.rollNo, 'A-001');
  eq('invoices:get includes payments', detail.payments.length, 2);

  const updated = await ctx.api('invoices:update', {
    id: inv3.id,
    feeMonth: '2026-02',
    description: 'Feb Tuition',
    amountDue: 4500,
    discount: 0,
    amountPaid: 0,
  });
  eq('invoices:update amount', updated.amountDue, 4500);

  const removedInv = await ctx.api('invoices:remove', { id: inv3.id });
  check('invoices:remove works', removedInv.deleted === true, JSON.stringify(removedInv));
  const gone = await expectError(() => ctx.api('invoices:get', { id: inv3.id }));
  check('removed invoice is gone', !!gone, String(gone));
});

/* =================================================================== */
/* 4. Dashboard aggregation                                            */
/* =================================================================== */

section('Dashboard aggregation', async (ctx) => {
  const stats = await ctx.api('dashboard:stats', {});
  eq('student count', stats.students, 4);
  eq('class count', stats.classes, 2);
  eq('subject count', stats.subjects, 7);
  // By the time the dashboard runs, section 3 has removed the unpaid invoice 3,
  // so only the two January invoices remain: 5000 + 3000 due, less 500 discount.
  eq('billed net of discount', stats.billed, 7500);
  // 2000 opening + 3000 opening + 2500 later payment
  eq('collected', stats.collected, 7500);
  eq('outstanding', stats.outstanding, 0);
  eq('nobody is in arrears', stats.topDefaulters.length, 0);
  check('feeByMonth series present', stats.feeByMonth.length >= 1, JSON.stringify(stats.feeByMonth));
  check('status breakdown present', !!stats.byStatus, JSON.stringify(stats.byStatus));
});

/* =================================================================== */
/* 5. Subjects                                                         */
/* =================================================================== */

section('Subjects', async (ctx) => {
  // Students registered in earlier sections put Class 1 and Class 2 on the
  // roster, so both exist and can be assigned.
  const classes = await ctx.api('classes:list', {});
  const class1 = classes.find((c) => c.name === 'Class 1');
  const class2 = classes.find((c) => c.name === 'Class 2');
  check('fixture classes available', !!class1 && !!class2, JSON.stringify(classes.map((c) => c.name)));

  // A subject with no class at all would be invisible in every grid, so it is
  // refused rather than stored.
  const noClass = await expectError(() =>
    ctx.api('grades:add-subject', { name: 'Astronomy', maxMarks: 50 }),
  );
  check('subject without a class rejected', !!noClass && /at least one class/i.test(noClass.message), String(noClass));

  const added = await ctx.api('grades:add-subject', {
    name: 'Astronomy',
    maxMarks: 50,
    classIds: [class1.id],
  });
  check('subject added', Number(added.id) > 0, 'id=' + added.id);
  eq('subject maxMarks', added.maxMarks, 50);
  eq('subject records its class', added.className, 'Class 1');
  eq('subject records its class ids', JSON.parse(added.classIds), [class1.id]);

  const dupe = await expectError(() =>
    ctx.api('grades:add-subject', { name: 'astronomy', maxMarks: 50, classIds: [class1.id] }),
  );
  check('duplicate subject in the same class rejected', !!dupe && /already configured for Class 1/i.test(dupe.message), String(dupe));

  // The same name in a class that does not have it yet is not a duplicate.
  const otherClass = await ctx.api('grades:add-subject', {
    name: 'Astronomy',
    maxMarks: 60,
    classIds: [class2.id],
  });
  check('same subject name allowed in another class', Number(otherClass.id) > 0, JSON.stringify(otherClass));
  await ctx.api('grades:remove-subject', { id: otherClass.id });

  const updated = await ctx.api('grades:update-subject', {
    id: added.id,
    name: 'Astronomy',
    maxMarks: 75,
  });
  eq('subject updated', updated.maxMarks, 75);
  // Omitting the class fields must keep the existing assignment.
  eq('assignment untouched by a name/marks-only update', updated.className, 'Class 1');

  const removed = await ctx.api('grades:remove-subject', { id: added.id });
  check('subject removed', removed.deleted === true, JSON.stringify(removed));

  const after = await ctx.api('grades:list-subjects', {});
  eq('subject count back to 7', after.length, 7);
  ctx.subjects = after;
});

/* =================================================================== */
/* 5b. Subject / class assignment                                      */
/* =================================================================== */

section('Multi-class subject assignment', async (ctx) => {
  const classes = await ctx.api('classes:list', {});
  const class1 = classes.find((c) => c.name === 'Class 1');
  const class2 = classes.find((c) => c.name === 'Class 2');

  // The picker has no "all classes" option any more, so one subject row can be
  // assigned to several named classes at once.
  const multi = await ctx.api('grades:add-subject', {
    name: 'Computer Studies',
    maxMarks: 75,
    classIds: [class2.id, class1.id],
  });
  eq('multi-class subject stored both names', multi.className, 'Class 1, Class 2');
  eq('multi-class subject stored both ids', JSON.parse(multi.classIds).sort(), [class1.id, class2.id]);

  const links = await ctx.qall(
    `SELECT c.name FROM subject_classes sc
       JOIN classes c ON c.id = sc.classId
      WHERE sc.subjectId = ?
      ORDER BY c.gradeOrder`,
    [multi.id],
  );
  eq('junction rows written for both classes', links.map((l) => l.name), ['Class 1', 'Class 2']);

  // --- the toolbar filter is an explicit membership test ---------------
  for (const cls of [class1, class2]) {
    const list = await ctx.api('grades:list-subjects', { studentClass: cls.name });
    const row = list.find((s) => s.id === multi.id);
    check(`visible in ${cls.name}`, !!row, list.map((s) => s.name).join('|'));
    eq(`reports both classes in ${cls.name}`, row.classNames.slice().sort(), ['Class 1', 'Class 2']);
    eq(`reports both class ids in ${cls.name}`, row.classIds.slice().sort((a, b) => a - b), [class1.id, class2.id].sort((a, b) => a - b));
  }

  // --- narrowing to one class removes it from the other ----------------
  const narrowed = await ctx.api('grades:update-subject', {
    id: multi.id,
    name: multi.name,
    maxMarks: multi.maxMarks,
    classIds: [class2.id],
  });
  eq('narrowed to a single class', narrowed.className, 'Class 2');
  const stillIn1 = (await ctx.api('grades:list-subjects', { studentClass: class1.name }))
    .some((s) => s.id === multi.id);
  eq('no longer visible in the removed class', stillIn1, false);
  const stillIn2 = (await ctx.api('grades:list-subjects', { studentClass: class2.name }))
    .some((s) => s.id === multi.id);
  eq('still visible in the kept class', stillIn2, true);

  // --- a subject with no class cannot be saved at all ------------------
  const empty = await expectError(() =>
    ctx.api('grades:update-subject', { id: multi.id, name: multi.name, maxMarks: 50, classIds: [] }),
  );
  check('clearing every class rejected', !!empty && /at least one class/i.test(empty.message), String(empty));

  // --- the denormalised columns follow the junction table --------------
  await ctx.api('grades:remove-subject', { id: multi.id });
  const leftovers = await ctx.q1(
    'SELECT COUNT(*) AS c FROM subject_classes WHERE subjectId = ?',
    [multi.id],
  );
  eq('assignment rows removed with the subject', leftovers.c, 0);

  const total = await ctx.api('grades:list-subjects', {});
  eq('catalogue back to 7', total.length, 7);
  check('no subject is left without a class', total.every((s) => (s.classNames || []).length > 0), JSON.stringify(total.map((s) => [s.name, s.classNames])));
});

/* =================================================================== */
/* 6. Marks entry and clearing                                         */
/* =================================================================== */

section('Marks entry and clearing', async (ctx) => {
  const EXAM = 'Term 1 - 2026';
  ctx.exam = EXAM;
  const names = ctx.subjects.map((s) => s.name);

  const rows = [];
  for (const student of [ctx.alice, ctx.bob]) {
    for (const name of names) {
      rows.push({
        studentId: student.id,
        subject: name,
        marksObtained: 80,
        maxMarks: 100,
      });
    }
  }

  const saved = await ctx.api('grades:save-marks', { examName: EXAM, rows });
  eq('all marks saved', saved.saved, rows.length);
  eq('nothing cleared yet', saved.cleared, 0);

  const count1 = await ctx.q1('SELECT COUNT(*) AS c FROM marks WHERE examName = ?', [EXAM]);
  eq('mark rows in database', count1.c, rows.length);

  const resaved = await ctx.api('grades:save-marks', { examName: EXAM, rows });
  eq('re-save upserts', resaved.saved, rows.length);
  const count2 = await ctx.q1('SELECT COUNT(*) AS c FROM marks WHERE examName = ?', [EXAM]);
  eq('no duplicate rows after re-save', count2.c, rows.length);

  const byFlag = await ctx.api('grades:save-marks', {
    examName: EXAM,
    rows: [{ studentId: ctx.alice.id, subject: names[0], clear: true }],
  });
  eq('explicit clear removes one cell', byFlag.cleared, 1);
  eq('clear saves nothing', byFlag.saved, 0);

  const gone1 = await ctx.q1(
    'SELECT COUNT(*) AS c FROM marks WHERE rollNo = ? AND subject = ? AND examName = ?',
    [ctx.alice.rollNo, names[0], EXAM],
  );
  eq('cleared cell removed from db', gone1.c, 0);

  const byNull = await ctx.api('grades:save-marks', {
    examName: EXAM,
    rows: [{ studentId: ctx.alice.id, subject: names[1], marksObtained: null }],
  });
  eq('null mark clears the cell', byNull.cleared, 1);

  const overMax = await expectError(() =>
    ctx.api('grades:save-marks', {
      examName: EXAM,
      rows: [{ studentId: ctx.alice.id, subject: names[0], marksObtained: 150, maxMarks: 100 }],
    }),
  );
  check('over-max marks rejected', !!overMax && /cannot exceed/i.test(overMax.message), String(overMax));

  const empty = await expectError(() => ctx.api('grades:save-marks', { examName: EXAM, rows: [] }));
  check('empty batch rejected', !!empty, String(empty));

  const noExam = await expectError(() => ctx.api('grades:save-marks', { examName: '', rows }));
  check('missing exam name rejected', !!noExam, String(noExam));
});

/* =================================================================== */
/* 6b. Class-name casing must not hide students                       */
/* =================================================================== */

/*
 * Class names are compared case-insensitively across the app (classes table
 * is UNIQUE COLLATE NOCASE and every other query uses COLLATE NOCASE), so
 * mixed-case class names are a supported state. The grading views filter by
 * class too; if that filter is case-sensitive, a student stored under
 * "play group" disappears from the grid of the pill labelled "Play Group".
 * These tests pin the case-insensitive behaviour end to end.
 */
section('Case-insensitive class matching', async (ctx) => {
  const cls = 'KiNDER MixedCase';
  const roll = 'case-1';

  const created = await ctx.api('students:create', {
    rollNo: roll,
    name: 'Casey Mixed',
    studentClass: cls,
    guardian: 'Guardian',
    phone: '',
  });
  check('student created in mixed-case class', !!created.id, JSON.stringify(created));

  // Registering the student created the class, so its id is available for the
  // explicit subject assignment the new model requires.
  const clsRow = (await ctx.api('classes:list', {})).find(
    (c) => String(c.name).toLowerCase() === cls.toLowerCase(),
  );
  check('mixed-case class registered on the roster', !!clsRow, cls);

  const sub = await ctx.api('grades:add-subject', {
    name: 'Mixed Subject',
    maxMarks: 50,
    classIds: [clsRow.id],
  });

  await ctx.api('grades:save-marks', {
    examName: ctx.exam,
    rows: [{ studentId: created.id, subject: 'Mixed Subject', marksObtained: 40, maxMarks: 50 }],
  });

  // The class pill shows the casing from the classes table; queries may pass
  // either casing and must find the same student.
  const stored = await ctx.q1('SELECT studentClass FROM students WHERE id = ?', [created.id]);
  const storedClass = stored.studentClass;
  const flipped = storedClass.toLowerCase() === storedClass ? storedClass.toUpperCase() : storedClass.toLowerCase();

  const byExact = await ctx.api('grades:get-results', {
    examName: ctx.exam,
    studentClass: storedClass,
  });
  const byFlipped = await ctx.api('grades:get-results', {
    examName: ctx.exam,
    studentClass: flipped,
  });

  const inExact = byExact.results.filter((r) => r.student.id === created.id).length;
  const inFlipped = byFlipped.results.filter((r) => r.student.id === created.id).length;
  eq('exact-case filter finds the student', inExact, 1);
  eq('opposite-case filter finds the student too', inFlipped, 1);

  // The mark must also be found for that student, not merely the student row.
  const row = byFlipped.results.find((r) => r.student.id === created.id);
  check('mixed-case result row exists', !!row, 'missing');
  if (row) {
    const subj = row.report.subjects.find((s) => s.subject === 'Mixed Subject');
    check('subject present on mixed-case row', !!subj, JSON.stringify(row.report.subjects));
    if (subj) {
      eq('mark matched case-insensitively', subj.marksObtained, 40);
      check('mark flagged as entered', subj.hasMark === true, 'hasMark=' + subj.hasMark);
    }
  }

  const subjectsFlipped = await ctx.api('grades:list-subjects', { studentClass: flipped });
  check(
    'subjects resolve under flipped casing',
    subjectsFlipped.some((s) => s.name === 'Mixed Subject'),
    subjectsFlipped.map((s) => s.name).join('|'),
  );

  // Clean up so later sections see the original fixture counts.
  await ctx.api('students:remove', { id: created.id });
  await ctx.api('grades:remove-subject', { id: sub.id });
});

/* =================================================================== */
/* 7. Results and report cards                                         */
/* =================================================================== */

section('Results and report cards', async (ctx) => {
  const results = await ctx.api('grades:get-results', { examName: ctx.exam });
  check('results computed', results.results.length >= 2, 'n=' + results.results.length);
  eq('result passMark', results.summary.passMark, 50);
  eq('subject list returned', results.subjects.length, 7);

  const aliceRow = results.results.find((r) => r.student.id === ctx.alice.id);
  check('alice present in results', !!aliceRow, 'missing');
  if (aliceRow) {
    // Alice has two deliberately cleared subjects, so her average is 5x80/7.
    eq('alice grade reflects cleared cells', aliceRow.report.grade, 'D');
    eq('alice passes on entered marks', aliceRow.report.isPass, true);
    check('alice ranked', aliceRow.report.position >= 1, 'pos=' + aliceRow.report.position);
  }

  const bobRow = results.results.find((r) => r.student.id === ctx.bob.id);
  check('bob present in results', !!bobRow, 'missing');
  if (bobRow) {
    // Bob has a full grid at 80% in every subject.
    eq('bob grade', bobRow.report.grade, 'A');
    eq('bob percentage', bobRow.report.percentage, 80);
    eq('bob passes', bobRow.report.isPass, true);
  }

  // Positions must be a dense 1..n ranking, ordered by percentage.
  const positions = results.results.map((r) => r.report.position);
  eq('positions are 1..n', positions, results.results.map((_, i) => i + 1));
  const pcts = results.results.map((r) => r.report.percentage);
  eq('results sorted by percentage', pcts, [...pcts].sort((a, b) => b - a));

  const report = await ctx.api('grades:get-report', {
    rollNo: ctx.bob.rollNo,
    examName: ctx.exam,
  });
  check('report generated', !!report.report, 'missing');
  eq('report student name', report.report.name, 'Bob Ali Jr');
  eq('report covers all subjects', report.report.subjects.length, 7);
  check(
    'report totals computed',
    typeof report.report.totalObtained === 'number',
    JSON.stringify(report.report.totalObtained),
  );
  check('report has class size', report.report.classSize >= 1, 'size=' + report.report.classSize);
  eq('report exam echoed', report.examName, ctx.exam);

  const unknownRoll = await expectError(() =>
    ctx.api('grades:get-report', { rollNo: 'NOPE-999', examName: ctx.exam }),
  );
  check('unknown rollNo rejected', !!unknownRoll, String(unknownRoll));

  const remark = await ctx.api('grades:save-remark', {
    rollNo: ctx.alice.rollNo,
    remark: 'Excellent progress',
  });
  eq('remark saved', remark.remark, 'Excellent progress');

  const after = await ctx.api('grades:get-report', { rollNo: ctx.alice.rollNo, examName: ctx.exam });
  eq('remark appears in report', after.report.remark, 'Excellent progress');

  // Second exam must be isolated from the first.
  const other = await ctx.api('grades:get-results', { examName: 'Term 2 - 2026' });
  eq('other exam has no marks', other.results.every((r) => r.report.subjects.every((s) => s.marksObtained === 0)), true);
});

/* =================================================================== */
/* 8. Settings save and validation                                     */
/* =================================================================== */

section('Settings save and validation', async (ctx) => {
  const savedSettings = await ctx.api('settings:save', {
    schoolName: 'CampusCore Test School',
    currency: 'USD',
    passMarkPercentage: '40',
  });
  // settings:save resolves to the settings object itself, not a wrapper.
  eq('school name saved', savedSettings.schoolName, 'CampusCore Test School');
  eq('currency saved', savedSettings.currency, 'USD');
  eq('pass mark saved', savedSettings.passMarkPercentage, '40');

  const badPass = await expectError(() => ctx.api('settings:save', { passMarkPercentage: '150' }));
  check('invalid pass mark rejected', !!badPass && /between 0 and 100/i.test(badPass.message), String(badPass));

  const blankName = await expectError(() => ctx.api('settings:save', { schoolName: '   ' }));
  check('blank school name rejected', !!blankName, String(blankName));

  const badLogo = await expectError(() => ctx.api('settings:save', { schoolLogo: 'not-a-data-url' }));
  check('invalid logo rejected', !!badLogo && /base64/i.test(badLogo.message), String(badLogo));

  const nothing = await expectError(() => ctx.api('settings:save', { notASetting: 'x' }));
  check('unknown setting rejected', !!nothing, String(nothing));

  const reloaded = await ctx.api('settings:get-all', {});
  eq('settings persisted', reloaded.currency, 'USD');
});

/* =================================================================== */
/* 9. Cascade delete                                                   */
/* =================================================================== */

section('Student deletion cascades', async (ctx) => {
  const removed = await ctx.api('students:remove', { id: ctx.bob.id });
  check('student removed', removed.deleted === true, JSON.stringify(removed));

  const after = await ctx.api('students:list', {});
  eq('student count after removal', after.length, 3);

  const orphanInvoices = await ctx.q1('SELECT COUNT(*) AS c FROM invoices WHERE studentId = ?', [
    ctx.bob.id,
  ]);
  eq('invoices cascaded', orphanInvoices.c, 0);

  const orphanPayments = await ctx.q1('SELECT COUNT(*) AS c FROM payments WHERE invoiceId = ?', [
    ctx.inv2.id,
  ]);
  eq('payments cascaded', orphanPayments.c, 0);

  const unknown = await expectError(() => ctx.api('students:remove', { id: 999999 }));
  check('removing unknown student errors', !!unknown, String(unknown));
});

/* =================================================================== */
/* 10. Restart safety                                                  */
/* =================================================================== */

section('Restart safety', async (ctx) => {
  ctx.database.closeDatabase();
  const samePath = ctx.database.getDatabaseFile();
  eq('db path unchanged after close', samePath, ctx.dbFile);

  await ctx.database.initDatabase();
  const students = await ctx.q1('SELECT COUNT(*) AS c FROM students');
  eq('students survive reopen', students.c, 3);
  const settings = await ctx.q1("SELECT value FROM settings WHERE key = 'schoolName'");
  eq('settings survive reopen', settings.value, 'CampusCore Test School');
  const subjects = await ctx.q1('SELECT COUNT(*) AS c FROM subjects');
  eq('seeding is idempotent', subjects.c, 7);
  const marks = await ctx.q1('SELECT COUNT(*) AS c FROM marks');
  check('marks survive reopen', marks.c > 0, 'c=' + marks.c);
});

/* =================================================================== */
/* 11. IPC channel registry                                            */
/* =================================================================== */

section('IPC channel registry', (ctx) => {
  const expected = [
    'app:get-info',
    'app:get-db-path',
    'students:list',
    'students:create',
    'students:update',
    'students:get',
    'students:remove',
    'invoices:list',
    'invoices:next-number',
    'invoices:create',
    'invoices:update',
    'invoices:remove',
    'invoices:get',
    'invoices:add-payment',
    'invoices:payments',
    'grades:list-subjects',
    'grades:list-classes',
    'grades:add-subject',
    'grades:update-subject',
    'grades:remove-subject',
    'grades:save-marks',
    'grades:get-report',
    'grades:get-results',
    'grades:save-remark',
    'settings:get-all',
    'settings:save',
    'settings:reset',
    'dashboard:stats',
    'classes:list',
    'classes:create',
    'classes:update',
    'classes:remove',
    'subjects:list',
    'subjects:create',
    'subjects:update',
    'subjects:remove',
    'data:export-students',
    'data:export-invoices',
    'data:export-marks',
    'data:export-classes-subjects',
    'data:import-students',
    'data:import-students-dialog',
    'data:import-marks',
    'data:import-marks-dialog',
  ];
  for (const channel of expected) {
    check(`channel ${channel} registered`, ctx.registered.has(channel), 'missing');
  }
  eq('exactly the expected channels', ctx.registered.size, expected.length);
});

/* =================================================================== */
/* 12. Excel import (students)                                        */
/* =================================================================== */

section('Excel students import', async (ctx) => {
  const excel = require('./src/main/excel');
  const XLSX = require('xlsx');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campuscore-xlsx-'));
  const file = path.join(dir, 'students.xlsx');

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ['Roll No', 'Name', 'Student Class', 'Guardian', 'Phone'],
      ['x-100', 'Imported One', 'Class 3', 'Guard A', '0300-1111111'],
      ['x-101', 'Imported Two', 'Class 3', '', ''],
      ['', 'Missing roll', 'Class 3', '', ''],
      ['A-001', 'Alice Khan Jr', ctx.alice.studentClass, 'Mr. Khan', ''],
    ]),
    'Students',
  );
  XLSX.writeFile(wb, file);

  const result = await ctx.api('data:import-students', { filePath: file });
  eq('two new students imported', result.created, 2);
  eq('one existing student updated', result.updated, 1);
  eq('blank row skipped', result.skipped, 1);

  const one = await ctx.qall(
    'SELECT name, guardian, phone FROM students WHERE rollNo = ? AND studentClass = ?',
    ['x-100', 'Class 3'],
  );
  eq('imported row stored verbatim', one[0] && one[0].name, 'Imported One');
  eq('guardian stored', one[0] && one[0].guardian, 'Guard A');
  eq('phone stored', one[0] && one[0].phone, '0300-1111111');

  const blank = await ctx.qall(
    'SELECT guardian FROM students WHERE rollNo = ? AND studentClass = ?',
    ['x-101', 'Class 3'],
  );
  eq('blank optional cells accepted', blank[0] && blank[0].guardian, '');

  // Re-importing the same file must be a no-op rather than duplicating rows.
  const again = await ctx.api('data:import-students', { filePath: file });
  eq('re-import creates nothing', again.created, 0);
  eq('re-import updates nothing', again.updated, 0);
  eq('re-import skips every row', again.skipped, 4);

  const total = await ctx.q1(
    "SELECT COUNT(*) AS c FROM students WHERE rollNo LIKE 'x-%'",
  );
  eq('no duplicate rows created', total.c, 2);

  // An existing student keeps the details the file left blank.
  const alice = await ctx.q1('SELECT name, guardian, phone FROM students WHERE rollNo = ?', ['A-001']);
  eq('existing student renamed', alice.name, 'Alice Khan Jr');
  eq('blank phone did not wipe data', alice.phone, '0300-1111111');

  // Missing required columns must be reported, not silently imported.
  const badFile = path.join(dir, 'bad.xlsx');
  const badWb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(badWb, XLSX.utils.aoa_to_sheet([['Roll No', 'Name'], ['1', 'No Class']]), 'S');
  XLSX.writeFile(badWb, badFile);
  const badErr = await expectError(() => ctx.api('data:import-students', { filePath: badFile }));
  check('missing required column errors', !!badErr && /missing required column/i.test(badErr.message), String(badErr));

  const emptyFile = path.join(dir, 'empty.xlsx');
  const emptyWb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(emptyWb, XLSX.utils.aoa_to_sheet([]), 'S');
  XLSX.writeFile(emptyWb, emptyFile);
  const emptyErr = await expectError(() => ctx.api('data:import-students', { filePath: emptyFile }));
  check('empty workbook errors', !!emptyErr && /empty/i.test(emptyErr.message), String(emptyErr));

  const noPath = await expectError(() => ctx.api('data:import-students', {}));
  check('import without a file path errors', !!noPath, String(noPath));

  /* --- marks import ------------------------------------------------- */

  const marksWb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    marksWb,
    XLSX.utils.aoa_to_sheet([
      ['Roll No', 'Student Class', 'Subject', 'Marks Obtained', 'Max Marks'],
      ['A-001', ctx.alice.studentClass, 'Mathematics', 45, 50],
      ['B-001', ctx.carol.studentClass, 'Mathematics', 38, 50],
      ['A-001', ctx.alice.studentClass, 'English', 41, 50],
      ['Z-999', ctx.alice.studentClass, 'Mathematics', 10, 50],   // unknown student
    ]),
    'Marks',
  );
  const marksFile = path.join(dir, 'marks.xlsx');
  XLSX.writeFile(marksWb, marksFile);

  const marksResult = await ctx.api('data:import-marks', {
    filePath: marksFile,
    examName: 'Imported Exam',
  });
  eq('three mark rows inserted', marksResult.inserted, 3);
  eq('unknown student skipped', marksResult.skipped, 1);

  const aliceMath = await ctx.qall(
    'SELECT marksObtained, maxMarks FROM marks WHERE examName = ? AND rollNo = ? AND subject = ?',
    ['Imported Exam', 'A-001', 'Mathematics'],
  );
  eq('marks obtained stored', Number(aliceMath[0] && aliceMath[0].marksObtained), 45);
  eq('explicit max marks honoured', Number(aliceMath[0] && aliceMath[0].maxMarks), 50);

  // Re-importing the same sheet upserts rather than duplicating.
  const marksAgain = await ctx.api('data:import-marks', {
    filePath: marksFile,
    examName: 'Imported Exam',
  });
  eq('re-import inserts nothing', marksAgain.inserted, 0);
  eq('re-import updates existing rows', marksAgain.updated, 3);
  const dupeCount = await ctx.q1(
    "SELECT COUNT(*) AS c FROM marks WHERE examName = 'Imported Exam'",
  );
  eq('no duplicate mark rows', dupeCount.c, 3);

  const noExam = await expectError(() =>
    ctx.api('data:import-marks', { filePath: marksFile }),
  );
  check('marks import without exam name errors', !!noExam, String(noExam));

  const badMarks = await expectError(() =>
    ctx.api('data:import-marks', { filePath: badFile, examName: 'Imported Exam' }),
  );
  check('marks import validates columns', !!badMarks && /missing required column/i.test(badMarks.message), String(badMarks));

  check('excel module exposes importStudents', typeof excel.importStudents === 'function', typeof excel.importStudents);
  check('excel module exposes importMarks', typeof excel.importMarks === 'function', typeof excel.importMarks);

  fs.rmSync(dir, { recursive: true, force: true });
});

/* =================================================================== */
/* 12. Classes & subjects CRUD                                         */
/* =================================================================== */

section('Classes & subjects CRUD', async (ctx) => {
  // --- classes --------------------------------------------------------
  // Classes are no longer created by hand: registering a student into one
  // creates it. Earlier sections registered students in Class 1 / 2 / 3, so
  // those rows already exist by the time we get here.
  const autoClasses = await ctx.api('classes:list', {});
  check(
    'registering a student auto-created their classes',
    ['Class 1', 'Class 2', 'Class 3'].every((n) => autoClasses.some((c) => c.name === n)),
    JSON.stringify(autoClasses.map((c) => c.name)),
  );

  // Use names that do not collide with the auto-created ones.
  const c10 = await ctx.api('classes:create', { name: 'Class 10', gradeOrder: 10 });
  const c1 = await ctx.api('classes:create', { name: 'Grade 1', gradeOrder: 1 });
  const c11 = await ctx.api('classes:create', { name: 'Class 11-12', gradeOrder: 11 });
  check('class created', c10.id > 0, JSON.stringify(c10));
  eq('class grade order stored', c10.gradeOrder, 10);
  eq('class timestamp set', !!c10.createdAt, true);

  const listed = await ctx.api('classes:list', {});
  // Auto-created classes take the next free order, so they interleave with the
  // manually seeded ones rather than all landing at the front.
  const orders = listed.map((c) => Number(c.gradeOrder));
  check('class list is sorted by grade order', orders.every((o, i) => i === 0 || o >= orders[i - 1]), JSON.stringify(orders));
  check(
    'auto-created classes are still listed',
    ['Class 1', 'Class 2', 'Class 3'].every((n) => listed.some((c) => c.name === n)),
    JSON.stringify(listed.map((c) => c.name)),
  );

  // Re-sorting to the very front wins the tie against the auto-created rows.
  const reordered = await ctx.api('classes:update', { id: c1.id, name: 'Grade 1', gradeOrder: 0 });
  eq('class renamed to same name is a no-op', reordered.name, 'Grade 1');
  eq('class re-sorted to front', (await ctx.api('classes:list', {}))[0].id, c1.id);

  const renamed = await ctx.api('classes:update', { id: c11.id, name: 'Senior 11-12', gradeOrder: 11 });
  eq('class renamed', renamed.name, 'Senior 11-12');

  const noName = await expectError(() => ctx.api('classes:create', { name: '   ' }));
  check('blank class name rejected', !!noName, String(noName));

  const noGradeOrder = await expectError(() => ctx.api('classes:create', { name: 'Bad', gradeOrder: 'abc' }));
  check('non-numeric grade order rejected', !!noGradeOrder, String(noGradeOrder));

  const noId = await expectError(() => ctx.api('classes:update', { name: 'No Id', gradeOrder: 1 }));
  check('class update without id rejected', !!noId, String(noId));

  // Duplicate names are blocked by the UNIQUE index (case-insensitive).
  const dupe = await expectError(() => ctx.api('classes:create', { name: 'grade 1', gradeOrder: 1 }));
  check('duplicate class name rejected', !!dupe && /UNIQUE/i.test(dupe.message), String(dupe));

  // --- subjects -------------------------------------------------------
  eq('new class has no subjects', (await ctx.api('subjects:list', { classId: c10.id })).length, 0);

  const math = await ctx.api('subjects:create', { classId: c10.id, name: 'Mathematics', code: 'MATH' });
  const eng = await ctx.api('subjects:create', { classId: c10.id, name: 'English' });
  eq('subject defaults to Active', math.status, 'Active');
  eq('subject code stored', math.code, 'MATH');
  eq('subject code optional', eng.code, '');

  const other = await ctx.api('subjects:create', { classId: c11.id, name: 'Mathematics', code: 'M11' });
  check('same subject name allowed in a different class', other.id !== math.id, other.id);

  const scoped = await ctx.api('subjects:list', { classId: c10.id });
  eq('subjects scoped to their class', scoped.map((s) => s.name), ['Mathematics', 'English']);

  const updated = await ctx.api('subjects:update', {
    id: eng.id,
    name: 'English Language',
    code: 'ENG',
    status: 'Inactive',
  });
  eq('subject renamed', updated.name, 'English Language');
  eq('subject status changed', updated.status, 'Inactive');

  const badStatus = await expectError(() =>
    ctx.api('subjects:update', { id: eng.id, name: 'English Language', status: 'Archived' }),
  );
  check('unknown status rejected', !!badStatus, String(badStatus));

  const dupeSubject = await expectError(() =>
    ctx.api('subjects:create', { classId: c10.id, name: 'mathematics' }),
  );
  check('duplicate subject in class rejected', !!dupeSubject, String(dupeSubject));

  const orphan = await ctx.api('subjects:create', { classId: c1.id, name: 'Phonics' });
  eq('subject can be added to another class', orphan.classId, c1.id);

  // --- cascade --------------------------------------------------------
  await ctx.api('classes:remove', { id: c10.id });
  eq('class removed', (await ctx.api('classes:list', {})).some((c) => c.id === c10.id), false);

  const orphans = await ctx.q1('SELECT COUNT(*) AS c FROM class_subjects WHERE classId = ?', [c10.id]);
  eq('subjects cascaded on class delete', orphans.c, 0);

  const untouched = await ctx.api('subjects:list', { classId: c11.id });
  eq('other class subjects untouched by cascade', untouched.map((s) => s.name), ['Mathematics']);

  await ctx.api('subjects:remove', { id: untouched[0].id });
  const gone = await ctx.q1('SELECT COUNT(*) AS c FROM class_subjects WHERE id = ?', [untouched[0].id]);
  eq('subject removed', gone.c, 0);

  const unknownSubject = await expectError(() => ctx.api('subjects:remove', { id: 999999 }));
  check('removing unknown subject errors', !!unknownSubject, String(unknownSubject));

  const unknownClass = await expectError(() => ctx.api('classes:remove', { id: 999999 }));
  check('removing unknown class errors', !!unknownClass, String(unknownClass));

  const badClassId = await expectError(() => ctx.api('subjects:list', { classId: 0 }));
  check('invalid classId rejected', !!badClassId, String(badClassId));

  // --- grades subject list carries ids for the Grades tab actions -------
  // The Grades view keys its Edit/Delete buttons off subject.id, so a class
  // filtered list must expose a real id for every grades-owned subject.
  // (c1 was renamed to "Grade 1" above - query it by its current name.)
  const gradeName = (await ctx.api('classes:list', {})).find((c) => c.id === c1.id).name;
  const forGrade1 = await ctx.api('grades:list-subjects', { studentClass: gradeName });
  check('class-filtered list is non-empty', forGrade1.length > 0, JSON.stringify(forGrade1));
  check(
    'every grades-owned subject has a numeric id',
    forGrade1.filter((s) => s.source === 'grades').every((s) => Number.isFinite(Number(s.id))),
    JSON.stringify(forGrade1),
  );

  // A subject owned by the Classes & Subjects module has no grades row, so it
  // must surface as id === null rather than a broken/undefined id.
  await ctx.api('subjects:create', { classId: c1.id, name: 'Zoology' });
  const merged = await ctx.api('grades:list-subjects', { studentClass: gradeName });
  const zoology = merged.find((s) => s.name === 'Zoology');
  check('class_subjects-only subject is listed', !!zoology, JSON.stringify(merged));
  eq('class_subjects-only subject has a null id', zoology && zoology.id, null);
  eq('class_subjects-only subject marked as such', zoology && zoology.source, 'classSubjects');

  // The id a row reports must be one the update/delete channels actually accept.
  const gradesOwned = merged.find((s) => s.id !== null && s.id !== undefined);
  if (gradesOwned) {
    const roundTrip = await ctx.api('grades:update-subject', {
      id: gradesOwned.id,
      name: gradesOwned.name,
      maxMarks: gradesOwned.maxMarks,
    });
    eq('id from list is usable for update', Number(roundTrip.id), Number(gradesOwned.id));
  }
});

/* =================================================================== */
/* 13. Classes follow student registration automatically              */
/* =================================================================== */

section('Classes auto-sync with the roster', async (ctx) => {
  const names = async () => (await ctx.api('classes:list', {})).map((c) => c.name);
  const hasClass = async (name) => (await names()).some((n) => n.toLowerCase() === name.toLowerCase());

  // --- created on registration -----------------------------------------
  const nova = await ctx.api('students:create', {
    rollNo: 'SYNC-1',
    name: 'Sync One',
    studentClass: 'Play Group',
  });
  check('class created on student registration', await hasClass('Play Group'));

  // Case differences must reuse the existing row, not fork a duplicate.
  await ctx.api('students:create', { rollNo: 'SYNC-2', name: 'Sync Two', studentClass: 'play group' });
  const dupes = (await names()).filter((n) => n.toLowerCase() === 'play group');
  eq('same class in different case is not duplicated', dupes.length, 1);

  // --- grade order appended, not first --------------------------------
  const pg = (await ctx.api('classes:list', {})).find((c) => c.name === 'Play Group');
  check('auto class gets a sort order', Number.isFinite(Number(pg.gradeOrder)), JSON.stringify(pg));

  // --- created on edit move, and the old class pruned -------------------
  // "Play Group" still holds SYNC-2, so it must survive this move; the move
  // into "Nursery" creates that one instead.
  const beforeMove = (await ctx.api('classes:list', {})).length;
  await ctx.api('students:update', {
    id: nova.id,
    rollNo: 'SYNC-1',
    name: 'Sync One',
    studentClass: 'Nursery',
  });
  check('class created when a student is moved into it', await hasClass('Nursery'));
  check('old class kept while another student remains', await hasClass('Play Group'));
  eq('moving between classes adds exactly one', (await ctx.api('classes:list', {})).length, beforeMove + 1);

  // Removing the last "Play Group" student prunes the class.
  await ctx.api('students:remove', {
    id: (await ctx.qall("SELECT id FROM students WHERE studentClass = 'play group'"))[0].id,
  });
  check('old class removed once its last student left', !(await hasClass('Play Group')));
  eq('pruning keeps the class count stable', (await ctx.api('classes:list', {})).length, beforeMove);

  // --- a class with students left survives ------------------------------
  await ctx.api('students:create', { rollNo: 'SYNC-3', name: 'Sync Three', studentClass: 'Kinder' });
  await ctx.api('students:create', { rollNo: 'SYNC-4', name: 'Sync Four', studentClass: 'Kinder' });
  await ctx.api('students:remove', { id: (await ctx.qall("SELECT id FROM students WHERE rollNo = 'SYNC-4'"))[0].id });
  check('class kept while another student remains', await hasClass('Kinder'));
  const kinderLeft = await ctx.qall("SELECT id FROM students WHERE studentClass = 'Kinder'");
  eq('one Kinder student remains', kinderLeft.length, 1);
  await ctx.api('students:remove', { id: kinderLeft[0].id });
  check('class removed with its last student', !(await hasClass('Kinder')));

  // --- rename propagates everywhere ------------------------------------
  const alice = await ctx.q1("SELECT id FROM students WHERE rollNo = 'A-001' LIMIT 1");
  const aliceBefore = await ctx.q1('SELECT studentClass FROM students WHERE id = ?', [alice.id]);
  const oldName = aliceBefore.studentClass;
  const target = (await ctx.api('classes:list', {})).find((c) => c.name === oldName);
  check('roster class is a configured class', !!target, JSON.stringify(aliceBefore));

  await ctx.api('classes:update', { id: target.id, name: 'Class 1 (Renamed)', gradeOrder: target.gradeOrder });
  const aliceAfter = await ctx.q1('SELECT studentClass FROM students WHERE id = ?', [alice.id]);
  eq('rename follows the student', aliceAfter.studentClass, 'Class 1 (Renamed)');

  const inv = await ctx.q1('SELECT COUNT(*) AS c FROM invoices WHERE studentClass = ?', [oldName]);
  eq('no invoices left on the old name', inv.c, 0);
  const invNew = await ctx.q1('SELECT COUNT(*) AS c FROM invoices WHERE studentClass = ?', ['Class 1 (Renamed)']);
  check('invoices moved to the new name', invNew.c > 0, 'count=' + invNew.c);

  // subjects.className is a ', ' separated list of class names, so a rename has
  // to rewrite the matching token rather than drop the whole row.
  const stale = await ctx.qall('SELECT name, className FROM subjects');
  check(
    'no subject still names the old class',
    stale.every((s) => !String(s.className).split(',').some((n) => n.trim().toLowerCase() === oldName.toLowerCase())),
    JSON.stringify(stale.map((s) => [s.name, s.className])),
  );
  check(
    'renamed class appears on the subjects assigned to it',
    stale.some((s) => String(s.className).includes('Class 1 (Renamed)')),
    JSON.stringify(stale.map((s) => [s.name, s.className])),
  );

  // The assignment itself lives in the junction table and is keyed by class id,
  // so it must survive the rename untouched.
  const renamedSubjects = await ctx.api('grades:list-subjects', { studentClass: 'Class 1 (Renamed)' });
  check('subjects still resolve under the new name', renamedSubjects.length > 0, renamedSubjects.map((s) => s.name).join('|'));
  check(
    'resolved subjects report the new class name',
    renamedSubjects.every((s) => (s.classNames || []).some((n) => n === 'Class 1 (Renamed)')),
    JSON.stringify(renamedSubjects.map((s) => [s.name, s.classNames])),
  );
});

/* =================================================================== */
/* Runner                                                              */
/* =================================================================== */

async function main() {
  const electron = require('electron');
  const { app, ipcMain } = electron;

  // Point userData at a scratch directory so real app data is never touched.
  app.setPath('userData', TEST_DB_DIR);
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });

  await app.whenReady();

  const database = require('./src/main/database');
  const { registerIpcHandlers } = require('./src/main/ipc');

  // Intercept ipcMain.handle so the handlers can be invoked directly.
  const registered = new Map();
  const realHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, fn) => {
    if (registered.has(channel)) throw new Error('Duplicate IPC channel: ' + channel);
    registered.set(channel, fn);
  };
  registerIpcHandlers({ getWindow: () => null });
  ipcMain.handle = realHandle;

  /** Invokes a handler through the same envelope the renderer would see. */
  async function api(channel, payload) {
    const fn = registered.get(channel);
    if (!fn) throw new Error('No handler registered for ' + channel);
    const res = await fn({}, payload || {});
    if (res && res.ok === false) throw new Error(`${channel} -> ${res.error}`);
    return res ? res.data : res;
  }

  const ctx = { database, registered, api, dbFile: null };

  /** The database helpers are promise-based, so tests must await them. */
  ctx.q1 = (sql, params) => database.get(sql, params);
  ctx.qall = (sql, params) => database.all(sql, params);

  for (let i = 0; i < SECTIONS.length; i += 1) {
    const { title, fn } = SECTIONS[i];
    console.log('\n[' + (i + 1) + '] ' + title);
    console.log('-'.repeat(64));
    try {
      await fn(ctx);
    } catch (err) {
      fail(title + ' (threw)', (err && err.stack) || String(err));
    }
  }

  await database.closeDatabase();

  console.log('\n' + '='.repeat(64));
  console.log('RESULT: ' + passed + ' passed, ' + failures.length + ' failed');
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log('  - ' + f);
  }
  console.log('='.repeat(64));

  cleanup();
  // app.quit() lets Electron shut down cleanly; forcing process.exit() here
  // tears down the addon mid-flight and produces a spurious native crash.
  app.quit();
  // Fallback in case quit is blocked by a stray preventDefault().
  setTimeout(() => process.exit(failures.length ? 1 : 0), 1500);
}

main().catch((err) => {
  console.error('\nSMOKE TEST CRASHED:\n' + ((err && err.stack) || String(err)));
  cleanup();
  process.exit(1);
});