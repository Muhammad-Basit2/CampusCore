/**
 * Database layer - runs exclusively in the Electron MAIN process.
 *
 * Uses the `sqlite3` driver (N-API prebuild, so the binary is ABI-stable and
 * works under Electron without a per-version rebuild) and stores the database
 * file inside app.getPath('userData') so all data stays fully offline / local.
 */
'use strict';

const fs = require('fs');
const path = require('path');
// NOTE: verbose() must be *called* - `require('sqlite3').verbose` is the
// function itself, so using it un-called yields an object with no Database.
const sqlite3 = require('sqlite3').verbose();
const { app } = require('electron');

/** @type {import('sqlite3').Database | null} */
let db = null;

// Subjects are configurable per class. className stores either a real class
// name or this wildcard, meaning "applies to every class". A class-specific row
// always takes precedence over the wildcard for that class.
const WILDCARD_CLASS = '*';

/** Single-quotes a literal for inline use in DDL (never for user data). */
function q(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

// Pre-rename identity, kept so an existing installation carries its data over.
const LEGACY_APP_DIR = 'CappusCore';
const LEGACY_DB_FILE = 'cappuscore.db';

const DEFAULT_SETTINGS = {
  schoolName: 'CampusCore School',
  schoolTagline: 'Excellence in Education',
  schoolAddress: 'Main Campus Road, Lahore',
  schoolPhone: '+92 300 1234567',
  schoolEmail: 'info@campuscore.edu',
  schoolLogo: '',
  principalName: 'Dr. Ayesha Khan',
  teacherName: 'Mr. Basit',
  academicYear: '2026-2027',
  reportHeading: 'Academic Performance Report',
  currency: 'PKR',
  currencySymbol: 'Rs',
  invoicePrefix: 'INV-',
  invoiceFooter: 'Thank you for your payment. Please keep this invoice safe.',
  passMarkPercentage: '50',
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS students (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  rollNo        TEXT    NOT NULL,
  name          TEXT    NOT NULL,
  studentClass  TEXT    NOT NULL DEFAULT 'Class 1',
  guardian      TEXT    NOT NULL DEFAULT '',
  phone         TEXT    NOT NULL DEFAULT '',
  createdAt     TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_students_name  ON students(name);
CREATE INDEX IF NOT EXISTS idx_students_class ON students(studentClass);
CREATE UNIQUE INDEX IF NOT EXISTS idx_students_roll_class ON students(rollNo COLLATE NOCASE, studentClass);

CREATE TABLE IF NOT EXISTS invoices (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  invoiceNo     TEXT    NOT NULL UNIQUE,
  studentId     INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  rollNo        TEXT    NOT NULL,
  studentName   TEXT    NOT NULL,
  studentClass  TEXT    NOT NULL DEFAULT '',
  feeMonth      TEXT    NOT NULL,
  description   TEXT    NOT NULL DEFAULT 'Tuition Fee',
  amountDue     REAL    NOT NULL DEFAULT 0,
  discount      REAL    NOT NULL DEFAULT 0,
  amountPaid    REAL    NOT NULL DEFAULT 0,
  status        TEXT    NOT NULL DEFAULT 'Unpaid',
  notes         TEXT    NOT NULL DEFAULT '',
  createdAt     TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_invoices_student ON invoices(studentId);
CREATE INDEX IF NOT EXISTS idx_invoices_month   ON invoices(feeMonth);

CREATE TABLE IF NOT EXISTS payments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  invoiceId  INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  amount     REAL    NOT NULL DEFAULT 0,
  method     TEXT    NOT NULL DEFAULT 'Cash',
  reference  TEXT    NOT NULL DEFAULT '',
  note       TEXT    NOT NULL DEFAULT '',
  paidOn     TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoiceId);

CREATE TABLE IF NOT EXISTS subjects (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL COLLATE NOCASE,
  className  TEXT    NOT NULL DEFAULT '*',
  maxMarks   REAL    NOT NULL DEFAULT 100,
  sortOrder  INTEGER NOT NULL DEFAULT 0,
  createdAt  TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
-- NB: the UNIQUE (name, className) index is created by migrateClassSubjects()
-- rather than here, because SCHEMA also runs against legacy databases whose
-- subjects table still has the old shape at this point.

CREATE TABLE IF NOT EXISTS classes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  gradeOrder  INTEGER NOT NULL DEFAULT 0,
  createdAt   TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_classes_order ON classes(gradeOrder);

CREATE TABLE IF NOT EXISTS class_subjects (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  classId    INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  name       TEXT    NOT NULL COLLATE NOCASE,
  code       TEXT    NOT NULL DEFAULT '',
  status     TEXT    NOT NULL DEFAULT 'Active',
  createdAt  TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (classId, name COLLATE NOCASE)
);
CREATE INDEX IF NOT EXISTS idx_class_subjects_class ON class_subjects(classId);

CREATE TABLE IF NOT EXISTS marks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  studentId      INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  rollNo         TEXT    NOT NULL,
  studentClass   TEXT    NOT NULL DEFAULT '',
  subject        TEXT    NOT NULL,
  marksObtained  REAL    NOT NULL DEFAULT 0,
  maxMarks       REAL    NOT NULL DEFAULT 100,
  examName       TEXT    NOT NULL DEFAULT 'Term 1',
  updatedAt      TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  -- studentClass is part of the key because a roll number is only unique
  -- WITHIN a class, so the same roll in two classes is two different
  -- students who must not overwrite each other's marks.
  UNIQUE (rollNo, studentClass, subject, examName)
);
CREATE INDEX IF NOT EXISTS idx_marks_roll  ON marks(rollNo);
CREATE INDEX IF NOT EXISTS idx_marks_exam  ON marks(examName);

CREATE TABLE IF NOT EXISTS reportRemarks (
  rollNo    TEXT PRIMARY KEY,
  remark    TEXT NOT NULL DEFAULT '',
  updatedAt TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
`;

const SEED_SUBJECTS = [
  'English',
  'Mathematics',
  'Physics',
  'Chemistry',
  'Biology',
  'Computer Science',
  'Social Studies',
];


/* ------------------------------------------------------------------ */
/* Promise wrappers around sqlite3                                     */
/* ------------------------------------------------------------------ */

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onDone(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

function exec(sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err) => (err ? reject(err) : resolve()));
  });
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

function getDatabaseFile() {
  return path.join(app.getPath('userData'), 'data', 'campuscore.db');
}

/**
 * The app was renamed from "CappusCore" to "CampusCore". That change moved BOTH
 * the database filename AND the userData folder, so an existing install would
 * otherwise appear to start with a brand-new, empty database.
 *
 * Before opening, copy the old database across if the new one is absent. Runs
 * once: on the next start the new file already exists and this is a no-op.
 */
function migrateLegacyDatabase() {
  const target = getDatabaseFile();
  if (fs.existsSync(target)) return null;

  // The legacy database lived in the OLD userData folder, which is a sibling of
  // the current one (both under %APPDATA%). Deriving it from the current
  // userData - rather than from an absolute appData path - keeps this correct
  // when userData is redirected (tests, portable mode) instead of reaching into
  // a real install that the caller did not ask for.
  const legacyRoot = path.join(path.dirname(app.getPath('userData')), LEGACY_APP_DIR);
  const candidates = [
    path.join(path.dirname(target), LEGACY_DB_FILE),
    path.join(legacyRoot, 'data', LEGACY_DB_FILE),
  ];

  for (const legacy of candidates) {
    if (!fs.existsSync(legacy)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(legacy, target);
    // WAL sidecars hold committed data that is not yet in the main file.
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = legacy + suffix;
      if (fs.existsSync(sidecar)) fs.copyFileSync(sidecar, target + suffix);
    }
    return legacy;
  }
  return null;
}

async function initDatabase() {
  if (db) return getDatabaseFile();

  const migratedFrom = migrateLegacyDatabase();
  const file = getDatabaseFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });

  await new Promise((resolve, reject) => {
    db = new sqlite3.Database(file, (err) => (err ? reject(err) : resolve()));
  });

  await exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  await exec(SCHEMA);
  await migrateRollNoUniqueness();
  await migrateClassSubjects();
  await seedDefaults();
  if (migratedFrom) {
    console.log(`[database] carried over existing data from ${migratedFrom}`);
  }
  return file;
}

async function seedDefaults() {
  const count = await get('SELECT COUNT(*) AS c FROM subjects');
  if (!count || count.c === 0) {
    for (let i = 0; i < SEED_SUBJECTS.length; i += 1) {
      await run(
        'INSERT OR IGNORE INTO subjects (name, className, maxMarks, sortOrder) VALUES (?, ?, ?, ?)',
        [SEED_SUBJECTS[i], WILDCARD_CLASS, 100, i + 1],
      );
    }
  }
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', [key, String(value)]);
  }
}

/**
 * Migration: allows duplicate roll numbers across different classes.
 *
 * Existing databases have `UNIQUE` on the rollNo column, which prevents
 * the same roll number in different classes. This migration recreates the
 * students table without that constraint and adds a composite unique index
 * on (rollNo, studentClass) instead.
 */
async function migrateRollNoUniqueness() {
  const indexes = await all(
    "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='students'",
  );
  const hasOldUnique = indexes.some((idx) => idx.name === 'sqlite_autoindex_students_1');
  if (!hasOldUnique) return; // already migrated or fresh DB

  // Create the new table without the UNIQUE constraint on rollNo
  await run(`
    CREATE TABLE students_new (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      rollNo        TEXT    NOT NULL,
      name          TEXT    NOT NULL,
      studentClass  TEXT    NOT NULL DEFAULT 'Class 1',
      guardian      TEXT    NOT NULL DEFAULT '',
      phone         TEXT    NOT NULL DEFAULT '',
      createdAt     TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
    )
  `);

  // Copy all existing rows
  await run('INSERT INTO students_new SELECT * FROM students');

  // Drop old table and rename
  await run('DROP TABLE students');
  await run('ALTER TABLE students_new RENAME TO students');

  // Re-create indexes
  await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_students_roll_class ON students(rollNo COLLATE NOCASE, studentClass)');
  await run('CREATE INDEX IF NOT EXISTS idx_students_name ON students(name)');
  await run('CREATE INDEX IF NOT EXISTS idx_students_class ON students(studentClass)');
}

/**
 * Migration: subjects become per-class, and marks are keyed by class too.
 *
 * Two changes, both required for per-class subjects to work:
 *
 *  1. `subjects` gains a `className` column. Existing rows become '*' (the
 *     "all classes" wildcard) so no subject disappears from any grid, and the
 *     old global UNIQUE(name) is replaced by UNIQUE(name, className) so the
 *     same subject name may be configured differently per class.
 *
 *  2. `marks` gains `studentClass`, which joins its unique key. A roll number
 *     is only unique WITHIN a class, so the old key (rollNo, subject, examName)
 *     silently merged two students who happened to share a roll number across
 *     different classes.
 *
 * Both rebuild their table. The DDL is written out here rather than reused from
 * SCHEMA, because SCHEMA only ever runs against a fresh (empty) database.
 */
async function migrateClassSubjects() {
  // --- subjects: add className, drop the global UNIQUE(name) ------------
  const subjectCols = await all('PRAGMA table_info(subjects)');
  if (!subjectCols.some((c) => c.name === 'className')) {
    // Guard against a previous crashed run leaving subjects_new behind.
    await run('DROP TABLE IF EXISTS subjects_new');
    await exec([
      'CREATE TABLE subjects_new (',
      '  id         INTEGER PRIMARY KEY AUTOINCREMENT,',
      '  name       TEXT    NOT NULL COLLATE NOCASE,',
      '  className  TEXT    NOT NULL DEFAULT ' + q(WILDCARD_CLASS) + ',',
      '  maxMarks   REAL    NOT NULL DEFAULT 100,',
      '  sortOrder  INTEGER NOT NULL DEFAULT 0,',
      "  createdAt  TEXT    NOT NULL DEFAULT (datetime('now','localtime'))",
      ')',
    ].join('\n'));
    // '*' preserves the old behaviour: every subject applied to every class.
    const hasCreatedAt = subjectCols.some((c) => c.name === 'createdAt');
    await run(
      'INSERT INTO subjects_new (id, name, className, maxMarks, sortOrder, createdAt) ' +
        'SELECT id, name, ' +
          q(WILDCARD_CLASS) +
          ', maxMarks, sortOrder' +
          ', ' +
          (hasCreatedAt ? 'createdAt' : q(null)) +
          ' FROM subjects',
    );
    await run('DROP TABLE subjects');
    await run('ALTER TABLE subjects_new RENAME TO subjects');
    await exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_subjects_name_class ON subjects(name, className)',
    );
  }

  // --- marks: add studentClass to the key -------------------------------
  const markCols = await all('PRAGMA table_info(marks)');
  if (!markCols.some((c) => c.name === 'studentClass')) {
    // Guard against a previous crashed run leaving marks_new behind.
    await run('DROP TABLE IF EXISTS marks_new');
    await exec([
      'CREATE TABLE marks_new (',
      '  id             INTEGER PRIMARY KEY AUTOINCREMENT,',
      '  studentId      INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,',
      '  rollNo         TEXT    NOT NULL,',
      '  studentClass   TEXT    NOT NULL DEFAULT ' + q('') + ',',
      '  subject        TEXT    NOT NULL,',
      '  marksObtained  REAL    NOT NULL DEFAULT 0,',
      '  maxMarks       REAL    NOT NULL DEFAULT 100,',
      "  examName       TEXT    NOT NULL DEFAULT 'Term 1',",
      "  updatedAt      TEXT    NOT NULL DEFAULT (datetime('now','localtime')),",
      '  UNIQUE (rollNo, studentClass, subject, examName)',
      ')',
    ].join('\n'));
    // Backfill the class from the student row, so existing marks survive and
    // two students sharing a roll number stop collapsing into one.
    await run(
      'INSERT INTO marks_new (id, studentId, rollNo, studentClass, subject, ' +
        'marksObtained, maxMarks, examName, updatedAt) ' +
        'SELECT m.id, m.studentId, m.rollNo, IFNULL(s.studentClass, ' + q('') + '), ' +
        'm.subject, m.marksObtained, m.maxMarks, m.examName, m.updatedAt ' +
        'FROM marks m LEFT JOIN students s ON s.id = m.studentId',
    );
    await run('DROP TABLE marks');
    await run('ALTER TABLE marks_new RENAME TO marks');
    await exec(
      'CREATE INDEX IF NOT EXISTS idx_marks_roll ON marks(rollNo);' +
        'CREATE INDEX IF NOT EXISTS idx_marks_exam ON marks(examName);',
    );
  }

  // The UNIQUE (name, className) index is also needed on fresh databases, where
  // the subjects table already has the column but the rebuild above is skipped.
  await exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_subjects_name_class ON subjects(name, className)',
  );

  // --- classes & class_subjects tables --------------------------------
  const classCols = await all('PRAGMA table_info(classes)');
  if (classCols.length === 0) {
    await exec(`
      CREATE TABLE classes (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
        gradeOrder  INTEGER NOT NULL DEFAULT 0,
        createdAt  TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
      );
      CREATE INDEX IF NOT EXISTS idx_classes_order ON classes(gradeOrder);
    `);
  }
  const csCols = await all('PRAGMA table_info(class_subjects)');
  if (csCols.length === 0) {
    await exec(`
      CREATE TABLE class_subjects (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        classId    INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
        name       TEXT    NOT NULL COLLATE NOCASE,
        code       TEXT    NOT NULL DEFAULT '',
        status     TEXT    NOT NULL DEFAULT 'Active',
        createdAt  TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
        UNIQUE (classId, name COLLATE NOCASE)
      );
      CREATE INDEX IF NOT EXISTS idx_class_subjects_class ON class_subjects(classId);
    `);
  }
}

/**
 * Closes the database.
 *
 * Returns a promise that resolves once SQLite has actually finished closing.
 * Callers on the app-quit path may ignore the result, but anything that is
 * about to tear the process down should await it: exiting while the native
 * handle is still closing makes the addon throw during shutdown.
 */
function closeDatabase() {
  if (!db) return Promise.resolve();
  const handle = db;
  db = null;
  return new Promise((resolve) => {
    try {
      handle.close(() => resolve());
    } catch (_) {
      resolve();
    }
  });
}

function isDatabaseOpen() {
  return db !== null;
}

module.exports = {
  initDatabase,
  closeDatabase,
  isDatabaseOpen,
  getDatabaseFile,
  run,
  get,
  all,
  exec,
  DEFAULT_SETTINGS,
  WILDCARD_CLASS,
};
