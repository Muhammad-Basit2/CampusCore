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
 * Build a full report for one student.
 * @param {object} student
 * @param {Array<{subject:string, marksObtained:number, maxMarks:number}>} rows
 * @param {string} passMark
 */
function buildReport(student, rows, passMark = 50, remark = '') {
  const subjects = (rows || []).map((r) => {
    const percent = subjectPercent(r.marksObtained, r.maxMarks);
    const band = gradeFor(percent, passMark);
    return {
      subject: r.subject,
      marksObtained: round(r.marksObtained, 2),
      maxMarks: round(r.maxMarks, 2),
      percentage: percent,
      grade: band.grade,
      isPass: band.isPass,
      // False when the subject is configured but has no stored mark for this
      // exam. The marks grid uses this to tell "0" apart from "not entered",
      // which is what makes clearing a cell able to delete the stored row.
      hasMark: r.hasMark === undefined ? true : !!r.hasMark,
    };
  });

  const totalObtained = round(subjects.reduce((s, r) => s + r.marksObtained, 0), 2);
  const totalMax = round(subjects.reduce((s, r) => s + r.maxMarks, 0), 2);
  const percentage = totalMax > 0 ? round((totalObtained / totalMax) * 100, 2) : 0;
  const band = gradeFor(percentage, passMark);
  // Only subjects that actually carry a mark decide pass/fail: a subject the
  // teacher has not entered yet must not silently fail the student.
  const graded = subjects.filter((s) => s.hasMark);
  const passed = graded.length > 0 && graded.every((s) => s.isPass);

  let position = null;
  subjects.forEach((s) => {
    // position within the student derived later when ranking is known
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
    grade: band.grade,
    isPass: passed,
    position,
    remark: remark || autoRemark(passed, percentage),
    passMark: Number(passMark) || 50,
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

module.exports = { GRADE_BANDS, buildReport, gradeFor, subjectPercent, round };
