/**
 * Preload script - the only bridge between the renderer and the main process.
 *
 * contextBridge exposes a small, explicit, promise-based API. No raw ipcRenderer,
 * no Node APIs and no remote module are leaked into the renderer.
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** Wraps an invoke call and normalises the {ok, data|error} envelope. */
async function invoke(channel, payload) {
  const result = await ipcRenderer.invoke(channel, payload);
  if (result && result.ok) return result.data;
  throw new Error((result && result.error) || `IPC call "${channel}" failed`);
}

const api = {
  /* ---------------- meta ---------------- */
  app: {
    getInfo: () => invoke('app:get-info'),
    getDbPath: () => invoke('app:get-db-path'),
  },

  /* ---------------- students ---------------- */
  students: {
    list: (search = '') => invoke('students:list', { search }),
    create: (payload) => invoke('students:create', payload),
    update: (payload) => invoke('students:update', payload),
    remove: (id) => invoke('students:remove', { id }),
    get: (id) => invoke('students:get', { id }),
  },

  /* ---------------- invoices / fees ---------------- */
  invoices: {
    list: (filters = {}) => invoke('invoices:list', filters),
    create: (payload) => invoke('invoices:create', payload),
    update: (payload) => invoke('invoices:update', payload),
    remove: (id) => invoke('invoices:remove', { id }),
    get: (id) => invoke('invoices:get', { id }),
    addPayment: (payload) => invoke('invoices:add-payment', payload),
    payments: (invoiceId) => invoke('invoices:payments', { invoiceId }),
    nextNumber: () => invoke('invoices:next-number'),
  },

  /* ---------------- grades / report cards ---------------- */
  grades: {
    listSubjects: (payload) => invoke('grades:list-subjects', payload),
    listClasses: () => invoke('grades:list-classes'),
    addSubject: (payload) => invoke('grades:add-subject', payload),
    updateSubject: (payload) => invoke('grades:update-subject', payload),
    removeSubject: (payload) => invoke('grades:remove-subject', payload),
    saveMarks: (payload) => invoke('grades:save-marks', payload),
    getReport: (payload) => invoke('grades:get-report', payload),
    getResults: (payload) => invoke('grades:get-results', payload),
    saveRemark: (payload) => invoke('grades:save-remark', payload),
  },

  /* ------------------- teachers ------------------- */
  teachers: {
    list: (search = '') => invoke('teachers:list', { search }),
    get: (id) => invoke('teachers:get', { id }),
    create: (payload) => invoke('teachers:create', payload),
    update: (payload) => invoke('teachers:update', payload),
    remove: (id) => invoke('teachers:remove', { id }),
  },

  /* ---------------- teacher-attendance ---------------- */
  teacherAttendance: {
    list: (filters = {}) => invoke('teacher-attendance:list', filters),
    upsert: (payload) => invoke('teacher-attendance:upsert', payload),
    remove: (id) => invoke('teacher-attendance:remove', { id }),
  },

  /* ---------------- teacher-payroll ---------------- */
  teacherPayroll: {
    list: (filters = {}) => invoke('teacher-payroll:list', filters),
    upsert: (payload) => invoke('teacher-payroll:upsert', payload),
    remove: (id) => invoke('teacher-payroll:remove', { id }),
  },

  /* ---------------- student-attendance ---------------- */
  studentAttendance: {
    list: (filters = {}) => invoke('student-attendance:list', filters),
    upsert: (payload) => invoke('student-attendance:upsert', payload),
    bulkUpdate: (updates) => invoke('student-attendance:bulk-update', updates),
    remove: (id) => invoke('student-attendance:remove', { id }),
  },

  /* ---------------- settings ---------------- */
  settings: {
    getAll: () => invoke('settings:get-all'),
    save: (payload) => invoke('settings:save', payload),
    reset: () => invoke('settings:reset'),
    setAttendanceWeight: (weight) => invoke('settings:attendance-weight', { attendanceWeight: weight }),
  },

  /* ---------------- dashboard ---------------- */
  dashboard: {
    stats: () => invoke('dashboard:stats'),
  },

  /* ---------------- classes & subjects ---------------- */
  classes: {
    list: () => invoke('classes:list'),
    create: (payload) => invoke('classes:create', payload),
    update: (payload) => invoke('classes:update', payload),
    remove: (id) => invoke('classes:remove', { id }),
  },

  subjects: {
    list: (classId) => invoke('subjects:list', { classId }),
    create: (payload) => invoke('subjects:create', payload),
    update: (payload) => invoke('subjects:update', payload),
    remove: (payload) => invoke('subjects:remove', payload),
  },

  /* ---------------- data import / export ---------------- */
  data: {
    exportStudents: () => invoke('data:export-students'),
    exportInvoices: () => invoke('data:export-invoices'),
    exportMarks: (payload) => invoke('data:export-marks', payload),
    exportClassesSubjects: () => invoke('data:export-classes-subjects'),
    importStudentsDialog: () => invoke('data:import-students-dialog'),
    importMarksDialog: (examName) => invoke('data:import-marks-dialog', { examName }),
  },

  /* ---------------- push events from main ---------------- */
  on: (event, callback) => {
    const allowed = ['nav:goto', 'nav:help', 'app:error', 'data:changed'];
    if (!allowed.includes(event)) throw new Error(`Unknown event "${event}"`);
    const listener = (_evt, payload) => callback(payload);
    ipcRenderer.on(event, listener);
    return () => ipcRenderer.removeListener(event, listener);
  },
};

contextBridge.exposeInMainWorld('api', api);
