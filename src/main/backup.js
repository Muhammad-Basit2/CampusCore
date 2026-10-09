/**
 * Backup/Import module for CampusCore.
 * Handles exporting all data to a JSON file and importing from backup.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const db = require('./database');

const TABLES = [
  'students',
  'invoices',
  'payments',
  'subjects',
  'classes',
  'class_subjects',
  'subject_classes',
  'marks',
  'reportRemarks',
  'settings',
  'teachers',
  'teacher_attendance',
  'teacher_payroll',
  'student_attendance',
];

/**
 * Exports all data from the database to a JSON backup object.
 */
async function exportAll() {
  const backup = {
    version: 1,
    exportedAt: new Date().toISOString(),
    tables: {},
  };

  for (const table of TABLES) {
    const rows = await db.all('SELECT * FROM ' + table);
    backup.tables[table] = rows || [];
  }

  return backup;
}

/**
 * Imports data from a backup object into the database.
 * Clears existing data first to ensure clean import.
 */
async function importAll(backup) {
  if (!backup || typeof backup !== 'object' || !backup.tables) {
    throw new Error('Invalid backup file format');
  }

  // Begin transaction for atomic import
  await db.run('BEGIN TRANSACTION');

  try {
    // Clear all existing data in dependency order (children before parents)
    await db.run('DELETE FROM student_attendance');
    await db.run('DELETE FROM teacher_payroll');
    await db.run('DELETE FROM teacher_attendance');
    await db.run('DELETE FROM reportRemarks');
    await db.run('DELETE FROM marks');
    await db.run('DELETE FROM payments');
    await db.run('DELETE FROM invoices');
    await db.run('DELETE FROM subject_classes');
    await db.run('DELETE FROM class_subjects');
    await db.run('DELETE FROM subjects');
    await db.run('DELETE FROM teachers');
    await db.run('DELETE FROM classes');
    await db.run('DELETE FROM students');
    await db.run('DELETE FROM settings');

    // Import data in dependency order
    const importOrder = [
      'settings',
      'classes',
      'students',
      'subjects',
      'class_subjects',
      'subject_classes',
      'invoices',
      'payments',
      'marks',
      'reportRemarks',
      'teachers',
      'teacher_attendance',
      'teacher_payroll',
      'student_attendance',
    ];

    let imported = {
      settings: 0,
      students: 0,
      classes: 0,
      subjects: 0,
      classSubjects: 0,
      subjectClasses: 0,
      invoices: 0,
      payments: 0,
      marks: 0,
      teachers: 0,
      teacherAttendance: 0,
      teacherPayroll: 0,
      studentAttendance: 0,
    };

    for (const table of importOrder) {
      const rows = backup.tables[table] || [];
      for (const row of rows) {
        const columns = Object.keys(row).join(', ');
        const placeholders = Object.keys(row).map(() => '?').join(', ');
        const values = Object.values(row);
        await db.run(`INSERT INTO ${table} (${columns}) VALUES (${placeholders})`, values);
      }
      if (table === 'reportRemarks') imported.reportRemarks = rows.length;
      else if (table === 'teacher_attendance') imported.teacherAttendance = rows.length;
      else if (table === 'teacher_payroll') imported.teacherPayroll = rows.length;
      else if (table === 'student_attendance') imported.studentAttendance = rows.length;
      else if (table) imported[table] = rows.length;
    }

    await db.run('COMMIT');
    return { success: true, imported };
  } catch (err) {
    await db.run('ROLLBACK');
    throw err;
  }
}

module.exports = { exportAll, importAll };
