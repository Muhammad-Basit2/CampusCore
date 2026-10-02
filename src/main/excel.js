/**
 * Excel import / export helpers.
 * Uses the xlsx (SheetJS) library. All IO goes through Electron dialog.
 */
'use strict';
const XLSX = require('xlsx');
const { dialog } = require('electron');
const fs = require('fs');
const db = require('./database');

function clean(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return String(value);
  return value;
}

function toExportRows(rows) {
  if (!rows.length) return [];
  const headers = Object.keys(rows[0]);
  return [headers, ...rows.map((r) => headers.map((h) => clean(r[h])))];
}

function buildWorkbook(sheets) {
  const wb = XLSX.utils.book_new();
  for (const [name, data] of Object.entries(sheets)) {
    const ws = XLSX.utils.aoa_to_sheet(data);
    if (data.length > 0) {
      const colWidths = data[0].map((h, ci) => {
        const lens = data.map((row) => String(row[ci] ?? '').length);
        return { wch: Math.max(String(h).length, ...lens) + 2 };
      });
      ws['!cols'] = colWidths;
    }
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  return wb;
}

async function readExcelFile(filePath) {
  const buf = fs.readFileSync(filePath);
  const wb = XLSX.read(buf, { type: 'buffer' });
  return wb.SheetNames.map((name) => ({
    name,
    rows: XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: '' }),
  }));
}

/**
 * Normalises a header into a lookup key.
 *
 * Spreadsheet headers are written for humans - "Roll No", "Student Class",
 * "MAX MARKS" - so every space, dash and underscore is dropped and the rest is
 * lowercased. This is what lets an exported file be re-imported unchanged.
 */
function normaliseHeader(header) {
  return String(header).toLowerCase().replace(/[\s_\-.]/g, '');
}

/**
 * Rewrites each row so its keys are normalised, and exposes the normalised
 * header list too. Matching is done on those keys, which is why callers must
 * look values up by `normaliseHeader` as well.
 */
function normaliseSheet(rows) {
  if (!rows.length) return { rows: [], headers: [] };
  const headers = Object.keys(rows[0]).map(normaliseHeader);
  return {
    headers,
    rows: rows.map((row) => {
      const out = {};
      for (const key of Object.keys(row)) out[normaliseHeader(key)] = row[key];
      return out;
    }),
  };
}

/** First non-empty value among a list of normalised header aliases. */
function pick(row, ...aliases) {
  for (const alias of aliases) {
    const value = row[alias];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return value;
    }
  }
  return '';
}

async function showSaveDialog(title, defaultPath) {
  const result = await dialog.showSaveDialog({
    title,
    defaultPath,
    filters: [{ name: 'Excel', extensions: ['xlsx'] }, { name: 'All', extensions: ['*'] }],
  });
  return result;
}

async function showOpenDialog() {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Excel', extensions: ['xlsx', 'xls'] }, { name: 'All', extensions: ['*'] }],
  });
  return result;
}

/* ------------------------------------------------------------------ */
/* Export                                                             */
/* ------------------------------------------------------------------ */

async function exportStudents() {
  const rows = await db.all(
    'SELECT id, rollNo, name, studentClass, guardian, phone, createdAt FROM students ORDER BY id',
  );
  const wb = buildWorkbook({ Students: toExportRows(rows) });
  const result = await showSaveDialog('Export Students', 'students.xlsx');
  if (result.canceled) return { ok: false };
  XLSX.writeFile(wb, result.filePath);
  return { ok: true, rows: rows.length };
}

async function exportInvoices() {
  const rows = await db.all(
    'SELECT i.id, i.invoiceNo, s.rollNo, s.name AS studentName, i.studentClass,' +
    ' i.feeMonth, i.description, i.amountDue, i.discount, i.amountPaid,' +
    ' i.status, i.notes, i.createdAt FROM invoices i JOIN students s ON s.id = i.studentId ORDER BY i.id',
  );
  const wb = buildWorkbook({ Invoices: toExportRows(rows) });
  const result = await showSaveDialog('Export Invoices', 'invoices.xlsx');
  if (result.canceled) return { ok: false };
  XLSX.writeFile(wb, result.filePath);
  return { ok: true, rows: rows.length };
}

