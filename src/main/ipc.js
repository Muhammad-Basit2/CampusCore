/**
 * IPC handler registry.
 *
 * Every handler returns a uniform envelope { ok, data } / { ok:false, error }
 * so the renderer never receives a raw rejection. All input is validated and
 * all SQL uses bound parameters (no string concatenation of user data).
 */
'use strict';

const { app, ipcMain, dialog, shell } = require('electron');

const db = require('./database');
const { buildReport, gradeFor, round } = require('./grading');

/* ------------------------------------------------------------------ */
/* Infrastructure                                                      */
/* ------------------------------------------------------------------ */

const channels = new Set();

function handle(channel, fn) {
  if (channels.has(channel)) throw new Error(`Duplicate IPC channel: ${channel}`);
  channels.add(channel);
  ipcMain.handle(channel, async (_event, payload) => {
    try {
      const data = await fn(payload || {});
      return { ok: true, data };
    } catch (err) {
      const message = (err && err.message) || String(err);
      console.error(`[ipc] ${channel} failed:`, message);
      return { ok: false, error: message };
    }
  });
}

/* ---------------------------- validation ---------------------------- */

class ValidationError extends Error {}

function str(value, field, { required = false, max = 500 } = {}) {
  const v = value === undefined || value === null ? '' : String(value).trim();
  if (required && !v) throw new ValidationError(`${field} is required`);
  if (v.length > max) throw new ValidationError(`${field} must be ${max} characters or fewer`);
  return v;
}

function num(value, field, { min = -Infinity, max = Infinity, fallback = 0 } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const v = Number(value);
  if (!Number.isFinite(v)) throw new ValidationError(`${field} must be a number`);
  if (v < min) throw new ValidationError(`${field} must be at least ${min}`);
  if (v > max) throw new ValidationError(`${field} must be at most ${max}`);
  return v;
}

function int(value, field, opts = {}) {
  return Math.trunc(num(value, field, opts));
}

function oneOf(value, allowed, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const v = String(value);
  if (!allowed.includes(v)) throw new ValidationError(`Invalid value "${v}"`);
  return v;
}

function ids(value, field = 'ids') {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map((v) => int(v, field, { min: 1 })).filter(Boolean);
  // Single ID passed as string/number
  const v = int(value, field, { min: 1 });
  return v ? [v] : [];
}

function id(value, field = 'id') {
  const v = int(value, field, { min: 1 });
  if (!v) throw new ValidationError(`${field} is required`);
  return v;
}

/**
 * The class categories a school can put a class into.
 *
 * These keys are the shared vocabulary between the renderer (which draws the
 * groups and the Select All controls) and this layer (which has to reject a key
 * it does not recognise). They must stay in step with CLASS_CATEGORIES in
 * renderer/js/grades.js; the smoke test reads both files and asserts the two
 * agree, so they cannot drift apart silently.
 */
const CLASS_CATEGORY_KEYS = [
  'preprimary',
  'primary',
  'middle',
  'high',
  'intermediate',
];

/**
 * Normalises a class's categoryKey.
 *
 * Returns undefined when the caller did not mention the field at all, which is
 * the signal to leave the stored value alone. '' is a real value - the honest
 * "not assigned by hand" choice - and is always allowed, because the renderer
 * then falls back to the band implied by the class's gradeOrder.
 */
function categoryKeyOf(value) {
  if (value === undefined || value === null) return undefined;
  return oneOf(str(value, 'Category', { max: 40 }), CLASS_CATEGORY_KEYS, '');
}

/* ------------------------------ helpers ----------------------------- */

function computeStatus(amountDue, discount, amountPaid) {
  const payable = round(amountDue - discount, 2);
  if (payable <= 0) return 'Paid';
  if (amountPaid >= payable) return 'Paid';
  if (amountPaid > 0) return 'Partial';
  return 'Unpaid';
}

