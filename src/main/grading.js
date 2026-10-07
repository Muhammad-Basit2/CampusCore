/**
 * Automated grade calculation engine.
 *
 * Kept in the MAIN process so there is exactly one authoritative
 * implementation of the grading rules.
 */
'use strict';

/** Percentage thresholds, evaluated from the highest band downwards. */
const GRADE_BANDS = [
  { min: 90, grade: 'A+', points: 4.0, remark: 'Outstanding' },
  { min: 80, grade: 'A', points: 4.0, remark: 'Excellent' },
  { min: 70, grade: 'B', points: 3.5, remark: 'Very Good' },
  { min: 60, grade: 'C', points: 3.0, remark: 'Good' },
  { min: 50, grade: 'D', points: 2.0, remark: 'Satisfactory' },
  { min: 0, grade: 'Fail', points: 0.0, remark: 'Needs Improvement' },
];

/**
 * Default attendance weight (0..100) factored into the final grade.
 * Override via buildReport option or the attendanceWeight setting.
 */
const DEFAULT_ATTENDANCE_WEIGHT = 10; // 10 % of final grade

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

/** Percentage for a single subject row. */
function subjectPercent(obtained, max) {
  const m = Number(max) || 0;
  if (m <= 0) return 0;
  return round((Number(obtained) || 0) / m * 100, 2);
}

function gradeFor(percentage, passMark = 50) {
  const pct = Number(percentage) || 0;
  const pass = Number(passMark);
  const threshold = Number.isFinite(pass) ? pass : 50;
  if (pct < threshold) {
    return { ...GRADE_BANDS[GRADE_BANDS.length - 1], isPass: false };
  }
  const band = GRADE_BANDS.find((b) => pct >= b.min);
  return { ...(band || GRADE_BANDS[GRADE_BANDS.length - 1]), isPass: true };
}

/**
 * Attendance percentage -> minor grade adjustment.
 *
 * Returns { adjustment, band } where adjustment is a percentage-point
 * bonus (+0 .. +3) based on the student's attendance rate, and band
 * is a human-readable label used in reports.
 */
function attendanceBonus(attendancePct) {
  const pct = Number(attendancePct) || 0;
  if (pct >= 95) return { adjustment: 3, band: 'Excellent attendance' };
  if (pct >= 90) return { adjustment: 2, band: 'Good attendance' };
  if (pct >= 80) return { adjustment: 1, band: 'Satisfactory attendance' };
  if (pct >= 60) return { adjustment: 0, band: 'Below target' };
  return { adjustment: -1, band: 'Poor attendance' };
}

/**
 * Compute the overall attendance percentage for a student given an
 * array of attendance status strings.
 */
function attendancePercentage(records) {
  if (!records || !records.length) return null;
  const total = records.length;
  const present = records.filter((r) => r.status === 'Present').length;
  const late    = records.filter((r) => r.status === 'Late').length;
  return round(((present + 0.5 * late) / total) * 100, 2);
}

/**
 * Build a full report for one student.
 *
 * @param {object} student
 * @param {Array<{subject:string, marksObtained:number, maxMarks:number}>} rows
 * @param {string} passMark
 * @param {string} remark
 * @param {object} [opts]
 * @param {number} [opts.attendanceWeight=10] - percentage weight of attendance in final grade (0-30)
 * @param {Array<{status:string}>} [opts.attendanceRecords] - raw attendance rows for this student
 * @param {number} [opts.attendancePct] - precomputed attendance percentage (skips records if given)
 */
function buildReport(student, rows, passMark = 50, remark = '', opts = {}) {
  const attendanceWeight = Math.min(30, Math.max(0, Number(opts.attendanceWeight ?? DEFAULT_ATTENDANCE_WEIGHT)));
  const attendanceRecs   = opts.attendanceRecords || [];
  const precomputedPct   = opts.attendancePct;

  const subjects = (rows || []).map((r) => {
    const maxMarks = r.maxMarks || 100;
    const percent = subjectPercent(r.marksObtained, maxMarks);
    const band = gradeFor(percent, passMark);
    return {
      subject: r.subject,
      marksObtained: round(r.marksObtained, 2),
      maxMarks: round(maxMarks, 2),
      percentage: percent,
      grade: band.grade,
      isPass: band.isPass,
      hasMark: r.hasMark === undefined ? true : !!r.hasMark,
    };
  });

  const totalObtained = round(subjects.reduce((a, r) => a + r.marksObtained, 0), 2);
  const totalMax = round(subjects.reduce((a, r) => a + (r.maxMarks || 0), 0), 2);
  const rawPercentage = totalMax > 0 ? round((totalObtained / totalMax) * 100, 2) : 0;

  // Attendance-adjusted percentage
  let attPct = precomputedPct;
  if (attPct === undefined || attPct === null) {
    attPct = attendancePercentage(attendanceRecs);
  }
  const attBonus = attPct !== null ? attendanceBonus(attPct) : { adjustment: 0, band: 'No records' };
  const attendanceAdj = attPct !== null ? (attBonus.adjustment * attendanceWeight / 100) : 0;
  const percentage = round(rawPercentage + attendanceAdj, 2);
  const band = gradeFor(percentage, passMark);

  const graded = subjects.filter((s) => s.hasMark);
  const passed = graded.length > 0 && graded.every((s) => s.isPass);

  let position = null;
  subjects.forEach((s) => {
    s.gradePoints = GRADE_BANDS.find((b) => b.grade === s.grade)?.points ?? 0;
  });

  return {
    rollNo: student.rollNo,
    name: student.name,
    studentClass: student.studentClass,
    guardian: student.guardian || '',
    subjects,
    totalObtained,
    totalMax,
    percentage,
    rawPercentage,
    grade: band.grade,
    isPass: passed,
    position,
    remark: remark || autoRemark(passed, percentage),
    passMark: Number(passMark) || 50,
    // Attendance fields
    attendancePct: attPct,
    attendanceWeight,
    attendanceBonus: attBonus.adjustment,
    attendanceBand: attBonus.band,
    attendanceAdj,
  };
}

function autoRemark(isPass, percentage) {
  if (!isPass) return 'Requires improvement - please revise weak subjects.';
  if (percentage >= 90) return 'Outstanding performance. Keep it up!';
  if (percentage >= 80) return 'Excellent work. Aiming higher.';
  if (percentage >= 70) return 'Very good progress across subjects.';
  if (percentage >= 60) return 'Good result. Focus on consistency.';
  return 'Satisfactory. Work on weaker topics.';
}

module.exports = { GRADE_BANDS, buildReport, gradeFor, subjectPercent, round, attendanceBonus, attendancePercentage, DEFAULT_ATTENDANCE_WEIGHT };