async function exportMarks({ examName, studentClass }) {
  const cls = studentClass || '';
  const rows = await db.all(
    'SELECT m.id, s.rollNo, s.name AS studentName, m.studentClass, m.subject,' +
    ' m.marksObtained, m.maxMarks, m.examName, m.updatedAt FROM marks m' +
    ' JOIN students s ON s.id = m.studentId' +
    " WHERE (? = '' OR m.studentClass = ? COLLATE NOCASE) AND m.examName = ?" +
    ' ORDER BY m.studentClass, s.rollNo, m.subject',
    [cls, cls, examName],
  );
  const wb = buildWorkbook({ Marks: toExportRows(rows) });
  const result = await showSaveDialog('Export Marks', 'marks-' + examName + '.xlsx');
  if (result.canceled) return { ok: false };
  XLSX.writeFile(wb, result.filePath);
  return { ok: true, rows: rows.length };
}

async function exportClassesSubjects() {
  const classes = await db.all('SELECT id, name, gradeOrder, createdAt FROM classes ORDER BY gradeOrder');
  const subjects = await db.all(
    'SELECT id, name, className, classIds, maxMarks, sortOrder, createdAt' +
    ' FROM subjects ORDER BY sortOrder',
  );
  const cs = await db.all(
    'SELECT cs.id, c.name AS className, cs.name AS subjectName, cs.code, cs.status, cs.createdAt' +
    ' FROM class_subjects cs JOIN classes c ON c.id = cs.classId ORDER BY c.gradeOrder, cs.id',
  );
  const wb = buildWorkbook({
    Classes: toExportRows(classes),
    Subjects: toExportRows(subjects),
    ClassSubjects: toExportRows(cs),
  });
  const result = await showSaveDialog('Export Classes & Subjects', 'classes-subjects.xlsx');
  if (result.canceled) return { ok: false };
  XLSX.writeFile(wb, result.filePath);
  return { ok: true, classes: classes.length, subjects: subjects.length, classSubjects: cs.length };
}

/* ------------------------------------------------------------------ */
/* Import                                                             */
/* ------------------------------------------------------------------ */

async function importStudents(filePath) {
  const sheets = await readExcelFile(filePath);
  const sheet = sheets[0];
  if (!sheet || !sheet.rows.length) throw new Error('File is empty or has no data');
  const { headers, rows } = normaliseSheet(sheet.rows);
  const required = [
    ['rollno', 'Roll No'],
    ['name', 'Name'],
    ['studentclass', 'Student Class'],
  ];
  const missing = required.filter(([key]) => !headers.includes(key)).map(([, label]) => label);
  if (missing.length) throw new Error('Missing required column(s): ' + missing.join(', '));
  let created = 0, updated = 0, skipped = 0;
  for (const row of rows) {
    const rollNo = String(pick(row, 'rollno', 'rollnumber', 'roll')).trim();
    const name = String(pick(row, 'name', 'studentname', 'fullname')).trim();
    const studentClass = String(pick(row, 'studentclass', 'class', 'classname')).trim();
    const guardian = String(pick(row, 'guardian', 'guardianname', 'parent', 'parentname')).trim();
    const phone = String(pick(row, 'phone', 'phoneno', 'mobile', 'contact')).trim();
    if (!rollNo || !name || !studentClass) { skipped++; continue; }
    const existing = await db.get(
      'SELECT id, name, guardian, phone FROM students WHERE rollNo = ? AND studentClass = ? COLLATE NOCASE',
      [rollNo, studentClass],
    );
    if (existing) {
      // Refresh the details that changed; blank cells never wipe existing data.
      if (existing.name !== name || (guardian && existing.guardian !== guardian) || (phone && existing.phone !== phone)) {
        await db.run(
          'UPDATE students SET name = ?, guardian = ?, phone = ? WHERE id = ?',
          [name, guardian || existing.guardian || '', phone || existing.phone || '', existing.id],
        );
        updated++;
      } else {
        skipped++;
      }
      continue;
    }
    await db.run(
      'INSERT INTO students (rollNo, name, studentClass, guardian, phone) VALUES (?, ?, ?, ?, ?)',
      [rollNo, name, studentClass, guardian, phone],
    );
    created++;
  }
  return { created, updated, skipped };
}

