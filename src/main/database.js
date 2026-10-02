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

// Subjects are always assigned to one or more real classes. The assignments
// live in the subject_classes junction table; subjects.className (a comma
// separated list of class names) and subjects.classIds (a JSON array of class
// ids) are a denormalised copy kept for cheap reads and the Excel export.
//
// '*' is NOT a user facing concept any more - there is no "shared subject" that
// silently applies to every class. It only survives as the legacy marker on rows
// written before classes were explicit, and as the marker used while seeding a
// brand new database. migrateClassSubjects()/attachUnassignedSubjects() turn
// those rows into real assignments, so a subject never stays classless as soon
// as one class exists.
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
  className  TEXT    NOT NULL DEFAULT '',   -- denormalised ', ' separated class names
  classIds   TEXT    NOT NULL DEFAULT '[]', -- denormalised JSON array of class ids
  maxMarks   REAL    NOT NULL DEFAULT 100,
  sortOrder  INTEGER NOT NULL DEFAULT 0,
  createdAt  TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);

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

-- Authoritative subject -> class assignment. subjects.className/classIds are a
-- denormalised copy of these rows, kept for cheap reads and the Excel export.
CREATE TABLE IF NOT EXISTS subject_classes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  subjectId  INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  classId    INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  createdAt  TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (subjectId, classId)
);
CREATE INDEX IF NOT EXISTS idx_subject_classes_subject ON subject_classes(subjectId);
CREATE INDEX IF NOT EXISTS idx_subject_classes_class   ON subject_classes(classId);

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
  // Rows that still carry no explicit assignment (the seeded defaults on a fresh
  // database, legacy rows on an existing one) are attached to every class, so
  // "no class selected" is never a state the user can reach or observe.
  await attachUnassignedSubjects();
  if (migratedFrom) {
    console.log(`[database] carried over existing data from ${migratedFrom}`);
  }
  return file;
}

