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

function id(value, field = 'id') {
  const v = int(value, field, { min: 1 });
  if (!v) throw new ValidationError(`${field} is required`);
  return v;
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
/* Class-aware subject resolution                                      */
/* ------------------------------------------------------------------ */

/**
 * Normalises a class filter coming from the renderer.
 *
 * The empty string and the wildcard both mean "no class filter", which makes the
 * subject list the union of every configured subject. Anything else is an exact
 * (case-insensitive) class name.
 */
function normaliseClassFilter(value) {
  const v = value === undefined || value === null ? '' : String(value).trim();
  if (!v || v === db.WILDCARD_CLASS) return '';
  return v;
}

/**
 * The subjects that apply to one class, in display order.
 *
 * A class-specific row wins over the '*' wildcard row of the same name, so a
 * teacher can give Class 5 its own maximum for Mathematics while every other
 * class keeps the shared default. Ordering is driven by the effective row's
 * sortOrder, with the subject name as a stable tie-breaker.
 *
 * Subjects defined in the Classes & Subjects module (class_subjects table) are
 * also included so that the report card pulls from both management areas.
 */
async function subjectsForClass(className) {
  const cls = normaliseClassFilter(className);

  // 1. Fetch from the grades subjects table (className = 'Class X' or '*').
  const gradeRows = await db.all(
    `SELECT * FROM subjects
      WHERE className = ? COLLATE NOCASE OR className = ?
      ORDER BY sortOrder ASC, name COLLATE NOCASE ASC`,
    [cls, db.WILDCARD_CLASS],
  );

  // 2. Fetch from the classes & subjects module (class_subjects table).
  let csRows = [];
  if (cls) {
    const classRow = await db.get(
      'SELECT id FROM classes WHERE name = ? COLLATE NOCASE',
      [cls],
    );
    if (classRow) {
      csRows = await db.all(
        'SELECT id, name, code, status FROM class_subjects WHERE classId = ? AND status = ?',
        [classRow.id, 'Active'],
      );
    }
  }

  // 3. Merge: grade rows take priority; class_subjects fill gaps.
  const byName = new Map();
  for (const row of gradeRows) {
    byName.set(row.name.toLowerCase(), {
      // The row id travels with the subject: the Grades view keys its edit and
      // delete actions off it, so dropping it here leaves those buttons inert.
      id: row.id,
      name: row.name,
      maxMarks: Number(row.maxMarks) || 100,
      code: row.code || '',
      sortOrder: Number(row.sortOrder) || 0,
      className: row.className || cls,
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
        className: cls,
        source: 'classSubjects',
      });
    }
  }

  const merged = [...byName.values()].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
  );
  return merged;
}

/** Distinct class names that appear on students, for populating pickers. */
async function knownClasses() {
  const rows = await db.all(
    'SELECT DISTINCT studentClass AS name FROM students WHERE studentClass <> ?',
    [db.WILDCARD_CLASS],
  );
  const fromSubjects = await db.all(
    'SELECT DISTINCT className AS name FROM subjects WHERE className <> ?',
    [db.WILDCARD_CLASS],
  );
  const set = new Map();
  for (const r of [...rows, ...fromSubjects]) {
    if (r.name) set.set(r.name.toLowerCase(), r.name);
  }
  return [...set.values()].sort((a, b) => a.localeCompare(b));
}