async function importMarks(filePath, examName) {
  const sheets = await readExcelFile(filePath);
  const sheet = sheets[0];
  if (!sheet || !sheet.rows.length) throw new Error('File is empty or has no data');
  const { headers, rows } = normaliseSheet(sheet.rows);
  const required = [
    ['rollno', 'Roll No'],
    ['studentclass', 'Student Class'],
    ['subject', 'Subject'],
    ['marksobtained', 'Marks Obtained'],
  ];
  const missing = required.filter(([key]) => !headers.includes(key)).map(([, label]) => label);
  if (missing.length) throw new Error('Missing required column(s): ' + missing.join(', '));
  const students = await db.all('SELECT id, rollNo, studentClass FROM students ORDER BY id');
  const studentMap = new Map();
  for (const s of students) studentMap.set((s.rollNo + '|' + s.studentClass).toLowerCase(), s.id);
  const subjectMax = await db.all('SELECT name, className, maxMarks FROM subjects');
  const maxMarksMap = new Map();
  for (const s of subjectMax) maxMarksMap.set(normaliseHeader(s.name), Number(s.maxMarks) || 100);
  let inserted = 0, updated = 0, skipped = 0;
  for (const row of rows) {
    const rollNo = String(pick(row, 'rollno', 'rollnumber', 'roll')).trim();
    const studentClass = String(pick(row, 'studentclass', 'class', 'classname')).trim();
    const subject = String(pick(row, 'subject', 'subjectname')).trim();
    const marksObtained = Number(
      pick(row, 'marksobtained', 'marksobtain', 'marks', 'obtained', 'marksgot') || 0,
    );
    if (!rollNo || !studentClass || !subject) { skipped++; continue; }
    const studentKey = (rollNo + '|' + studentClass).toLowerCase();
    // The map stores the student id directly, not the row object.
    const studentId = studentMap.get(studentKey);
    if (studentId === undefined) { skipped++; continue; }
    // An explicit Max Marks column in the file always wins over the default.
    const explicitMax = Number(pick(row, 'maxmarks', 'totalmarks', 'outof'));
    const maxMarks = Number.isFinite(explicitMax) && explicitMax > 0
      ? explicitMax
      : (maxMarksMap.get(normaliseHeader(subject)) || 100);
    const existing = await db.get(
      'SELECT id FROM marks WHERE rollNo = ? AND studentClass = ? COLLATE NOCASE AND subject = ? COLLATE NOCASE AND examName = ?',
      [rollNo, studentClass, subject, examName],
    );
    if (existing) {
      await db.run(
        "UPDATE marks SET marksObtained = ?, maxMarks = ?, updatedAt = datetime('now','localtime') WHERE id = ?",
        [marksObtained, maxMarks, existing.id],
      );
      updated++;
    } else {
      await db.run(
        'INSERT INTO marks (studentId, rollNo, studentClass, subject, marksObtained, maxMarks, examName) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [studentId, rollNo, studentClass, subject, marksObtained, maxMarks, examName],
      );
      inserted++;
    }
  }
  return { inserted, updated, skipped };
}

module.exports = {
  exportStudents,
  exportInvoices,
  exportMarks,
  exportClassesSubjects,
  importStudents,
  importMarks,
};