async function seedDefaults() {
  const count = await get('SELECT COUNT(*) AS c FROM subjects');
  if (!count || count.c === 0) {
    // Seeded before any class exists, so the rows start out unassigned;
    // attachUnassignedSubjects() links them to the classes as they appear.
    for (let i = 0; i < SEED_SUBJECTS.length; i += 1) {
      await run(
        'INSERT OR IGNORE INTO subjects (name, className, classIds, maxMarks, sortOrder) VALUES (?, ?, ?, ?, ?)',
        [SEED_SUBJECTS[i], '', '[]', 100, i + 1],
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
 *  1. `subjects` gains a `className` column. Existing rows start out with no
 *     class and are attached to every class by attachUnassignedSubjects(), so no
 *     subject disappears from any grid, and the old global UNIQUE(name) is
 *     replaced by UNIQUE(name, className) so the same subject name may be
 *     configured differently per class.
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
      '  className  TEXT    NOT NULL DEFAULT ' + q('') + ',',
      '  classIds   TEXT    NOT NULL DEFAULT ' + q('[]') + ',',
      '  maxMarks   REAL    NOT NULL DEFAULT 100,',
      '  sortOrder  INTEGER NOT NULL DEFAULT 0,',
      "  createdAt  TEXT    NOT NULL DEFAULT (datetime('now','localtime'))",
      ')',
    ].join('\n'));
    // Existing rows have no class yet. They are linked to every class by
    // attachUnassignedSubjects(), which preserves the old behaviour without
    // keeping a "shared with all classes" row in the data model.
    const hasCreatedAt = subjectCols.some((c) => c.name === 'createdAt');
    await run(
      'INSERT INTO subjects_new (id, name, className, classIds, maxMarks, sortOrder, createdAt) ' +
        'SELECT id, name, ' +
          q('') +
          ', ' +
          q('[]') +
          ', maxMarks, sortOrder' +
          ', ' +
          (hasCreatedAt ? 'createdAt' : q(null)) +
          ' FROM subjects',
    );
    await run('DROP TABLE subjects');
    await run('ALTER TABLE subjects_new RENAME TO subjects');
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

  // The junction table is the source of truth; subjects.className/classIds are
  // denormalised and must never carry their own UNIQUE constraint — a comma-
  // separated class list collides as soon as two subjects share the same name
  // and the same class set. Drop any legacy index left behind by the prior build.
  await exec(
    "DROP INDEX IF EXISTS idx_subjects_name_class",
  );

  // --- subjects: add classIds for multi-class support ----------------------
  // Added with a usable default so no row can end up NULL: the renderer and the
  // Excel export both parse this column unconditionally.
  const subjCols = await all('PRAGMA table_info(subjects)');
  if (!subjCols.some((c) => c.name === 'classIds')) {
    await run("ALTER TABLE subjects ADD COLUMN classIds TEXT NOT NULL DEFAULT '[]'");
    await run("UPDATE subjects SET classIds = '[]' WHERE classIds IS NULL OR classIds = ''");
  }

  // --- subject_classes junction table for multi-class assignment -----------
  // The table is also part of SCHEMA, so on a fresh database it already exists
  // and this is a no-op. The guard is here for databases upgraded from a build
  // that predates the junction table.
  const scCols = await all('PRAGMA table_info(subject_classes)');
  if (scCols.length === 0) {
    await exec(`
      CREATE TABLE subject_classes (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        subjectId  INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
        classId    INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
        createdAt  TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
        UNIQUE (subjectId, classId)
      );
      CREATE INDEX IF NOT EXISTS idx_subject_classes_subject ON subject_classes(subjectId);
      CREATE INDEX IF NOT EXISTS idx_subject_classes_class ON subject_classes(classId);
    `);
  }

  // Backfill the junction table from the pre-multi-class className column. The
  // old value was a single class name, an empty string or the '*' marker; the
  // interim multi-class build wrote a comma separated list. All three are read
  // as a list of class names, and anything that is not a real class (including
  // '*') is dropped - those rows are picked up by attachUnassignedSubjects().
  const existingRows = (await all('SELECT id, className FROM subjects')) || [];
  for (const row of existingRows) {
    const linked = await all(
      'SELECT classId FROM subject_classes WHERE subjectId = ?',
      [row.id],
    );
    if (linked && linked.length) continue; // already migrated

    const names = String(row.className || '')
      .split(',')
      .map((n) => n.trim())
      .filter((n) => n && n !== WILDCARD_CLASS);
    for (const name of names) {
      const clsRow = await get(
        'SELECT id FROM classes WHERE name = ? COLLATE NOCASE',
        [name],
      );
      if (!clsRow) continue;
      await run(
        'INSERT OR IGNORE INTO subject_classes (subjectId, classId) VALUES (?, ?)',
        [row.id, clsRow.id],
      );
    }
  }

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

  // The junction table is the source of truth, so the denormalised columns have
  // to agree with it before any query reads them.
  await refreshSubjectClassColumns();
}

/**
 * Recomputes subjects.className (', ' separated names) and subjects.classIds
 * (JSON array) from the subject_classes junction table.
 *
 * The junction table is authoritative; these two columns are a denormalised copy
 * that keeps `SELECT * FROM subjects` self-describing for the Excel export and
 * lets the renderer show the assigned classes without a second query.
 */
async function refreshSubjectClassColumns() {
  const rows = (await all('SELECT id FROM subjects')) || [];
  for (const row of rows) {
    const links = (await all(
      `SELECT c.id, c.name
         FROM subject_classes sc
         JOIN classes c ON c.id = sc.classId
        WHERE sc.subjectId = ?
        ORDER BY c.gradeOrder ASC, c.name COLLATE NOCASE ASC`,
      [row.id],
    )) || [];
    await run('UPDATE subjects SET className = ?, classIds = ? WHERE id = ?', [
      links.map((l) => l.name).join(', '),
      JSON.stringify(links.map((l) => l.id)),
      row.id,
    ]);
  }
}

/**
 * Gives every subject that has no class assignment to every class that exists.
 *
 * This is the only route by which a subject is ever attached to a class it was
 * not explicitly configured for, and it exists purely to keep the two cases the
 * user can create from ending up invisible:
 *
 *  - a brand new database, where the seeded subjects are written before the
 *    first student (and therefore the first class) exists;
 *  - an existing database whose subjects predate class assignment, where the
 *    old wildcard meant "applies everywhere".
 *
 * Once a subject has an assignment of its own, this never touches it again, so
 * a teacher who narrows a subject to one class keeps it there.
 *
 * Returns true when at least one link was created.
 */
async function attachUnassignedSubjects() {
  const classes = (await all('SELECT id FROM classes ORDER BY gradeOrder, name')) || [];
  if (!classes.length) return false;

  const orphans = (await all(
    `SELECT id FROM subjects
      WHERE NOT EXISTS (SELECT 1 FROM subject_classes sc WHERE sc.subjectId = subjects.id)`,
  )) || [];
  if (!orphans.length) return false;

  for (const subject of orphans) {
    for (const cls of classes) {
      await run(
        'INSERT OR IGNORE INTO subject_classes (subjectId, classId) VALUES (?, ?)',
        [subject.id, cls.id],
      );
    }
  }
  await refreshSubjectClassColumns();
  return true;
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
  attachUnassignedSubjects,
  refreshSubjectClassColumns,
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