function registerIpcHandlers(ctx) {
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
    notify(ctx, 'students');
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

    await db.run(
      'UPDATE students SET rollNo = ?, name = ?, studentClass = ?, guardian = ?, phone = ? WHERE id = ?',
      [r, n, c, g, p, studentId],
    );
    await db.run(
      'UPDATE invoices SET rollNo = ?, studentName = ?, studentClass = ? WHERE studentId = ?',
      [r, n, c, studentId],
    );
    await db.run('UPDATE marks SET rollNo = ? WHERE studentId = ?', [r, studentId]);
    notify(ctx, 'students');
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
    notify(ctx, 'students');
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
   * With no class the result is every configured row, grouped so the same name
   * used in two classes is visible once per class. With a class it is the
   * effective list: class-specific rows overriding the shared '*' ones.
   */
  handle('grades:list-subjects', async ({ studentClass } = {}) => {
    const cls = normaliseClassFilter(studentClass);
    if (cls) return subjectsForClass(cls);

    const rows = await db.all(
      'SELECT * FROM subjects ORDER BY sortOrder ASC, name COLLATE NOCASE ASC, className ASC',
    );
    return rows;
  });

  /** Class names available to configure subjects against. */
  handle('grades:list-classes', async () => ({
    classes: await knownClasses(),
    wildcard: db.WILDCARD_CLASS,
  }));

  handle('grades:add-subject', async ({ name, maxMarks, studentClass } = {}) => {
    const n = str(name, 'Subject', { required: true, max: 60 });
    const m = num(maxMarks, 'Max marks', { min: 1, max: 1000, fallback: 100 });
    const cls = normaliseClassFilter(studentClass) || db.WILDCARD_CLASS;
    const dupe = await db.get(
      'SELECT id FROM subjects WHERE name = ? COLLATE NOCASE AND className = ? COLLATE NOCASE',
      [n, cls],
    );
    if (dupe) {
      throw new ValidationError(
        cls === db.WILDCARD_CLASS
          ? `Subject "${n}" already exists`
          : `Subject "${n}" is already configured for ${cls}`,
      );
    }
    // Continue the ordering of the set this subject joins: its own class when it
    // has one, otherwise the shared list.
    const last = await db.get(
      'SELECT IFNULL(MAX(sortOrder), 0) AS m FROM subjects WHERE className = ? COLLATE NOCASE',
      [cls],
    );
    const res = await db.run(
      'INSERT INTO subjects (name, className, maxMarks, sortOrder) VALUES (?, ?, ?, ?)',
      [n, cls, m, (last ? last.m : 0) + 1],
    );
    notify(ctx, 'subjects');
    return db.get('SELECT * FROM subjects WHERE id = ?', [res.lastID]);
  });

  handle('grades:update-subject', async ({ id: sid, name, maxMarks, studentClass } = {}) => {
    const subjectId = id(sid, 'Subject id');
    const n = str(name, 'Subject', { required: true, max: 60 });
    const m = num(maxMarks, 'Max marks', { min: 1, max: 1000, fallback: 100 });
    const current = await db.get('SELECT * FROM subjects WHERE id = ?', [subjectId]);
    if (!current) throw new ValidationError('Subject not found');

    // A missing class keeps the subject where it is; an explicit empty/'*' moves
    // it to the shared list.
    const hasClass = studentClass !== undefined && studentClass !== null;
    const cls = hasClass ? normaliseClassFilter(studentClass) || db.WILDCARD_CLASS : current.className;

    const dupe = await db.get(
      `SELECT id FROM subjects
        WHERE name = ? COLLATE NOCASE AND className = ? COLLATE NOCASE AND id <> ?`,
      [n, cls, subjectId],
    );
    if (dupe) {
      throw new ValidationError(
        cls === db.WILDCARD_CLASS
          ? `Subject "${n}" already exists`
          : `Subject "${n}" is already configured for ${cls}`,
      );
    }

    // Renaming a subject must carry its recorded marks along, otherwise history
    // silently detaches from the subject it belongs to.
    if (n.toLowerCase() !== String(current.name).toLowerCase()) {
      await db.run('UPDATE subjects SET name = ?, className = ?, maxMarks = ? WHERE id = ?', [
        n,
        cls,
        m,
        subjectId,
      ]);
      await db.run('UPDATE marks SET subject = ? WHERE subject = ? COLLATE NOCASE', [
        n,
        current.name,
      ]);
    } else {
      await db.run('UPDATE subjects SET className = ?, maxMarks = ? WHERE id = ?', [
        cls,
        m,
        subjectId,
      ]);
    }
    notify(ctx, 'subjects');
    return db.get('SELECT * FROM subjects WHERE id = ?', [subjectId]);
  });

  handle('grades:remove-subject', async ({ id: sid } = {}) => {
    const subjectId = id(sid, 'Subject id');
    const subject = await db.get('SELECT * FROM subjects WHERE id = ?', [subjectId]);
    if (!subject) throw new ValidationError('Subject not found');
    await db.run('DELETE FROM subjects WHERE id = ?', [subjectId]);

    // Only drop marks that belong to this subject in this class. The shared '*'
    // row governs every other class, so its marks must survive.
    if (subject.className === db.WILDCARD_CLASS) {
      await db.run('DELETE FROM marks WHERE subject = ? COLLATE NOCASE', [subject.name]);
    } else {
      await db.run(
        `DELETE FROM marks
          WHERE subject = ? COLLATE NOCASE AND studentClass = ? COLLATE NOCASE`,
        [subject.name, subject.className],
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
    const rows = subjects.map((s) => {
      const found = marks.find((m) => m.subject === s.name);
      return {
        subject: s.name,
        marksObtained: found ? found.marksObtained : 0,
        maxMarks: found ? found.maxMarks : s.maxMarks,
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

    const students = cls
      ? await db.all('SELECT * FROM students WHERE studentClass = ? ORDER BY name COLLATE NOCASE', [cls])
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

    const results = students.map((s) => {
      const rows = (byStudent.get(s.id) || []).map((sub) => {
        // roll AND class must both match: a same-roll student in another class
        // must never leak into this row.
        const found = marks.find(
          (m) =>
            m.rollNo === s.rollNo &&
            m.studentClass === s.studentClass &&
            m.subject === sub.name,
        );
        return {
          subject: sub.name,
          marksObtained: found ? found.marksObtained : 0,
          maxMarks: found ? found.maxMarks : sub.maxMarks,
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
    return db.all('SELECT * FROM classes ORDER BY gradeOrder ASC, name ASC');
  });

  handle('classes:create', async ({ name, gradeOrder = 0 }) => {
    const className = str(name, 'Class name', { required: true, max: 120 });
    const order = int(gradeOrder, 'Grade order', { min: 0, fallback: 0 });
    await db.run(
      'INSERT INTO classes (name, gradeOrder) VALUES (?, ?)',
      [className, order],
    );
    const cls = await db.get('SELECT * FROM classes WHERE id = last_insert_rowid()');
    notify(ctx, 'classes');
    return cls;
  });

  handle('classes:update', async ({ id: classId, name, gradeOrder }) => {
    const targetId = id(classId, 'id');
    const className = str(name, 'Class name', { required: true, max: 120 });
    const order = int(gradeOrder, 'Grade order', { min: 0, fallback: 0 });
    const row = await db.get('SELECT name FROM classes WHERE id = ?', [targetId]);
    if (!row) throw new Error('Class not found');
    await db.run(
      'UPDATE classes SET name = ?, gradeOrder = ? WHERE id = ?',
      [className, order, targetId],
    );
    const cls = await db.get('SELECT * FROM classes WHERE id = ?', [targetId]);
    notify(ctx, 'classes');
    return cls;
  });

  handle('classes:remove', async ({ id: classId }) => {
    const targetId = id(classId, 'id');
    const cls = await db.get('SELECT name FROM classes WHERE id = ?', [targetId]);
    if (!cls) throw new Error('Class not found');
    // class_subjects.classId is ON DELETE CASCADE, so subjects go with it.
    await db.run('DELETE FROM classes WHERE id = ?', [targetId]);
    notify(ctx, 'classes');
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
};