async function getSettings() {
  const rows = await db.all('SELECT key, value FROM settings');
  const out = { ...db.DEFAULT_SETTINGS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}

function notify(ctx, what) {
  const win = ctx.getWindow && ctx.getWindow();
  if (win && !win.isDestroyed()) win.webContents.send('data:changed', what);
}

/* ------------------------------------------------------------------ */
/* Automatic class synchronisation                                    */
/* ------------------------------------------------------------------ */

/**
 * Makes sure `className` exists in the classes table.
 *
 * Classes are no longer created by hand anywhere in the UI: they appear as
 * soon as a student is registered into them. This helper is the single place
 * that does it, so every entry point (student form, Excel import, ...) stays
 * in step. Returns { row, created } - created is true only when this call is
 * what brought the class into existence - or null for a blank name.
 *
 * Existing classes are matched case-insensitively and keep their stored
 * spelling, so "class 5" does not fork into a second row next to "Class 5".
 */
async function ensureClass(className) {
  const name = String(className || '').trim();
  if (!name) return null;

  const existing = await db.get('SELECT * FROM classes WHERE name = ? COLLATE NOCASE', [name]);
  if (existing) return { row: existing, created: false };

  // Append after the highest existing gradeOrder so a new class lands at the
  // end of the pills rather than jumping to the front.
  const maxRow = await db.get('SELECT IFNULL(MAX(gradeOrder), 0) AS maxOrder FROM classes');
  const nextOrder = Number(maxRow && maxRow.maxOrder) + 1;

  await db.run('INSERT INTO classes (name, gradeOrder) VALUES (?, ?)', [name, nextOrder]);
  const row = await db.get('SELECT * FROM classes WHERE name = ? COLLATE NOCASE', [name]);
  // A brand new class must not start with an empty curriculum, so the subjects
  // that are still unassigned (the seeded defaults) are attached to it here.
  await db.attachUnassignedSubjects();
  return { row, created: true };
}

/**
 * Drops a class once its last student leaves, so the class list tracks the
 * roster in both directions. Both kinds of class subject cascade with the row.
 *
 * Only classes that have no remaining students are removed.
 */
async function pruneClassIfEmpty(className) {
  const name = String(className || '').trim();
  if (!name) return false;

  const stillUsed = await db.get(
    'SELECT COUNT(*) AS c FROM students WHERE studentClass = ? COLLATE NOCASE',
    [name],
  );
  if (Number(stillUsed && stillUsed.c) > 0) return false;

  const res = await db.run('DELETE FROM classes WHERE name = ? COLLATE NOCASE', [name]);
  if (res.changes > 0) {
    // subject_classes rows cascade with the class, which would leave the
    // denormalised subject columns pointing at a class that no longer exists.
    await db.refreshSubjectClassColumns();
  }
  return res.changes > 0;
}

/**
 * Registers every distinct class on the roster that has no classes row yet.
 *
 * Used by the bulk Excel import, where rows land straight in the students table
 * and there is no per-student hook to call ensureClass from. Returns true when
 * at least one class was created.
 */
async function syncClassesFromRoster() {
  const rows = await db.all(
    "SELECT DISTINCT studentClass FROM students WHERE TRIM(studentClass) <> ''",
  );
  let created = false;
  for (const row of rows) {
    const result = await ensureClass(row.studentClass);
    if (result && result.created) created = true;
  }
  return created;
}

/**
 * Renames a class everywhere it is referenced.
 *
 * The classes table is the label, but students, invoices, marks and grades
 * subjects all store the class as text, so a rename has to follow through or
 * the class silently disappears from every report.
 */
async function renameClassEverywhere(fromName, toName) {
  const from = String(fromName || '').trim();
  const to = String(toName || '').trim();
  if (!from || !to || from.toLowerCase() === to.toLowerCase()) return false;

  await db.run('UPDATE students    SET studentClass = ? WHERE studentClass = ? COLLATE NOCASE', [to, from]);
  await db.run('UPDATE invoices    SET studentClass = ? WHERE studentClass = ? COLLATE NOCASE', [to, from]);
  await db.run('UPDATE marks       SET studentClass = ? WHERE studentClass = ? COLLATE NOCASE', [to, from]);
  // subjects.className is a denormalised ', ' separated list of class names, so
  // the rename has to rewrite the matching token rather than the whole value -
  // a subject assigned to "Class 1, Class 2" must keep its Class 2 link.
  const subjects = await db.all(
    "SELECT id, className FROM subjects WHERE className LIKE ? COLLATE NOCASE",
    [`%${from}%`],
  );
  for (const row of subjects) {
    const names = String(row.className || '')
      .split(',')
      .map((n) => n.trim());
    if (!names.some((n) => n.toLowerCase() === from.toLowerCase())) continue;
    const next = names
      .map((n) => (n.toLowerCase() === from.toLowerCase() ? to : n))
      .join(', ');
    await db.run('UPDATE subjects SET className = ? WHERE id = ?', [next, row.id]);
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Class-aware subject resolution                                      */
/* ------------------------------------------------------------------ */

/**
 * Normalises a class filter coming from the renderer.
 *
 * The empty string and the legacy wildcard both mean "no class filter", which
 * makes the subject list the union of every configured subject. Anything else is
 * an exact (case-insensitive) class name.
 */
function normaliseClassFilter(value) {
  const v = value === undefined || value === null ? '' : String(value).trim();
  if (!v || v === db.WILDCARD_CLASS) return '';
  return v;
}

/**
 * The classes a subject is explicitly assigned to, as { id, name } pairs.
 *
 * Read from the subject_classes junction table, which is the authoritative
 * assignment. A subject may be assigned to any number of classes, so callers
 * must render all of them rather than picking one.
 */
async function classesForSubject(subjectId) {
  return db.all(
    `SELECT c.id, c.name
       FROM subject_classes sc
       JOIN classes c ON c.id = sc.classId
      WHERE sc.subjectId = ?
      ORDER BY c.gradeOrder ASC, c.name COLLATE NOCASE ASC`,
    [subjectId],
  );
}

/**
 * The subjects that apply to one class, in display order.
 *
 * A subject appears when the class is explicitly one of its assignments. There
 * is no wildcard row and no implicit "applies to everything" fallback, so a
 * subject configured for Class 1 is invisible to Class 2. The same name may be
 * configured separately per class; the assignment for the requested class wins
 * when the merge below meets a duplicate.
 *
 * Subjects defined in the Classes & Subjects module (class_subjects table) are
 * also included so that the report card pulls from both management areas.
 *
 * With no class the whole catalogue is returned, with each subject carrying the
 * list of classes it belongs to so the renderer can label the rows.
 */
async function subjectsForClass(className) {
  const cls = normaliseClassFilter(className);

  // 1. Resolve the class (if any) to its id - assignment is by id, never by name.
  let classRow = null;
  if (cls) {
    classRow = await db.get('SELECT id, name FROM classes WHERE name = ? COLLATE NOCASE', [cls]);
  }

  // 2. Fetch the grades subjects that are explicitly assigned to this class.
  const gradeRows = classRow
    ? await db.all(
        `SELECT s.* FROM subjects s
           JOIN subject_classes sc ON sc.subjectId = s.id
          WHERE sc.classId = ?
          ORDER BY s.sortOrder ASC, s.name COLLATE NOCASE ASC`,
        [classRow.id],
      )
    : await db.all(
        'SELECT * FROM subjects ORDER BY sortOrder ASC, name COLLATE NOCASE ASC',
      );

  // 3. Fetch from the classes & subjects module (class_subjects table).
  let csRows = [];
  if (classRow) {
    csRows = await db.all(
      'SELECT id, name, code, status FROM class_subjects WHERE classId = ? AND status = ?',
      [classRow.id, 'Active'],
    );
  }

  // 4. Merge: grade rows take priority; class_subjects fill gaps.
  const byName = new Map();
  for (const row of gradeRows) {
    // The row id travels with the subject: the Grades view keys its edit and
    // delete actions off it, so dropping it here leaves those buttons inert.
    const assigned = await classesForSubject(row.id);
    byName.set(row.name.toLowerCase(), {
      id: row.id,
      name: row.name,
      maxMarks: Number(row.maxMarks) || 100,
      code: row.code || '',
      sortOrder: Number(row.sortOrder) || 0,
      classIds: assigned.map((a) => a.id),
      classNames: assigned.map((a) => a.name),
      // Kept for the Excel export and for the denormalised column; a multi-class
      // subject stores every assigned class here, comma separated.
      className: assigned.map((a) => a.name).join(', '),
      source: 'grades',
    });
  }
  for (const row of csRows) {
    const key = row.name.toLowerCase();
    if (!byName.has(key)) {
      byName.set(key, {
        // Include class_subjects id so the Grades view can edit/delete these subjects
        id: null,
        classSubjectId: row.id,
        name: row.name,
        maxMarks: 100, // default for class_subjects (no maxMarks column)
        code: row.code || '',
        sortOrder: 999, // appended after all grade subjects
        classIds: classRow ? [classRow.id] : [],
        classNames: classRow ? [classRow.name] : [],
        className: classRow ? classRow.name : '',
        source: 'classSubjects',
      });
    }
  }

  const merged = [...byName.values()]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
    .filter((s) => s && typeof s.name !== 'undefined');
  return merged;
}

/**
 * Every class a subject can be assigned to, as ordered class objects.
 *
 * The classes table is the authority, but the roster and any class names still
 * referenced only by a subject row are folded in, so a subject configured
 * against a class that has since lost its last student stays editable.
 */
async function knownClasses() {
  const rows = await db.all(
    'SELECT id, name FROM classes ORDER BY gradeOrder ASC, name COLLATE NOCASE ASC',
  );
  const set = new Map();
  for (const r of rows) {
    if (r.name) set.set(r.name.toLowerCase(), r);
  }

  const loose = await db.all(
    "SELECT DISTINCT studentClass AS name FROM students WHERE TRIM(studentClass) <> ''",
  );
  for (const r of loose) {
    if (r.name && !set.has(r.name.toLowerCase())) {
      const existing = await db.get(
        'SELECT id FROM classes WHERE name = ? COLLATE NOCASE',
        [r.name],
      );
      if (existing) set.set(r.name.toLowerCase(), { id: existing.id, name: r.name });
    }
  }

  const order = new Map(rows.map((r) => [r.name.toLowerCase(), r.id]));
  return [...set.values()].sort((a, b) => {
    const oa = order.has(a.name.toLowerCase()) ? order.get(a.name.toLowerCase()) : Infinity;
    const ob = order.has(b.name.toLowerCase()) ? order.get(b.name.toLowerCase()) : Infinity;
    return oa - ob || a.name.localeCompare(b.name);
  });
}


function registerIpcHandlers(ctx) {
  // The Excel helpers are a hard dependency of the data:* channels. main.js only
  // passes a window accessor, so resolve them here instead of trusting ctx.
  const excel = ctx.excel || require('./excel');
  const excelApi = {
    exportStudents: excel.exportStudents,
    exportInvoices: excel.exportInvoices,
    exportMarks: excel.exportMarks,
    exportClassesSubjects: excel.exportClassesSubjects,
    importStudents: excel.importStudents,
    importMarks: excel.importMarks,
  };

  /* ============================= app ============================= */
  handle('app:get-info', async () => ({
    name: app.getName(),
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
    node: process.versions.node,
    dbPath: db.getDatabaseFile(),
  }));

  handle('app:get-db-path', async () => db.getDatabaseFile());

  /* =========================== students ========================== */
  handle('students:list', async ({ search = '' }) => {
    const q = `%${str(search, 'Search', { max: 120 })}%`;
    return db.all(
      `SELECT s.*,
              (SELECT COUNT(*) FROM invoices i WHERE i.studentId = s.id) AS invoiceCount,
              (SELECT IFNULL(SUM(i.amountDue - i.discount - i.amountPaid), 0)
                 FROM invoices i WHERE i.studentId = s.id) AS dueAmount
         FROM students s
        WHERE s.name LIKE ? COLLATE NOCASE
           OR s.rollNo LIKE ? COLLATE NOCASE
           OR s.studentClass LIKE ? COLLATE NOCASE
        ORDER BY s.name COLLATE NOCASE ASC`,
      [q, q, q],
    );
  });

  handle('students:create', async ({ rollNo, name, studentClass, guardian, phone }) => {
    const r = str(rollNo, 'Roll No', { required: true, max: 40 });
    const n = str(name, 'Name', { required: true, max: 120 });
    const c = str(studentClass, 'Class', { required: true, max: 60 });
    const g = str(guardian, 'Guardian', { max: 120 });
    const p = str(phone, 'Phone', { max: 40 });

    const dup = await db.get(
      'SELECT id FROM students WHERE rollNo = ? COLLATE NOCASE AND studentClass = ? COLLATE NOCASE',
      [r, c],
    );
    if (dup) throw new ValidationError(`Roll No "${r}" already exists in class "${c}"`);

    const res = await db.run(
      'INSERT INTO students (rollNo, name, studentClass, guardian, phone) VALUES (?, ?, ?, ?, ?)',
      [r, n, c, g, p],
    );
    // Registering a student into a new class creates that class automatically.
    const ensured = await ensureClass(c);
    notify(ctx, 'students');
    if (ensured && ensured.created) notify(ctx, 'classes');
    return db.get('SELECT * FROM students WHERE id = ?', [res.lastID]);
  });

  handle('students:update', async ({ id: sid, rollNo, name, studentClass, guardian, phone }) => {
    const studentId = id(sid, 'Student id');
    const r = str(rollNo, 'Roll No', { required: true, max: 40 });
    const n = str(name, 'Name', { required: true, max: 120 });
    const c = str(studentClass, 'Class', { required: true, max: 60 });
    const g = str(guardian, 'Guardian', { max: 120 });
    const p = str(phone, 'Phone', { max: 40 });

    const dup = await db.get(
      'SELECT id FROM students WHERE rollNo = ? COLLATE NOCASE AND studentClass = ? COLLATE NOCASE AND id <> ?',
      [r, c, studentId],
    );
    if (dup) throw new ValidationError(`Roll No "${r}" already exists in class "${c}"`);

    // Read the class the student is in *before* the update overwrites it; the
    // old one has to be pruned afterwards if this move empties it.
    const previous = await db.get('SELECT studentClass FROM students WHERE id = ?', [studentId]);
    const oldClass = previous ? previous.studentClass : '';

    await db.run(
      'UPDATE students SET rollNo = ?, name = ?, studentClass = ?, guardian = ?, phone = ? WHERE id = ?',
      [r, n, c, g, p, studentId],
    );
    await db.run(
      'UPDATE invoices SET rollNo = ?, studentName = ?, studentClass = ? WHERE studentId = ?',
      [r, n, c, studentId],
    );
    await db.run('UPDATE marks SET rollNo = ? WHERE studentId = ?', [r, studentId]);

    // Moving a student into a different class creates the new class and drops
    // the old one once nobody is left in it.
    const moved = oldClass.toLowerCase() !== c.toLowerCase();
    const ensured = moved ? await ensureClass(c) : null;
    let pruned = false;
    if (moved) pruned = await pruneClassIfEmpty(oldClass);

    notify(ctx, 'students');
    if ((ensured && ensured.created) || pruned) notify(ctx, 'classes');
    return db.get('SELECT * FROM students WHERE id = ?', [studentId]);
  });

  handle('students:get', async ({ id: sid }) => {
    const row = await db.get('SELECT * FROM students WHERE id = ?', [id(sid, 'Student id')]);
    if (!row) throw new ValidationError('Student not found');
    return row;
  });

  handle('students:remove', async ({ id: sid }) => {
    const studentId = id(sid, 'Student id');
    const row = await db.get('SELECT * FROM students WHERE id = ?', [studentId]);
    if (!row) throw new ValidationError('Student not found');
    await db.run('DELETE FROM students WHERE id = ?', [studentId]);
    await db.run('DELETE FROM reportRemarks WHERE rollNo = ?', [row.rollNo]);
    // The class disappears with its last student, so the roster and the class
    // list never drift apart.
    const pruned = await pruneClassIfEmpty(row.studentClass);
    notify(ctx, 'students');
    if (pruned) notify(ctx, 'classes');
    return { deleted: true, rollNo: row.rollNo };
  });

  /* ======================== invoices / fees ======================= */
  handle('invoices:list', async ({ search = '', status = '', month = '' } = {}) => {
    const where = [];
    const params = [];
    const q = `%${str(search, 'Search', { max: 120 })}%`;
    where.push(
      '(studentName LIKE ? COLLATE NOCASE OR rollNo LIKE ? COLLATE NOCASE OR invoiceNo LIKE ? COLLATE NOCASE)',
    );
    params.push(q, q, q);
    const st = oneOf(status, ['Paid', 'Partial', 'Unpaid'], '');
    if (st) {
      where.push('status = ?');
      params.push(st);
    }
    const mo = str(month, 'Month', { max: 40 });
    if (mo) {
      where.push('feeMonth = ?');
      params.push(mo);
    }
    return db.all(
      `SELECT * FROM invoices WHERE ${where.join(' AND ')} ORDER BY createdAt DESC, id DESC`,
      params,
    );
  });

  handle('invoices:next-number', async () => {
    const settings = await getSettings();
    const prefix = settings.invoicePrefix || 'INV-';
    const year = new Date().getFullYear();
    const like = `${prefix}${year}%`;
    const row = await db.get(
      'SELECT invoiceNo FROM invoices WHERE invoiceNo LIKE ? ORDER BY id DESC LIMIT 1',
      [like],
    );
    let next = 1;
    if (row) {
      const m = String(row.invoiceNo).match(/(\d+)\s*$/);
      if (m) next = parseInt(m[1], 10) + 1;
    }
    return `${prefix}${year}-${String(next).padStart(4, '0')}`;
  });

  handle('invoices:create', async (payload) => {
    const studentId = id(payload.studentId, 'Student');
    const student = await db.get('SELECT * FROM students WHERE id = ?', [studentId]);
    if (!student) throw new ValidationError('Please select a valid student');

    const feeMonth = str(payload.feeMonth, 'Fee month', { required: true, max: 40 });
    const description = str(payload.description, 'Description', { max: 160 }) || 'Tuition Fee';
    const amountDue = num(payload.amountDue, 'Amount due', { min: 0, max: 1e9 });
    const discount = num(payload.discount, 'Discount', { min: 0, max: 1e9 });
    const amountPaid = num(payload.amountPaid, 'Amount paid', { min: 0, max: 1e9 });
    const notes = str(payload.notes, 'Notes', { max: 400 });
    const invoiceNo = str(payload.invoiceNo, 'Invoice No', { max: 40 })
      || (await nextInvoiceNumber());
    if (amountDue - discount < 0) throw new ValidationError('Discount cannot exceed the amount due');

    const dupe = await db.get('SELECT id FROM invoices WHERE invoiceNo = ?', [invoiceNo]);
    if (dupe) throw new ValidationError(`Invoice No "${invoiceNo}" already exists`);

    const existing = await db.get('SELECT id FROM invoices WHERE studentId = ? AND feeMonth = ?', [
      studentId,
      feeMonth,
    ]);
    if (existing) throw new ValidationError(`${student.name} already has an invoice for ${feeMonth}`);

    const status = computeStatus(amountDue, discount, amountPaid);
    const res = await db.run(
      `INSERT INTO invoices
         (invoiceNo, studentId, rollNo, studentName, studentClass, feeMonth,
          description, amountDue, discount, amountPaid, status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        invoiceNo,
        studentId,
        student.rollNo,
        student.name,
        student.studentClass,
        feeMonth,
        description,
        amountDue,
        discount,
        amountPaid,
        status,
        notes,
      ],
    );

    if (amountPaid > 0) {
      await db.run(
        'INSERT INTO payments (invoiceId, amount, method, reference, note) VALUES (?, ?, ?, ?, ?)',
        [res.lastID, amountPaid, str(payload.method, 'Method', { max: 40 }) || 'Cash', '', 'Opening payment'],
      );
    }
    notify(ctx, 'invoices');
    return db.get('SELECT * FROM invoices WHERE id = ?', [res.lastID]);
  });

  handle('invoices:update', async (payload) => {
    const invoiceId = id(payload.id, 'Invoice id');
    const invoice = await db.get('SELECT * FROM invoices WHERE id = ?', [invoiceId]);
    if (!invoice) throw new ValidationError('Invoice not found');

    const amountDue = num(payload.amountDue, 'Amount due', { min: 0, max: 1e9 });
    const discount = num(payload.discount, 'Discount', { min: 0, max: 1e9 });
    const amountPaid = num(payload.amountPaid, 'Amount paid', { min: 0, max: 1e9 });
    if (amountDue - discount < 0) throw new ValidationError('Discount cannot exceed the amount due');

    await db.run(
      `UPDATE invoices
          SET feeMonth = ?, description = ?, amountDue = ?, discount = ?,
              amountPaid = ?, status = ?, notes = ?
        WHERE id = ?`,
      [
        str(payload.feeMonth, 'Fee month', { required: true, max: 40 }),
        str(payload.description, 'Description', { max: 160 }) || 'Tuition Fee',
        amountDue,
        discount,
        amountPaid,
        computeStatus(amountDue, discount, amountPaid),
        str(payload.notes, 'Notes', { max: 400 }),
        invoiceId,
      ],
    );
    notify(ctx, 'invoices');
    return db.get('SELECT * FROM invoices WHERE id = ?', [invoiceId]);
  });

  handle('invoices:remove', async ({ id: iid }) => {
    const invoiceId = id(iid, 'Invoice id');
    const row = await db.get('SELECT * FROM invoices WHERE id = ?', [invoiceId]);
    if (!row) throw new ValidationError('Invoice not found');
    await db.run('DELETE FROM invoices WHERE id = ?', [invoiceId]);
    notify(ctx, 'invoices');
    return { deleted: true, invoiceNo: row.invoiceNo };
  });

  handle('invoices:get', async ({ id: iid }) => {
    const invoiceId = id(iid, 'Invoice id');
    const invoice = await db.get('SELECT * FROM invoices WHERE id = ?', [invoiceId]);
    if (!invoice) throw new ValidationError('Invoice not found');
    const student = await db.get('SELECT * FROM students WHERE id = ?', [invoice.studentId]);
    const payments = await db.all('SELECT * FROM payments WHERE invoiceId = ? ORDER BY id DESC', [
      invoiceId,
    ]);
    return { invoice, student, payments, settings: await getSettings() };
  });

  handle('invoices:add-payment', async (payload) => {
    const invoiceId = id(payload.invoiceId, 'Invoice id');
    const invoice = await db.get('SELECT * FROM invoices WHERE id = ?', [invoiceId]);
    if (!invoice) throw new ValidationError('Invoice not found');

    const amount = num(payload.amount, 'Amount', { min: 0.01, max: 1e9 });
    const payable = round(invoice.amountDue - invoice.discount, 2);
    const newPaid = round(invoice.amountPaid + amount, 2);
    if (newPaid > payable) {
      throw new ValidationError(
        `Payment exceeds the outstanding balance (${round(payable - invoice.amountPaid, 2)})`,
      );
    }

    await db.run(
      'INSERT INTO payments (invoiceId, amount, method, reference, note) VALUES (?, ?, ?, ?, ?)',
      [
        invoiceId,
        amount,
        oneOf(payload.method, ['Cash', 'Card', 'Bank Transfer', 'Cheque', 'Online'], 'Cash'),
        str(payload.reference, 'Reference', { max: 80 }),
        str(payload.note, 'Note', { max: 200 }),
      ],
    );
    await db.run('UPDATE invoices SET amountPaid = ?, status = ? WHERE id = ?', [
      newPaid,
      computeStatus(invoice.amountDue, invoice.discount, newPaid),
      invoiceId,
    ]);
    notify(ctx, 'invoices');
    return db.get('SELECT * FROM invoices WHERE id = ?', [invoiceId]);
  });

  handle('invoices:payments', async ({ invoiceId: pid }) =>
    db.all('SELECT * FROM payments WHERE invoiceId = ? ORDER BY id DESC', [id(pid, 'Invoice id')]),
  );

  /* =================== grades / report cards ====================== */

  /**
   * Subjects for a class.
   *
   * With a class the result is every subject explicitly assigned to it, plus the
   * subjects defined in the Classes & Subjects module for that class. With no
   * class it is the whole catalogue, each row carrying classIds/classNames so the
   * table can show every class a subject belongs to.
   */
  handle('grades:list-subjects', async ({ studentClass } = {}) =>
    subjectsForClass(normaliseClassFilter(studentClass)),
  );

  /**
   * Class objects a subject can be assigned to, ready for the checkbox picker.
   *
   * There is no wildcard option: a subject is always assigned to one or more
   * named classes, so the payload is a plain list of classes with their ids.
   */
  handle('grades:list-classes', async () => ({ classes: await knownClasses() }));

  /**
   * Resolves the class ids on a save payload into real class rows.
   *
   * `studentClass` is accepted as a fallback for callers that only know a class
   * by name, but classIds is what the UI sends and what actually gets stored.
   * At least one class is required: a subject with no class would be invisible
   * everywhere, so it is rejected rather than silently saved.
   */
  async function resolveSubjectClasses(classIds, studentClass) {
    const requested = Array.isArray(classIds)
      ? [...new Set(classIds.map((v) => int(v, 'classId', { min: 1 })).filter(Boolean))]
      : [];

    // Ids that no longer resolve are dropped rather than rejected: a class that
    // was deleted between the picker rendering and the save must not block the
    // save of the classes that do exist.
    const resolved = [];
    for (const cid of requested) {
      const row = await db.get('SELECT id, name FROM classes WHERE id = ?', [cid]);
      if (row) resolved.push(row);
    }

    // No ids given: fall back to the name the caller passed, if any.
    if (!resolved.length) {
      const name = normaliseClassFilter(studentClass);
      if (name) {
        const row = await db.get(
          'SELECT id, name FROM classes WHERE name = ? COLLATE NOCASE',
          [name],
        );
        if (row) resolved.push(row);
      }
    }

    if (!resolved.length) {
      throw new ValidationError('Select at least one class for this subject');
    }
    return resolved;
  }

  /** Writes the junction rows and refreshes the denormalised columns. */
  async function saveSubjectClasses(subjectId, classRows) {
    await db.run('DELETE FROM subject_classes WHERE subjectId = ?', [subjectId]);
    for (const row of classRows) {
      await db.run(
        'INSERT OR IGNORE INTO subject_classes (subjectId, classId) VALUES (?, ?)',
        [subjectId, row.id],
      );
    }
    await db.refreshSubjectClassColumns();
  }

  handle('grades:add-subject', async ({ name, maxMarks, studentClass, classIds } = {}) => {
    const n = str(name, 'Subject', { required: true, max: 60 });
    const m = num(maxMarks, 'Max marks', { min: 1, max: 1000, fallback: 100 });
    const classes = await resolveSubjectClasses(classIds, studentClass);

    // A name may only appear once per class, so it is enough that none of the
    // requested classes already has this subject.
    for (const cls of classes) {
      const dupe = await db.get(
        `SELECT s.id FROM subjects s
           JOIN subject_classes sc ON sc.subjectId = s.id
          WHERE sc.classId = ? AND s.name = ? COLLATE NOCASE`,
        [cls.id, n],
      );
      if (dupe) {
        throw new ValidationError(`Subject "${n}" is already configured for ${cls.name}`);
      }
    }

    // Continue the ordering of the catalogue this subject joins.
    const last = await db.get('SELECT IFNULL(MAX(sortOrder), 0) AS m FROM subjects');
    const res = await db.run(
      'INSERT INTO subjects (name, className, classIds, maxMarks, sortOrder) VALUES (?, ?, ?, ?, ?)',
      [
        n,
        classes.map((c) => c.name).join(', '),
        JSON.stringify(classes.map((c) => c.id)),
        m,
        (last ? last.m : 0) + 1,
      ],
    );
    const newId = res.lastID;
    await saveSubjectClasses(newId, classes);

    notify(ctx, 'subjects');
    return db.get('SELECT * FROM subjects WHERE id = ?', [newId]);
  });

  handle('grades:update-subject', async ({ id: sid, name, maxMarks, studentClass, classIds } = {}) => {
    const subjectId = id(sid, 'Subject id');
    const n = str(name, 'Subject', { required: true, max: 60 });
    const m = num(maxMarks, 'Max marks', { min: 1, max: 1000, fallback: 100 });
    const current = await db.get('SELECT * FROM subjects WHERE id = ?', [subjectId]);
    if (!current) throw new ValidationError('Subject not found');

    // Omitting the class fields keeps the current assignment, which is what a
    // caller that only wants to change the name or the maximum relies on.
    const touchesClasses = Array.isArray(classIds) || (studentClass !== undefined && studentClass !== null);
    const targetClasses = touchesClasses
      ? await resolveSubjectClasses(classIds, studentClass)
      : await classesForSubject(subjectId);

    if (touchesClasses) {
      for (const cls of targetClasses) {
        const dupe = await db.get(
          `SELECT s.id FROM subjects s
             JOIN subject_classes sc ON sc.subjectId = s.id
            WHERE sc.classId = ? AND s.name = ? COLLATE NOCASE AND s.id <> ?`,
          [cls.id, n, subjectId],
        );
        if (dupe) {
          throw new ValidationError(`Subject "${n}" is already configured for ${cls.name}`);
        }
      }
    }

    // Renaming a subject must carry its recorded marks along, otherwise history
    // silently detaches from the subject it belongs to.
    if (n.toLowerCase() !== String(current.name).toLowerCase()) {
      await db.run('UPDATE subjects SET name = ?, maxMarks = ? WHERE id = ?', [n, m, subjectId]);
      await db.run('UPDATE marks SET subject = ? WHERE subject = ? COLLATE NOCASE', [
        n,
        current.name,
      ]);
    } else {
      await db.run('UPDATE subjects SET maxMarks = ? WHERE id = ?', [m, subjectId]);
    }

    if (touchesClasses) await saveSubjectClasses(subjectId, targetClasses);

    notify(ctx, 'subjects');
    return db.get('SELECT * FROM subjects WHERE id = ?', [subjectId]);
  });

  handle('grades:remove-subject', async ({ id: sid } = {}) => {
    const subjectId = id(sid, 'Subject id');
    const subject = await db.get('SELECT * FROM subjects WHERE id = ?', [subjectId]);
    if (!subject) throw new ValidationError('Subject not found');
    // Read the assignment before the row goes: subject_classes cascades with it.
    const assigned = await classesForSubject(subjectId);
    await db.run('DELETE FROM subjects WHERE id = ?', [subjectId]);

    // Marks recorded in a class that no longer has this subject are orphaned, so
    // they go with it. Marks from a class the subject was never assigned to were
    // already unreachable and are left untouched.
    for (const cls of assigned) {
      await db.run(
        `DELETE FROM marks
          WHERE subject = ? COLLATE NOCASE AND studentClass = ? COLLATE NOCASE`,
        [subject.name, cls.name],
      );
    }
    notify(ctx, 'subjects');
    return { deleted: true, name: subject.name, className: subject.className };
  });

  /**
   * Bulk-upsert the marks grid.
   * rows = [{studentId, subject, marksObtained, maxMarks}]
   *
   * `marksObtained === null` (or `clear: true`) DELETES the stored mark instead
   * of upserting it, which is what the renderer sends when the teacher clears
   * a cell that previously held a value.
   */
  handle('grades:save-marks', async ({ examName, rows } = {}) => {
    const exam = str(examName, 'Exam name', { required: true, max: 60 });
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) throw new ValidationError('No marks to save');
    if (list.length > 5000) throw new ValidationError('Too many rows in one batch');

    let saved = 0;
    let cleared = 0;
    for (const row of list) {
      const studentId = id(row.studentId, 'Student');
      const subject = str(row.subject, 'Subject', { required: true, max: 60 });
      const student = await db.get(
        'SELECT rollNo, studentClass FROM students WHERE id = ?',
        [studentId],
      );
      if (!student) continue;

      // The class is read from the student row, never from the payload, so a
      // stale renderer cannot file a mark under the wrong class.
      const studentClass = student.studentClass || '';

      const isClear = row.clear === true || row.marksObtained === null;
      if (isClear) {
        const res = await db.run(
          `DELETE FROM marks
            WHERE rollNo = ? AND studentClass = ? AND subject = ? AND examName = ?`,
          [student.rollNo, studentClass, subject, exam],
        );
        cleared += res.changes || 0;
        continue;
      }

      const maxMarks = num(row.maxMarks, 'Max marks', { min: 1, max: 1000, fallback: 100 });
      const obtained = num(row.marksObtained, 'Marks obtained', { min: 0, max: 1000, fallback: 0 });
      if (obtained > maxMarks) {
        throw new ValidationError(`Marks for ${subject} cannot exceed the maximum (${maxMarks})`);
      }

      await db.run(
        `INSERT INTO marks (studentId, rollNo, studentClass, subject, marksObtained, maxMarks, examName, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))
         ON CONFLICT (rollNo, studentClass, subject, examName)
         DO UPDATE SET marksObtained = excluded.marksObtained,
                       maxMarks      = excluded.maxMarks,
                       studentId     = excluded.studentId,
                       updatedAt     = excluded.updatedAt`,
        [studentId, student.rollNo, studentClass, subject, obtained, maxMarks, exam],
      );
      saved += 1;
    }
    notify(ctx, 'marks');
    return { saved, cleared };
  });


  /** Full computed report for one student in one exam. */
  handle('grades:get-report', async ({ rollNo, examName, studentClass } = {}) => {
    const roll = str(rollNo, 'Roll No', { required: true, max: 40 });
    const exam = str(examName, 'Exam name', { max: 60 });
    // A roll number is only unique within a class, so an optional class is used
    // to pick between students who share one. Without it we keep the old
    // first-match behaviour.
    const cls = normaliseClassFilter(studentClass);
    const student = await db.get(
      `SELECT * FROM students
        WHERE rollNo = ? COLLATE NOCASE AND (? = '' OR studentClass = ? COLLATE NOCASE)
        ORDER BY id ASC LIMIT 1`,
      [roll, cls, cls],
    );
    if (!student) throw new ValidationError(`No student found with roll no "${roll}"`);

    const settings = await getSettings();
    const passMark = Number(settings.passMarkPercentage) || 50;

    // Marks are matched on roll AND class, otherwise a same-roll student in a
    // different class would contribute marks to this report card.
    const marks = await db.all(
      `SELECT * FROM marks
        WHERE rollNo = ? COLLATE NOCASE
          AND studentClass = ? COLLATE NOCASE
          AND (? = '' OR examName = ?)`,
      [roll, student.studentClass, exam, exam],
    );

    // Only the subjects configured for this student's class are listed, so the
    // card reflects that class's curriculum.
    const subjects = await subjectsForClass(student.studentClass);
    const rows = (subjects || [])
      .filter((s) => s && typeof s.name !== 'undefined')
      .map((s) => {
        const found = marks.find((m) => m.subject === s.name);
        return {
          subject: s.name,
          marksObtained: found ? found.marksObtained : 0,
          maxMarks: found ? found.maxMarks : (s.maxMarks || 100),
          hasMark: !!found,
        };
      });

    const remarkRow = await db.get('SELECT remark FROM reportRemarks WHERE rollNo = ?', [roll]);
    const report = buildReport(student, rows, passMark, remarkRow ? remarkRow.remark : '');

    // Rank the student against the others in the SAME class and exam, which is
    // what a position on a report card is expected to mean.
    const classmates = await db.all(
      'SELECT * FROM students WHERE studentClass = ? COLLATE NOCASE',
      [student.studentClass],
    );
    const scored = [];
    for (const s of classmates) {
      const m = await db.all(
        `SELECT subject, marksObtained, maxMarks FROM marks
          WHERE rollNo = ? AND studentClass = ? COLLATE NOCASE AND examName = ?`,
        [s.rollNo, s.studentClass, exam],
      );
      if (!m.length) continue;
      scored.push({
        rollNo: s.rollNo,
        percentage: buildReport(s, m, passMark).percentage,
      });
    }
    scored.sort((a, b) => b.percentage - a.percentage);
    const myRank = scored.findIndex((r) => r.rollNo === student.rollNo);
    report.position = myRank >= 0 ? myRank + 1 : null;
    report.classSize = scored.length;

    return { report, settings, examName: exam || 'Term 1' };
  });

  /** Computed results grid for all students in an exam. */
  handle('grades:get-results', async ({ examName, studentClass } = {}) => {
    const exam = str(examName, 'Exam name', { max: 60 });
    const settings = await getSettings();
    const passMark = Number(settings.passMarkPercentage) || 50;
    const cls = normaliseClassFilter(studentClass);

    // Match the class case-insensitively, the way every other handler does:
    // class names are compared with COLLATE NOCASE throughout the app, so a
    // stored "play group" must still be found under the pill "Play Group".
    const students = cls
      ? await db.all(
          'SELECT * FROM students WHERE studentClass = ? COLLATE NOCASE ORDER BY name COLLATE NOCASE',
          [cls],
        )
      : await db.all('SELECT * FROM students ORDER BY name COLLATE NOCASE');
    // Each student is graded against the subjects configured for their own
    // class, so classes with different curricula each get the right grid.
    const byStudent = new Map();
    for (const s of students) {
      byStudent.set(s.id, await subjectsForClass(s.studentClass));
    }
    const subjects = await subjectsForClass(cls);
    const marks = await db.all(
      'SELECT * FROM marks WHERE (? = \'\' OR examName = ?)',
      [exam, exam],
    );
    const remarks = await db.all('SELECT * FROM reportRemarks');

    // Index the marks by roll + class + subject once instead of scanning the
    // whole set for every student/subject pair. Keys are lower-cased so the
    // lookup matches case-insensitively, as the SQL above now does.
    const markIndex = new Map();
    for (const m of marks) {
      markIndex.set(
        `${String(m.rollNo).toLowerCase()}|${String(m.studentClass).toLowerCase()}|${String(m.subject).toLowerCase()}`,
        m,
      );
    }

    const results = students.map((s) => {
      const rows = (byStudent.get(s.id) || [])
        .filter((sub) => sub && typeof sub.name !== 'undefined')
        .map((sub) => {
          // roll AND class must both match: a same-roll student in another class
          // must never leak into this row.
          const found = markIndex.get(
            `${String(s.rollNo).toLowerCase()}|${String(s.studentClass).toLowerCase()}|${String(sub.name).toLowerCase()}`,
          );
          return {
            subject: sub.name,
            marksObtained: found ? found.marksObtained : 0,
            maxMarks: found ? found.maxMarks : (sub.maxMarks || 100),
            hasMark: !!found,
          };
        });
      const remarkRow = remarks.find((r) => r.rollNo === s.rollNo);
      return { student: s, report: buildReport(s, rows, passMark, remarkRow ? remarkRow.remark : '') };
    });

    results.sort((a, b) => b.report.percentage - a.report.percentage);
    results.forEach((r, i) => {
      r.report.position = i + 1;
    });

    return {
      subjects,
      results,
      settings,
      examName: exam,
      summary: {
        students: results.length,
        passed: results.filter((r) => r.report.isPass).length,
        failed: results.filter((r) => !r.report.isPass).length,
        averagePercentage: results.length
          ? round(results.reduce((a, r) => a + r.report.percentage, 0) / results.length, 2)
          : 0,
        passMark,
      },
    };
  });

  handle('grades:save-remark', async ({ rollNo, remark } = {}) => {
    const roll = str(rollNo, 'Roll No', { required: true, max: 40 });
    const text = str(remark, 'Remark', { max: 400 });
    await db.run(
      `INSERT INTO reportRemarks (rollNo, remark, updatedAt)
       VALUES (?, ?, datetime('now','localtime'))
       ON CONFLICT (rollNo) DO UPDATE SET remark = excluded.remark,
                                           updatedAt = excluded.updatedAt`,
      [roll, text],
    );
    notify(ctx, 'marks');
    return { rollNo: roll, remark: text };
  });

  /* ========================== settings ============================ */
  handle('settings:get-all', async () => getSettings());

  handle('settings:save', async (payload) => {
    const allowed = Object.keys(db.DEFAULT_SETTINGS);
    const entries = Object.entries(payload || {}).filter(([k]) => allowed.includes(k));
    if (!entries.length) throw new ValidationError('Nothing to save');

    for (const [key, rawValue] of entries) {
      let value = rawValue === undefined || rawValue === null ? '' : String(rawValue);
      if (key === 'schoolLogo') {
        // Base64 image data URL, capped to keep the settings row small.
        if (value && !/^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,/i.test(value)) {
          throw new ValidationError('Logo must be a valid base64 image');
        }
        if (value.length > 3 * 1024 * 1024) {
          throw new ValidationError('Logo image is too large (max 2 MB)');
        }
      }
      if (key === 'passMarkPercentage') {
        const pct = Number(value);
        if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
          throw new ValidationError('Pass mark percentage must be between 0 and 100');
        }
        value = String(pct);
      }
      if (key === 'schoolName' && !value.trim()) throw new ValidationError('School name is required');

      await db.run(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
        [key, value],
      );
    }
    notify(ctx, 'settings');
    return getSettings();
  });

  handle('settings:reset', async () => {
    const win = ctx.getWindow && ctx.getWindow();
    if (win && !win.isDestroyed()) {
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['Cancel', 'Reset to defaults'],
        defaultId: 0,
        cancelId: 0,
        title: 'Reset settings',
        message: 'Reset all settings to their default values?',
        detail: 'Your school name, logo and invoice options will be restored to defaults.',
      });
      if (response !== 1) return { cancelled: true, settings: await getSettings() };
    }
    for (const [key, value] of Object.entries(db.DEFAULT_SETTINGS)) {
      await db.run(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
        [key, String(value)],
      );
    }
    notify(ctx, 'settings');
    return { cancelled: false, settings: await getSettings() };
  });

  /* ----------------- classes & subjects ----------------- */
  handle('classes:list', async () => {
    // Keep the classes table in sync with the student roster so the Grades
    // dropdown always shows the actual class names students are registered in.
    await syncClassesFromRoster();
    return db.all('SELECT * FROM classes ORDER BY gradeOrder ASC, name ASC');
  });

  handle('classes:create', async ({ name, gradeOrder = 0, categoryKey = '' }) => {
    const className = str(name, 'Class name', { required: true, max: 120 });
    const order = int(gradeOrder, 'Grade order', { min: 0, fallback: 0 });
    const category = categoryKeyOf(categoryKey);
    await db.run(
      'INSERT INTO classes (name, gradeOrder, categoryKey) VALUES (?, ?, ?)',
      [className, order, category],
    );
    const cls = await db.get('SELECT * FROM classes WHERE id = last_insert_rowid()');
    // A new class needs a curriculum too, so the still-unassigned subjects (the
    // seeded defaults) are attached to it instead of leaving it empty.
    await db.attachUnassignedSubjects();
    notify(ctx, 'classes');
    notify(ctx, 'subjects');
    return cls;
  });

  handle('classes:update', async ({ id: classId, name, gradeOrder, categoryKey }) => {
    const targetId = id(classId, 'id');
    const className = str(name, 'Class name', { required: true, max: 120 });
    const order = int(gradeOrder, 'Grade order', { min: 0, fallback: 0 });
    // '' means "not assigned by hand": the renderer falls back to the band its
    // gradeOrder implies. An omitted field leaves the stored value untouched, so
    // a caller that never knew about categories cannot clear them by accident.
    const category = categoryKeyOf(categoryKey);
    const row = await db.get('SELECT name FROM classes WHERE id = ?', [targetId]);
    if (!row) throw new Error('Class not found');
    await db.run(
      'UPDATE classes SET name = ?, gradeOrder = ?, categoryKey = COALESCE(?, categoryKey)'
        + ' WHERE id = ?',
      [className, order, category, targetId],
    );
    // Students, invoices, marks and grades subjects all store the class as text,
    // so a rename has to travel with it or those rows go orphaned.
    await renameClassEverywhere(row.name, className);
    notify(ctx, 'classes');
    notify(ctx, 'students');
    return db.get('SELECT * FROM classes WHERE id = ?', [targetId]);
  });

  handle('classes:remove', async ({ id: classId }) => {
    const targetId = id(classId, 'id');
    const cls = await db.get('SELECT name FROM classes WHERE id = ?', [targetId]);
    if (!cls) throw new Error('Class not found');
    // class_subjects.classId and subject_classes.classId are ON DELETE CASCADE,
    // so both sets of subjects go with it.
    await db.run('DELETE FROM classes WHERE id = ?', [targetId]);
    await db.refreshSubjectClassColumns();
    notify(ctx, 'classes');
    notify(ctx, 'subjects');
    return { name: cls.name };
  });

  handle('subjects:list', async ({ classId }) => {
    const cid = int(classId, 'classId', { min: 1 });
    return db.all(
      'SELECT * FROM class_subjects WHERE classId = ? ORDER BY createdAt ASC',
      [cid],
    );
  });

  handle('subjects:create', async ({ classId, name, code = '', status = 'Active' }) => {
    const cid = id(classId, 'classId');
    const subjectName = str(name, 'Subject name', { required: true, max: 120 });
    const subjectCode = str(code, 'Subject code', { max: 20 });
    const subjectStatus = oneOf(status, ['Active', 'Inactive'], 'Active');
    await db.run(
      'INSERT INTO class_subjects (classId, name, code, status) VALUES (?, ?, ?, ?)',
      [cid, subjectName, subjectCode, subjectStatus],
    );
    const subj = await db.get('SELECT * FROM class_subjects WHERE id = last_insert_rowid()');
    notify(ctx, 'subjects');
    return subj;
  });

  handle('subjects:update', async ({ id: subjectId, name, code, status }) => {
    const targetId = id(subjectId, 'id');
    const subjectName = str(name, 'Subject name', { required: true, max: 120 });
    const subjectCode = str(code, 'Subject code', { max: 20 });
    const subjectStatus = oneOf(status, ['Active', 'Inactive'], 'Active');
    const row = await db.get('SELECT id FROM class_subjects WHERE id = ?', [targetId]);
    if (!row) throw new Error('Subject not found');
    await db.run(
      'UPDATE class_subjects SET name = ?, code = ?, status = ? WHERE id = ?',
      [subjectName, subjectCode, subjectStatus, targetId],
    );
    const subj = await db.get('SELECT * FROM class_subjects WHERE id = ?', [targetId]);
    notify(ctx, 'subjects');
    return subj;
  });

  handle('subjects:remove', async ({ id: subjectId }) => {
    const targetId = id(subjectId, 'id');
    const subj = await db.get('SELECT name FROM class_subjects WHERE id = ?', [targetId]);
    if (!subj) throw new Error('Subject not found');
    await db.run('DELETE FROM class_subjects WHERE id = ?', [targetId]);
    notify(ctx, 'subjects');
    return { name: subj.name };
  });

  /* ========================== dashboard =========================== */
  handle('data:export-students', async () => excelApi.exportStudents());

  handle('data:export-invoices', async () => excelApi.exportInvoices());

  handle('data:export-marks', async ({ examName, studentClass } = {}) =>
    excelApi.exportMarks({ examName, studentClass }));

  handle('data:export-classes-subjects', async () => excelApi.exportClassesSubjects());

  handle('data:import-students', async ({ filePath }) => {
    if (!filePath) throw new Error('No file path provided');
    const result = await excelApi.importStudents(filePath);
    notify(ctx, 'students');
    // Imported rows carry their own class names, so register the new ones the
    // same way the student form does.
    if (await syncClassesFromRoster()) notify(ctx, 'classes');
    return result;
  });

  handle('data:import-students-dialog', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Excel', extensions: ['xlsx', 'xls'] }, { name: 'All', extensions: ['*'] }],
    });
    if (result.canceled || !result.filePaths.length) return null;
    const imported = await excelApi.importStudents(result.filePaths[0]);
    notify(ctx, 'students');
    if (await syncClassesFromRoster()) notify(ctx, 'classes');
    return imported;
  });

  handle('data:import-marks', async ({ filePath, examName }) => {
    if (!filePath) throw new Error('No file path provided');
    if (!examName) throw new Error('Exam name is required for marks import');
    const result = await excelApi.importMarks(filePath, examName);
    notify(ctx, 'marks');
    return result;
  });

  handle('data:import-marks-dialog', async ({ examName }) => {
    if (!examName) throw new Error('Exam name is required for marks import');
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Excel', extensions: ['xlsx', 'xls'] }, { name: 'All', extensions: ['*'] }],
    });
    if (result.canceled || !result.filePaths.length) return null;
    const imported = await excelApi.importMarks(result.filePaths[0], examName);
    notify(ctx, 'marks');
    return imported;
  });

  /* ========================== dashboard =========================== */
  handle('dashboard:stats', async () => {
    const students = await db.get('SELECT COUNT(*) AS c FROM students');
    const classes = await db.get('SELECT COUNT(DISTINCT studentClass) AS c FROM students');
    const subjects = await db.get('SELECT COUNT(*) AS c FROM subjects');
    const billed = await db.get(
      'SELECT IFNULL(SUM(amountDue), 0) AS billed, IFNULL(SUM(discount), 0) AS discount, IFNULL(SUM(amountPaid), 0) AS collected FROM invoices',
    );
    const outstanding = await db.get(
      'SELECT IFNULL(SUM(MAX(amountDue - discount - amountPaid, 0)), 0) AS due FROM invoices',
    );
    const byStatus = await db.all('SELECT status, COUNT(*) AS count FROM invoices GROUP BY status');

    const thisMonth = await db.get(
      'SELECT COUNT(*) AS count FROM invoices WHERE strftime(\'%Y-%m\', createdAt) = strftime(\'%Y-%m\', \'now\')',
    );

    const topDefaulters = await db.all(
      `SELECT rollNo, studentName, studentClass,
              IFNULL(SUM(amountDue - discount - amountPaid), 0) AS due
         FROM invoices
        GROUP BY studentId
       HAVING due > 0
        ORDER BY due DESC
        LIMIT 5`,
    );

    const recentInvoices = await db.all('SELECT * FROM invoices ORDER BY id DESC LIMIT 6');
    const feeByMonth = await db.all(
      `SELECT feeMonth,
              IFNULL(SUM(amountDue - discount), 0) AS billed,
              IFNULL(SUM(amountPaid), 0) AS collected
         FROM invoices GROUP BY feeMonth ORDER BY feeMonth DESC LIMIT 6`,
    );

    return {
      students: students ? students.c : 0,
      classes: classes ? classes.c : 0,
      subjects: subjects ? subjects.c : 0,
      billed: round(billed.billed - billed.discount, 2),
      collected: round(billed.collected, 2),
      outstanding: round(outstanding.due, 2),
      invoicesThisMonth: thisMonth ? thisMonth.count : 0,
      byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.count])),
      topDefaulters,
      recentInvoices,
      feeByMonth: feeByMonth.reverse(),
      settings: await getSettings(),
    };
  });

  /* ======================= Teachers ======================= */

  handle('teachers:list', async ({ search = '' } = {}) => {
    const q = `%${str(search, 'Search', { max: 120 })}%`;
    return db.all(
      `SELECT * FROM teachers
        WHERE fullName LIKE ? COLLATE NOCASE
           OR employeeCode LIKE ? COLLATE NOCASE
           OR specialization LIKE ? COLLATE NOCASE
        ORDER BY fullName COLLATE NOCASE ASC`,
      [q, q, q],
    );
  });

  handle('teachers:get', async ({ id: tid } = {}) => {
    const teacherId = id(tid, 'Teacher id');
    const row = await db.get('SELECT * FROM teachers WHERE id = ?', [teacherId]);
    if (!row) throw new ValidationError('Teacher not found');
    return row;
  });

  handle('teachers:create', async (payload = {}) => {
    const fullName       = str(payload.fullName, 'Full name', { required: true, max: 120 });
    const employeeCode   = str(payload.employeeCode, 'Employee code', { required: true, max: 40 });
    const specialization = str(payload.specialization, 'Specialization', { max: 120 });
    const phone          = str(payload.phone, 'Phone', { max: 40 });
    const email          = str(payload.email, 'Email', { max: 120 });
    const address        = str(payload.address, 'Address', { max: 300 });
    const joiningDate    = str(payload.joiningDate, 'Joining date', { max: 20 });
    const baseSalary     = num(payload.baseSalary, 'Base salary', { min: 0, max: 1e9 });

    const dup = await db.get(
      'SELECT id FROM teachers WHERE employeeCode = ? COLLATE NOCASE',
      [employeeCode],
    );
    if (dup) throw new ValidationError(`Employee code "${employeeCode}" already exists`);

    const res = await db.run(
      `INSERT INTO teachers (fullName, employeeCode, specialization, phone, email, address, joiningDate, baseSalary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [fullName, employeeCode, specialization, phone, email, address, joiningDate, baseSalary],
    );
    notify(ctx, 'teachers');
    return db.get('SELECT * FROM teachers WHERE id = ?', [res.lastID]);
  });

  handle('teachers:update', async (payload = {}) => {
    const teacherId = id(payload.id, 'Teacher id');
    const existing  = await db.get('SELECT * FROM teachers WHERE id = ?', [teacherId]);
    if (!existing) throw new ValidationError('Teacher not found');

    const fullName       = str(payload.fullName, 'Full name', { required: true, max: 120 });
    const employeeCode   = str(payload.employeeCode, 'Employee code', { required: true, max: 40 });
    const specialization = str(payload.specialization, 'Specialization', { max: 120 });
    const phone          = str(payload.phone, 'Phone', { max: 40 });
    const email          = str(payload.email, 'Email', { max: 120 });
    const address        = str(payload.address, 'Address', { max: 300 });
    const joiningDate    = str(payload.joiningDate, 'Joining date', { max: 20 });
    const baseSalary     = num(payload.baseSalary, 'Base salary', { min: 0, max: 1e9 });

    const dup = await db.get(
      'SELECT id FROM teachers WHERE employeeCode = ? COLLATE NOCASE AND id <> ?',
      [employeeCode, teacherId],
    );
    if (dup) throw new ValidationError(`Employee code "${employeeCode}" already exists`);

    await db.run(
      `UPDATE teachers SET fullName = ?, employeeCode = ?, specialization = ?,
            phone = ?, email = ?, address = ?, joiningDate = ?, baseSalary = ?
       WHERE id = ?`,
      [fullName, employeeCode, specialization, phone, email, address, joiningDate, baseSalary, teacherId],
    );
    notify(ctx, 'teachers');
    return db.get('SELECT * FROM teachers WHERE id = ?', [teacherId]);
  });

  handle('teachers:remove', async ({ id: tid } = {}) => {
    const teacherId = id(tid, 'Teacher id');
    const row = await db.get('SELECT * FROM teachers WHERE id = ?', [teacherId]);
    if (!row) throw new ValidationError('Teacher not found');
    await db.run('DELETE FROM teachers WHERE id = ?', [teacherId]);
    notify(ctx, 'teachers');
    return { deleted: true };
  });

  /* =================== Teacher Attendance ================= */

  handle('teacher-attendance:list', async ({ teacherId, dateFrom = '', dateTo = '' } = {}) => {
    const tid = teacherId ? id(teacherId, 'Teacher id') : null;
    let sql = 'SELECT ta.*, t.fullName AS teacherName, t.employeeCode FROM teacher_attendance ta JOIN teachers t ON t.id = ta.teacherId WHERE 1=1';
    const params = [];
    if (tid) { sql += ' AND ta.teacherId = ?'; params.push(tid); }
    if (dateFrom) { sql += ' AND ta.date >= ?'; params.push(dateFrom); }
    if (dateTo)   { sql += ' AND ta.date <= ?'; params.push(dateTo); }
    sql += ' ORDER BY ta.date DESC, ta.id DESC';
    return db.all(sql, params);
  });

  handle('teacher-attendance:upsert', async (payload = {}) => {
    const teacherId = id(payload.teacherId, 'Teacher id');
    const date = str(payload.date, 'Date', { required: true, max: 20 });
    const status = oneOf(payload.status, ['Present', 'Absent', 'Late', 'Leave'], 'Present');
    await db.get('SELECT id FROM teachers WHERE id = ?', [teacherId]);
    // Check if a record already exists for this teacher+date
    const existing = await db.get('SELECT id FROM teacher_attendance WHERE teacherId = ? AND date = ?', [teacherId, date]);
    if (existing) {
      await db.run('UPDATE teacher_attendance SET status = ? WHERE id = ?', [status, existing.id]);
    } else {
      await db.run(
        'INSERT INTO teacher_attendance (teacherId, classId, date, status) VALUES (?, NULL, ?, ?)',
        [teacherId, date, status],
      );
    }
    notify(ctx, 'teacher-attendance');
    return { teacherId, date, status };
  });

  handle('teacher-attendance:remove', async ({ id: aid } = {}) => {
    const attId = id(aid, 'Attendance id');
    const row = await db.get('SELECT * FROM teacher_attendance WHERE id = ?', [attId]);
    if (!row) throw new ValidationError('Attendance record not found');
    await db.run('DELETE FROM teacher_attendance WHERE id = ?', [attId]);
    notify(ctx, 'teacher-attendance');
    return { deleted: true };
  });

  /* =================== Teacher Payroll =================== */

  handle('teacher-payroll:list', async ({ teacherId, monthYear = '' } = {}) => {
    let sql = 'SELECT tp.*, t.fullName, t.employeeCode FROM teacher_payroll tp JOIN teachers t ON t.id = tp.teacherId WHERE 1=1';
    const params = [];
    if (teacherId) { sql += ' AND tp.teacherId = ?'; params.push(id(teacherId, 'Teacher id')); }
    if (monthYear) { sql += ' AND tp.monthYear = ?'; params.push(monthYear); }
    sql += ' ORDER BY tp.monthYear DESC, tp.id DESC';
    return db.all(sql, params);
  });

  handle('teacher-payroll:due-salaries', async ({ monthYear = '' } = {}) => {
    const currentMonth = monthYear || new Date().toISOString().slice(0, 7);
    
    // Get all teachers
    const teachers = await db.all('SELECT id, fullName, employeeCode, baseSalary FROM teachers ORDER BY fullName');
    
    const dueSalaries = await Promise.all(
      teachers.map(async (teacher) => {
        // Check if payroll already exists for this month
        const existing = await db.get(
          'SELECT * FROM teacher_payroll WHERE teacherId = ? AND monthYear = ?',
          [teacher.id, currentMonth]
        );
        
        if (existing) {
          return { ...existing, ...teacher };
        }
        
        // Calculate from attendance
        const attendance = await db.all(
          'SELECT status FROM teacher_attendance WHERE teacherId = ? AND date LIKE ?',
          [teacher.id, currentMonth + '%']
        );
        
        const presentDays = attendance.filter(a => a.status === 'Present').length;
        const totalDays = attendance.length || 30;
        const netSalary = Math.round((teacher.baseSalary * presentDays / (totalDays || 1)) * 100) / 100;
        
        return {
          id: null,
          teacherId: teacher.id,
          fullName: teacher.fullName,
          employeeCode: teacher.employeeCode,
          monthYear: currentMonth,
          totalDays,
          presentDays,
          deductions: 0,
          bonus: 0,
          netSalary,
          status: 'Unpaid',
          paymentDate: '',
          isNew: !existing,
        };
      })
    );
    
    return dueSalaries.filter(r => r.netSalary > 0);
  });


  handle('teacher-payroll:upsert', async (payload = {}) => {
    const teacherId = id(payload.teacherId, 'Teacher id');
    const monthYear = str(payload.monthYear, 'Month/year', { required: true, max: 20 });
    const totalDays = num(payload.totalDays, 'Total days', { min: 1, max: 366 });
    const presentDays = num(payload.presentDays, 'Present days', { min: 0, max: 366 });
    const salary = num(payload.salary ?? 0, 'Salary', { min: 0 });
    const deductions = num(payload.deductions ?? 0, 'Deductions', { min: 0 });
    const bonus = num(payload.bonus ?? 0, 'Bonus', { min: 0 });
    const status = oneOf(payload.status, ['Paid', 'Unpaid'], 'Unpaid');
    const paymentDate = str(payload.paymentDate ?? '', 'Payment date', { max: 20 });

    await db.get('SELECT id FROM teachers WHERE id = ?', [teacherId]);
    
    // Calculate net salary: use provided salary if given, otherwise calculate from base salary
    let netSalary;
    if (salary > 0) {
      netSalary = round(salary - deductions + bonus, 2);
    } else {
      const baseSalary = (await db.get('SELECT baseSalary FROM teachers WHERE id = ?', [teacherId])).baseSalary;
      netSalary = round(baseSalary * presentDays / (totalDays || 1) - deductions + bonus, 2);
    }

    await db.run(
      `INSERT INTO teacher_payroll (teacherId, monthYear, totalDays, presentDays, salary, deductions, bonus, netSalary, status, paymentDate)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(teacherId, monthYear) DO UPDATE SET
         totalDays = excluded.totalDays, presentDays = excluded.presentDays,
         salary = excluded.salary, deductions = excluded.deductions, bonus = excluded.bonus,
         netSalary = excluded.netSalary, status = excluded.status,
         paymentDate = excluded.paymentDate`,
      [teacherId, monthYear, totalDays, presentDays, salary, deductions, bonus, netSalary, status, paymentDate],
    );
    notify(ctx, 'teacher-payroll');
    return { teacherId, monthYear, netSalary };
  });

  handle('teacher-payroll:mark-paid', async ({ id: pid, paymentDate: pdate } = {}) => {
    const payrollId = id(pid, 'Payroll id');
    const paymentDate = str(pdate ?? new Date().toISOString().split('T')[0], 'Payment date', { max: 20 });
    const row = await db.get('SELECT * FROM teacher_payroll WHERE id = ?', [payrollId]);
    if (!row) throw new ValidationError('Payroll record not found');
    await db.run(
      'UPDATE teacher_payroll SET status = ?, paymentDate = ? WHERE id = ?',
      ['Paid', paymentDate, payrollId]
    );
    notify(ctx, 'teacher-payroll');
    return { id: payrollId, status: 'Paid', paymentDate };
  });

  handle('teacher-payroll:remove', async ({ id: pid } = {}) => {
    const payrollId = id(pid, 'Payroll id');
    const row = await db.get('SELECT * FROM teacher_payroll WHERE id = ?', [payrollId]);
    if (!row) throw new ValidationError('Payroll record not found');
    await db.run('DELETE FROM teacher_payroll WHERE id = ?', [payrollId]);
    notify(ctx, 'teacher-payroll');
    return { deleted: true };
  });

  handle('teacher-payroll:get', async ({ id: pid } = {}) => {
    const payrollId = id(pid, 'Payroll id');
    const payroll = await db.get(
      'SELECT tp.* FROM teacher_payroll tp WHERE tp.id = ?',
      [payrollId]
    );
    if (!payroll) throw new ValidationError('Payroll record not found');
    
    const teacher = await db.get(
      'SELECT * FROM teachers WHERE id = ?',
      [payroll.teacherId]
    );
    if (!teacher) throw new ValidationError('Teacher not found');
    
    return { payroll, teacher };
  });

  handle('teacher-attendance:bulk-update', async ({ date, updates } = {}) => {
    const d = str(date, 'Date', { required: true, max: 20 });
    if (!Array.isArray(updates) || !updates.length) throw new ValidationError('Updates required');
    const rows = await Promise.all(
      updates.map(async (item) => {
        const teacherId = id(item.teacherId, 'Teacher id');
        const status = oneOf(item.status, ['Present', 'Absent', 'Late', 'Leave'], 'Present');
        await db.get('SELECT id FROM teachers WHERE id = ?', [teacherId]);
        const existing = await db.get('SELECT id FROM teacher_attendance WHERE teacherId = ? AND date = ?', [teacherId, d]);
        if (existing) {
          await db.run('UPDATE teacher_attendance SET status = ? WHERE id = ?', [status, existing.id]);
        } else {
          await db.run(
            'INSERT INTO teacher_attendance (teacherId, classId, date, status) VALUES (?, NULL, ?, ?)',
            [teacherId, d, status],
          );
        }
        return { teacherId, date: d, status };
      }),
    );
    notify(ctx, 'teacher-attendance');
    return { saved: rows.length };
  });

  /* =================== Student Attendance =================== */
  handle('student-attendance:list', async ({ studentId, classId, dateFrom = '', dateTo = '' } = {}) => {
    const sid = studentId ? id(studentId, 'Student id') : null;
    const cid = classId   ? id(classId, 'Class id')   : null;
    // Use subquery to get unique records per student per date (latest record wins)
    let sql = `SELECT sa.id, sa.studentId, sa.classId, sa.date, sa.status,
               s.name AS studentName, s.rollNo, c.name AS className
               FROM student_attendance sa
               JOIN students s ON s.id = sa.studentId
               LEFT JOIN classes c ON c.id = sa.classId
               WHERE sa.id IN (
                 SELECT MAX(sa2.id)
                 FROM student_attendance sa2
                 WHERE 1=1`;
    const params = [];
    if (sid) { sql += ' AND sa2.studentId = ?'; params.push(sid); }
    if (cid) { sql += ' AND sa2.classId = ?'; params.push(cid); }
    if (dateFrom) { sql += ' AND sa2.date >= ?'; params.push(dateFrom); }
    if (dateTo)   { sql += ' AND sa2.date <= ?'; params.push(dateTo); }
    sql += ` GROUP BY sa2.studentId, sa2.date
               )`;
    if (sid) { sql += ' AND sa.studentId = ?'; params.push(sid); }
    if (cid) { sql += ' AND sa.classId = ?'; params.push(cid); }
    if (dateFrom) { sql += ' AND sa.date >= ?'; params.push(dateFrom); }
    if (dateTo)   { sql += ' AND sa.date <= ?'; params.push(dateTo); }
    sql += ' ORDER BY sa.date DESC, sa.studentId ASC';
    return db.all(sql, params);
  });

  handle('student-attendance:upsert', async (payload = {}) => {
    const studentId = id(payload.studentId, 'Student id');
    const classId   = payload.classId ? id(payload.classId, 'Class id') : null;
    const date      = str(payload.date, 'Date', { required: true, max: 20 });
    const status    = oneOf(payload.status, ['Present', 'Absent', 'Late', 'Leave'], 'Present');
    await db.get('SELECT id FROM students WHERE id = ?', [studentId]);
    if (classId) await db.get('SELECT id FROM classes WHERE id = ?', [classId]);

    // Atomic upsert using SQLite INSERT OR REPLACE — single round-trip, no race condition
    await db.run(
      `INSERT INTO student_attendance (studentId, classId, date, status)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(studentId, classId, date)
       DO UPDATE SET status = excluded.status, classId = excluded.classId`,
      [studentId, classId, date, status],
    );

    notify(ctx, 'student-attendance');
    return { studentId, classId, date, status };
  });

  handle('student-attendance:remove', async ({ id: aid } = {}) => {
    const attId = id(aid, 'Attendance id');
    const row = await db.get('SELECT * FROM student_attendance WHERE id = ?', [attId]);
    if (!row) throw new ValidationError('Attendance record not found');
    await db.run('DELETE FROM student_attendance WHERE id = ?', [attId]);
    notify(ctx, 'student-attendance');
    return { deleted: true };
  });

  handle('student-attendance:bulk-update', async ({ date, updates } = {}) => {
    const d = str(date, 'Date', { required: true, max: 20 });
    if (!Array.isArray(updates) || !updates.length) throw new ValidationError('Updates required');
    const rows = await Promise.all(
      updates.map(async (item) => {
        const studentId = id(item.studentId, 'Student id');
        const classId = item.classId ? id(item.classId, 'Class id') : null;
        const status = oneOf(item.status, ['Present', 'Absent', 'Late', 'Leave'], 'Present');
        await db.get('SELECT id FROM students WHERE id = ?', [studentId]);
        if (classId) await db.get('SELECT id FROM classes WHERE id = ?', [classId]);

        // Atomic upsert using INSERT OR REPLACE — single round-trip per row
        await db.run(
          `INSERT INTO student_attendance (studentId, classId, date, status)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(studentId, classId, date)
           DO UPDATE SET status = excluded.status, classId = excluded.classId`,
          [studentId, classId, d, status],
        );
        return { studentId, classId, date: d, status };
      }),
    );
    notify(ctx, 'student-attendance');
    return { saved: rows.length };
  });
}

/** Invoice number generator shared by the handler and the form pre-fill. */
async function nextInvoiceNumber() {
  const settings = await getSettings();
  const prefix = settings.invoicePrefix || 'INV-';
  const year = new Date().getFullYear();
  const row = await db.get(
    'SELECT invoiceNo FROM invoices WHERE invoiceNo LIKE ? ORDER BY id DESC LIMIT 1',
    [`${prefix}${year}%`],
  );
  let next = 1;
  if (row) {
    const m = String(row.invoiceNo).match(/(\d+)\s*$/);
    if (m) next = parseInt(m[1], 10) + 1;
  }
  return `${prefix}${year}-${String(next).padStart(4, '0')}`;
}

module.exports = {
  registerIpcHandlers,
  nextInvoiceNumber,
  computeStatus,
  subjectsForClass,
  normaliseClassFilter,
  // Exported so the smoke test can prove the renderer offers exactly the bands
  // this process is willing to store.
  CLASS_CATEGORY_KEYS,
  excel: require('./excel'),
};
