/**
 * In-page assertions for the Grades & Reports view.
 *
 * Loaded by tools/grades-ui-harness.html after the real ui.js and grades.js, so
 * every assertion below runs against the same code the application ships.
 * The stub window.api is deliberately mixed-case: the class pills read
 * "Class 1" while the students are stored as "class 1", which is the state the
 * case-sensitivity bugs used to break.
 */
'use strict';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

// gradeOrder drives the category the class is grouped and labelled under, so the
// fixture deliberately spans two bands: Play Group (order 0) is Pre-Primary and
// Class 1 (order 1) is Primary. That is what makes the picker groups and the
// Select All toggles meaningful assertions rather than one lonely group.
const CLASSES = [
  { id: 1, name: 'Class 1', gradeOrder: 1 },
  { id: 2, name: 'Play Group', gradeOrder: 0 },
];

// Every subject is explicitly assigned to the classes it is taught in; there is
// no wildcard/"shared" row any more. Maths is taught in both classes, so it is
// the fixture that proves a multi-class subject renders both names and shows up
// under either filter.
const SUBJECTS = [
  { id: 1, name: 'English', className: 'Class 1', classIds: [1], classNames: ['Class 1'], maxMarks: 100 },
  { id: 2, name: 'Maths', className: 'Class 1, Play Group', classIds: [1, 2], classNames: ['Class 1', 'Play Group'], maxMarks: 100 },
  { id: 3, name: 'Science', className: 'Play Group', classIds: [2], classNames: ['Play Group'], maxMarks: 50 },
];

/**
 * Applies the real filter: a subject belongs to a class when that class is one
 * of its assignments. With no class selected everything comes back.
 */
function subjectsForClass(className) {
  const want = String(className || '').toLowerCase();
  if (!want) return SUBJECTS;
  return SUBJECTS.filter((s) => s.classNames.some((n) => n.toLowerCase() === want));
}

const STUDENTS = [
  { id: 11, rollNo: 'a-001', name: 'Alice Khan', studentClass: 'class 1', guardian: 'G', phone: '' },
  { id: 12, rollNo: 'a-002', name: 'Bob Ali Jr', studentClass: 'class 1', guardian: 'G', phone: '' },
  { id: 13, rollNo: 'p-001', name: 'Zara Play', studentClass: 'Play Group', guardian: 'G', phone: '' },
];

function makeRow(s, pct, pass) {
  return {
    student: s,
    report: {
      rollNo: s.rollNo,
      name: s.name,
      studentClass: s.studentClass,
      guardian: s.guardian,
      totalObtained: Math.round((pct / 100) * 250),
      totalMax: 250,
      percentage: pct,
      grade: pass ? 'A' : 'D',
      isPass: pass,
      position: 0,
      remark: '',
      passMark: 50,
      subjects: SUBJECTS.map((sub) => ({
        subject: sub.name,
        marksObtained: Math.round((pct / 100) * sub.maxMarks),
        maxMarks: sub.maxMarks,
        percentage: pct,
        grade: pass ? 'A' : 'D',
        isPass: pass,
        hasMark: true,
      })),
    },
  };
}

function buildResults() {
  const rows = [
    makeRow(STUDENTS[0], 80, true),
    makeRow(STUDENTS[1], 40, false),
    makeRow(STUDENTS[2], 60, true),
  ];
  rows.forEach((r, i) => {
    r.report.position = i + 1;
  });
  return rows;
}

const SETTINGS = { passMarkPercentage: '50', schoolName: 'Test School', academicYear: '2026' };

function makeApi() {
  // Records what the Subjects tab sent so the assertions can prove the payload
  // carries an explicit class list rather than a wildcard flag.
  const calls = { addSubject: [], updateSubject: [], classUpdate: [] };
  // A class edit has to be visible to the tree rebuild that follows it, so the
  // stub reflects the save into an override layer that classes.list() merges
  // over the fixture. Mutating CLASSES directly would leak into every earlier
  // assertion that depends on its gradeOrder.
  const classEdits = new Map();
  const classList = async () => CLASSES
    .map((c) => (classEdits.has(Number(c.id)) ? { ...c, ...classEdits.get(Number(c.id)) } : { ...c }))
    // Mirrors the real handler's `ORDER BY gradeOrder ASC, name ASC`. Without
    // this the picker and the tree would keep the fixture's own order, which
    // would let a grouping assertion pass for the wrong reason.
    .sort((a, b) => (a.gradeOrder - b.gradeOrder)
      || String(a.name).localeCompare(String(b.name)));
  const classUpdate = async (payload) => {
    calls.classUpdate.push(payload);
    const id = Number(payload.id);
    const row = CLASSES.find((c) => Number(c.id) === id);
    if (!row) return {};
    classEdits.set(id, {
      name: payload.name,
      gradeOrder: payload.gradeOrder,
      categoryKey: payload.categoryKey,
    });
    return { ...row, ...classEdits.get(id) };
  };
  // A class assigned to a band by hand, for the tests that need a saved one.
  classEdits.clear();
  classEdits.set(2, { name: 'Play Group', gradeOrder: 0, categoryKey: '' });
  return {
    calls,
    settings: { getAll: async () => SETTINGS },
    classes: { list: classList, update: classUpdate },
    students: { list: async () => STUDENTS },
    grades: {
      listSubjects: async ({ studentClass } = {}) => subjectsForClass(studentClass),
      listClasses: async () => ({ classes: CLASSES }),
      getResults: async ({ studentClass }) => {
        const want = String(studentClass || '').toLowerCase();
        const rows = buildResults().filter(
          (r) => !want || r.report.studentClass.toLowerCase() === want,
        );
        return {
          results: rows,
          subjects: subjectsForClass(studentClass),
          settings: SETTINGS,
          examName: 'Term 1 - 2026',
          summary: {
            students: rows.length,
            passed: rows.filter((r) => r.report.isPass).length,
            failed: rows.filter((r) => !r.report.isPass).length,
            averagePercentage: rows.length
              ? Math.round(rows.reduce((a, r) => a + r.report.percentage, 0) / rows.length)
              : 0,
            passMark: 50,
          },
        };
      },
      saveMarks: async ({ rows }) => ({ saved: rows.length, cleared: 0 }),
      saveRemark: async () => ({}),
      getReport: async () => ({ report: buildResults()[0].report, settings: SETTINGS }),
      addSubject: async (payload) => {
        calls.addSubject.push(payload);
        return { id: 99 };
      },
      updateSubject: async (payload) => {
        calls.updateSubject.push(payload);
        return {};
      },
      removeSubject: async () => ({}),
    },
    data: {
      exportMarks: async () => ({ ok: true, rows: 0 }),
      importMarksDialog: async () => null,
      exportClassesSubjects: async () => ({ ok: true }),
      importStudentsDialog: async () => null,
    },
    subjects: { update: async () => ({}), remove: async () => ({}) },
    on: () => () => {},
  };
}

/* ------------------------------------------------------------------ */
/* Assertions                                                          */
/* ------------------------------------------------------------------ */

window.__run = async function run() {
  const out = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const record = (name, cond, detail) =>
    out.push({ name, ok: !!cond, detail: String(detail === undefined ? '' : detail) });
  const eq = (name, a, b) =>
    record(
      name,
      JSON.stringify(a) === JSON.stringify(b),
      'expected ' + JSON.stringify(b) + ' but got ' + JSON.stringify(a),
    );

  window.api = makeApi();
  // The views are top-level `const`s in classic scripts, so they live in the
  // global lexical scope and are deliberately not properties of window.
  // eval() is how this harness reaches that binding, exactly as nav.js does
  // when it calls Grades.load().
  const G = eval('Grades');
  const N = eval('Nav');
  record('Grades object reachable from the global scope', !!G, typeof G);
  if (!G) return out;
  N.init();

  /* ---------------- landing state: no class chosen ---------------- */
  G.classId = null;
  G.studentClass = '';
  G.examName = '';
  G.tab = 'marks';
  await G.load({ classId: null, categoryKey: '' });
  await sleep(200);

  const view = document.querySelector('#view-grades');
  const $ = (s) => view.querySelector(s);
  const $$ = (s) => Array.from(view.querySelectorAll(s));

  record('toolbar rendered', !!$('.gr-toolbar'));
  record('the class dropdown is gone', !$('#classSelect'));
  record('no class chips remain', $$('.class-pill').length === 0);
  record('exam input in the shared toolbar', !!$('#examName'));
  record('no tabs are offered before a class is chosen', $$('.tab').length === 0);
  record('the landing state asks for a class',
    /Choose a class in the sidebar/i.test($('#gradesBody').textContent),
    $('#gradesBody').textContent.trim());

  /* ---------------- the sidebar tree ---------------- */
  await N.buildTree();
  await sleep(100);
  const tree = document.querySelector('#navGradesChildren');
  record('tree rendered', !!tree && tree.children.length > 0);
  eq('categories in school-year order',
    Array.from(tree.querySelectorAll('.nav-cat-label')).map((s) => s.textContent),
    ['Pre-Primary', 'Primary']);
  eq('classes sit under their category',
    Array.from(tree.querySelectorAll('.nav-cat-group')).map((g) => ({
      cat: g.dataset.cat,
      classes: Array.from(g.querySelectorAll('.nav-class')).map((c) => c.textContent.trim()),
    })),
    [
      { cat: 'preprimary', classes: ['Play Group'] },
      { cat: 'primary', classes: ['Class 1'] },
    ]);
  eq('each category reports how many classes it holds',
    Array.from(tree.querySelectorAll('.nav-cat-count')).map((s) => s.textContent), ['1', '1']);
  record('no class is active before one is chosen',
    tree.querySelectorAll('.nav-class.active').length === 0);

  /* ---------------- clicking the sidebar header ---------------- */
  // Regression: the header used to call toggleTree() and return, so a first click
  // opened an empty tree and never switched the view. This drives the real click
  // from a cold start rather than calling openGrades() directly.
  N.grades.classId = null;
  N.grades.categoryKey = '';
  N.toggleTree(false);
  N.go('dashboard');
  await sleep(200);
  document.querySelector('#navGradesChildren').innerHTML = ''; // prove it rebuilds
  document.querySelector('#navGrades .nav-item').click();
  await sleep(400);
  record('clicking the header switches to the grades view',
    document.querySelector('#view-grades').classList.contains('active'));
  record('the header marks itself active',
    document.querySelector('#navGrades .nav-item').classList.contains('active'));
  record('the header expands the tree',
    document.querySelector('#navGrades').classList.contains('open'));
  record('the tree is populated on the first click',
    document.querySelector('#navGradesChildren').children.length > 0,
    document.querySelector('#navGradesChildren').innerHTML.slice(0, 120));
  record('the landing page still shows after a fresh header click',
    /Choose a class in the sidebar/i.test(document.querySelector('#gradesBody').textContent));

  /* ---------------- picking a class scopes the view ---------------- */
  // Play Group first, because it is the single-student class and the smallest
  // thing to assert against.
  const playGroup = document.querySelector('#navGradesChildren .nav-class[data-class-id="2"]');
  record('the class row is clickable after the rebuild', !!playGroup);
  if (playGroup) playGroup.click();
  await sleep(300);
  eq('router recorded the selected class', N.grades.classId, 2);
  eq('the view adopted the selected class', G.studentClass, 'Play Group');
  eq('only that class is active in the tree',
    Array.from(tree.querySelectorAll('.nav-class.active')).map((c) => c.dataset.classId),
    ['2']);
  const prePrimary = tree.querySelector('.nav-cat-group[data-cat="preprimary"]');
  record('the selected category opened itself',
    !!prePrimary && prePrimary.classList.contains('open'));

  /* ---------------- breadcrumbs ---------------- */
  const crumbs = document.querySelector('#crumbs');
  eq('breadcrumb reads section > category > class',
    Array.from(crumbs.querySelectorAll('.crumb, .crumb-static, .crumb-current'))
      .map((c) => c.textContent.trim()),
    ['Grades & Reports', 'Pre-Primary', 'Play Group']);
  record('the trail is visible', crumbs.classList.contains('active'));
  record('the last crumb is marked as the current page',
    !!crumbs.querySelector('[aria-current="page"]'));

  // The grid must be scoped: Play Group holds one student.
  const playTable = $('table.marks');
  eq('the grid holds only the selected class',
    playTable ? playTable.querySelectorAll('tbody tr').length : 0, 1);
  eq('tabs appear once a class is chosen', $$('.tab').length, 3);
  eq('exactly one exam input on the page', $$('#examName').length, 1);
  eq('the toolbar names the active class', $('.gr-scope-name').textContent.trim(), 'Play Group');
  eq('the toolbar names the active category', $('.gr-scope-cat').textContent.trim(), 'Pre-Primary');

  /* ---------------- switching class from the tree ---------------- */
  tree.querySelector('.nav-class[data-class-id="1"]').click();
  await sleep(300);
  eq('the view followed the tree to the new class', G.studentClass, 'Class 1');
  eq('breadcrumb follows the class', N.grades.classId, 1);
  eq('breadcrumb category follows the class',
    document.querySelector('#crumbs .crumb-current').textContent.trim(), 'Class 1');
  eq('breadcrumb shows the new category',
    document.querySelector('#crumbs .crumb-static').textContent.trim(), 'Primary');
  eq('breadcrumb trail is still three levels',
    Array.from(document.querySelectorAll('#crumbs .crumb, #crumbs .crumb-static, #crumbs .crumb-current'))
      .map((c) => c.textContent.trim()),
    ['Grades & Reports', 'Primary', 'Class 1']);

  const marksTable = $('table.marks');
  record('marks grid rendered', !!marksTable);
  const bodyRows = marksTable ? marksTable.querySelectorAll('tbody tr').length : 0;
  // "Class 1" is stored as "class 1" on the students, so this also re-proves
  // the case-insensitive match through the new id-based selection.
  eq('mixed-case class shows both students', bodyRows, 2);
  record('no Load grid button', !$('#loadMarks'));

  // Class 1 is assigned English + Maths only, so the grid must be two columns
  // wide even though the catalogue holds three subjects.
  const class1Subjects = subjectsForClass('Class 1');
  eq('grid uses only the subjects assigned to the selected class',
    class1Subjects.map((s) => s.name), ['English', 'Maths']);
  const inputs = marksTable ? marksTable.querySelectorAll('input.mark-input').length : 0;
  eq('one input per student per assigned subject', inputs, 2 * class1Subjects.length);
  record('a subject from another class is absent from the grid',
    !$('#gradesBody').textContent.includes('Science'),
    $('#gradesBody').textContent);

  /* ---------------- typing updates the row total ---------------- */
  const firstInput = marksTable && marksTable.querySelector('input.mark-input');
  if (firstInput) {
    // Clear the whole row first: the grid is seeded with saved marks, so a
    // single edit would not be the only contribution to the total.
    const row = firstInput.closest('tr');
    const before = row.querySelector('td.col-total').textContent.trim();
    Array.from(row.querySelectorAll('input.mark-input')).forEach((i) => {
      i.value = '0';
      i.dispatchEvent(new Event('input', { bubbles: true }));
    });
    firstInput.value = '42';
    firstInput.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(60);
    const after = row.querySelector('td.col-total').textContent.trim();
    record('row total recalculates on typing', /^42\b/.test(after),
      'before=' + before + ' after=' + after);
  } else {
    record('mark input found for typing test', false);
  }

  /* ---------------- exam switching ---------------- */
  const examInput = $('#examName');
  examInput.value = 'Midterm 2026';
  examInput.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(250);
  eq('exam committed on change', G.examName, 'Midterm 2026');
  const options = $$('#examNames option').map((o) => o.value);
  record('committed exam added to suggestions', options.includes('Midterm 2026'), options.join('|'));

  return window.__runResults(G, N, out, sleep, record, eq);
};

/* ------------------------------------------------------------------ */
/* Part two: results, filters and subjects                             */
/*                                                                     */
/* Split out so neither half becomes an unreadable block. Nav is        */
/* passed in alongside Grades because part three drives the sidebar     */
/* tree, which lives on the router rather than in the view.             */
/* ------------------------------------------------------------------ */

window.__runResults = async function runResults(G, N, out, sleep, record, eq) {
  /* ---------------- results tab ---------------- */
  // Part one left the view scoped to Class 1 (two students, English + Maths).
  G.tab = 'results';
  await G.renderTab();
  await sleep(250);

  record('results host present', !!document.querySelector('#resultsHost'));
  const resTable = document.querySelector('table.res-table');
  record('result sheet rendered', !!resTable);
  eq('the result sheet holds only the selected class',
    resTable ? resTable.querySelectorAll('tbody tr').length : 0, 2);

  const headers = resTable
    ? Array.from(resTable.querySelectorAll('thead th')).map((t) => t.textContent.trim())
    : [];
  record('subject columns present',
    headers.includes('English') && headers.includes('Maths'), headers.join('|'));
  record('a subject of another class has no column',
    !headers.includes('Science'), headers.join('|'));
  record('failing subject highlighted in the row',
    !!document.querySelector('table.res-table td.res-fail'));
  eq('no duplicate results host', document.querySelectorAll('#resultsHost').length, 1);

  eq('four KPI tiles rendered',
    Array.from(document.querySelectorAll('.stat .value')).length, 4);

  /* ---------------- search ---------------- */
  const search = document.querySelector('#resSearch');
  search.value = 'bob';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(150);
  eq('search narrows to one student',
    document.querySelectorAll('table.res-table tbody tr').length, 1);
  record('repaint did not re-bind the row action handler',
    document.querySelector('#resultsHost').dataset.actionsBound === '1');

  search.value = 'zzzz-no-match';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(150);
  eq('no-match search shows a single empty row',
    document.querySelectorAll('table.res-table tbody tr').length, 1);
  record('empty state rendered', !!document.querySelector('table.res-table .empty-row'));

  search.value = '';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(150);
  eq('clearing the search restores every row',
    document.querySelectorAll('table.res-table tbody tr').length, 2);

  /* ---------------- needs attention ---------------- */
  const toggle = document.querySelector('#resFailing');
  toggle.checked = true;
  toggle.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(150);
  eq('needs-attention shows only failures',
    document.querySelectorAll('table.res-table tbody tr').length, 1);
  const onlyName = document.querySelector('table.res-table tbody tr td strong');
  record('the single failure is Bob', onlyName && onlyName.textContent === 'Bob Ali Jr',
    onlyName && onlyName.textContent);

  toggle.checked = false;
  toggle.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(150);
  eq('untoggling restores every row',
    document.querySelectorAll('table.res-table tbody tr').length, 2);

  /* ---------------- switching class re-scopes the results ---------------- */
  await G.load({ classId: 2, categoryKey: 'preprimary' });
  G.tab = 'results';
  await G.renderTab();
  await sleep(250);
  eq('results narrowed to the newly selected class',
    document.querySelectorAll('table.res-table tbody tr').length, 1);
  const playHeaders = Array.from(
    document.querySelectorAll('table.res-table thead th'),
  ).map((t) => t.textContent.trim());
  // Play Group has Maths + Science; English is Class 1 only and must be gone.
  record('result columns follow the class',
    playHeaders.includes('Science') && !playHeaders.includes('English'),
    playHeaders.join('|'));
  record('the card header names the class it is showing',
    /Play Group/.test(document.querySelector('#gradesBody .card-head .sub').textContent),
    document.querySelector('#gradesBody .card-head .sub').textContent);

  /* ---------------- subjects tab, scoped to Play Group ---------------- */
  G.tab = 'subjects';
  await G.renderTab();
  await sleep(250);
  record('subjects form rendered', !!document.querySelector('#addSubject'));
  const importBtn = document.querySelector('#impSubjects');
  record('import button named for what it does',
    !!importBtn && /student/i.test(importBtn.textContent),
    importBtn && importBtn.textContent.trim());
  eq('only the selected class\'s subjects are listed',
    document.querySelectorAll('#gradesBody .card table tbody tr').length, 2);

  /* ---------------- the add form no longer picks classes ------------ */
  const subjectsPanel = document.querySelector('#gradesBody');
  record('the add form has no class picker',
    !document.querySelector('#subClassCheckboxes'));
  record('the add form has no class checkboxes at all',
    subjectsPanel.querySelectorAll('input[data-class-id]').length === 0);
  record('the form states the class the subject will join',
    /Play Group/.test(document.querySelector('.gr-assign-readonly').textContent),
    document.querySelector('.gr-assign-readonly').textContent.trim());
  record('the form names the category too',
    /Pre-Primary/.test(document.querySelector('.gr-assign-readonly').textContent));

  /* ---------------- classes are grouped by category ---------------- */
  // The picker survives only in the edit modal, where widening an assignment is
  // a deliberate extra action. Driving it through a detached node exercises the
  // grouping, the Select All toggles and the partial state without depending on
  // which subject happens to be open.
  const addFormPanel = document.createElement('div');
  addFormPanel.innerHTML = G.classPickerHtml(CLASSES, [2]);
  G.bindClassPicker(addFormPanel);
  eq('every class sits in a titled group',
    Array.from(addFormPanel.querySelectorAll('.class-group-label'))
      .map((s) => s.textContent), ['Pre-Primary', 'Primary']);
  eq('the groups are ordered school-year, not by insertion',
    Array.from(addFormPanel.querySelectorAll('.class-group'))
      .map((g) => g.dataset.group), ['preprimary', 'primary']);
  eq('each group has its own Select All',
    addFormPanel.querySelectorAll('input[data-cat-all]').length, 2);
  record('a Select All is never mistaken for a class',
    Array.from(addFormPanel.querySelectorAll('input[data-cat-all]'))
      .every((i) => !i.hasAttribute('data-class-id')));

  /* ---------------- Select All toggles a whole group ---------------- */
  const primaryAll = addFormPanel.querySelector('[data-cat-all="primary"]');
  eq('an untouched group reports 0 of its size',
    addFormPanel.querySelector('.class-group[data-group="primary"] .class-group-count').textContent,
    '0/1');
  primaryAll.checked = true;
  primaryAll.dispatchEvent(new Event('change', { bubbles: true }));
  eq('Select All ticks every class in the group',
    Array.from(addFormPanel.querySelectorAll('[data-group="primary"] input[data-class-id]'))
      .filter((i) => i.checked).map((i) => i.value), ['1']);
  eq('the group counter follows the selection',
    addFormPanel.querySelector('.class-group[data-group="primary"] .class-group-count').textContent,
    '1/1');
  record('a whole group reports itself fully selected',
    primaryAll.checked && !primaryAll.indeterminate);

  // Un-ticking the only member empties the band, so the header must clear.
  const primaryClass = addFormPanel.querySelector('[data-group="primary"] input[data-class-id="1"]');
  primaryClass.checked = false;
  primaryClass.dispatchEvent(new Event('change', { bubbles: true }));
  record('an emptied group header clears',
    !primaryAll.checked && !primaryAll.indeterminate);

  /* ------------- Select All on a band with several classes ----------- */
  // The loaded fixtures put one class in each band, so a genuine "some but not
  // all" state is unreachable through them. A standalone picker over a wider
  // roster exercises the band boundaries and the partial state directly.
  const wide = document.createElement('div');
  wide.innerHTML = G.classPickerHtml(
    [
      { id: 11, name: 'Class 1', gradeOrder: 1 },
      { id: 12, name: 'Class 2', gradeOrder: 2 },
      { id: 13, name: 'Class 3', gradeOrder: 3 },
      { id: 16, name: 'Class 6', gradeOrder: 6 },
      { id: 14, name: 'Class 9', gradeOrder: 9 },
      { id: 15, name: 'Class 11', gradeOrder: 11 },
    ],
    [],
  );
  G.bindClassPicker(wide);
  eq('a wider roster fills the bands it should',
    Array.from(wide.querySelectorAll('.class-group-label')).map((s) => s.textContent),
    ['Primary', 'Middle', 'High School', 'Intermediate']);
  const widePrimary = wide.querySelector('[data-cat-all="primary"]');
  widePrimary.checked = true;
  widePrimary.dispatchEvent(new Event('change', { bubbles: true }));
  eq('Select All covers every class in a three-class band',
    Array.from(wide.querySelectorAll('[data-group="primary"] input[data-class-id]'))
      .filter((i) => i.checked).length, 3);

  // Un-ticking one member has to demote the header to indeterminate, or the
  // form would claim a band is selected when it is only partly selected.
  const wideOne = wide.querySelector('[data-group="primary"] input[data-class-id="12"]');
  wideOne.checked = false;
  wideOne.dispatchEvent(new Event('change', { bubbles: true }));
  record('a partly selected band shows the indeterminate state',
    !widePrimary.checked && widePrimary.indeterminate);
  eq('the counter reports the partial selection',
    wide.querySelector('.class-group[data-group="primary"] .class-group-count').textContent, '2/3');
  widePrimary.checked = true;
  widePrimary.dispatchEvent(new Event('change', { bubbles: true }));
  eq('Select All restores the whole band',
    Array.from(wide.querySelectorAll('[data-group="primary"] input[data-class-id]'))
      .filter((i) => i.checked).length, 3);
  const pills = (rowIndex) => {
    const row = document.querySelectorAll('#gradesBody .card table tbody tr')[rowIndex];
    if (!row) return null;
    return Array.from(row.querySelectorAll('td.class-cell .cat-pill'))
      .map((p) => p.textContent.trim());
  };
  // The subjects tab is scoped to Play Group, so English (Class 1 only) is not on
  // screen: rows 0 and 1 are Maths and Science.
  // Every class of a band is assigned, so the band is named outright rather
  // than spelled out as a list of class names.
  eq('the multi-class subject still shows both of its categories', pills(0),
    ['Pre-Primary (1)', 'Primary (1)']);
  eq('a subject of one category shows that category', pills(1), ['Pre-Primary (1)']);
  record('the overflow counter dropdown is gone',
    document.querySelectorAll('#gradesBody .class-dropdown-trigger').length === 0);

  // A partly covered band must not be labelled as the whole band, and a class
  // the roster no longer knows about must still be shown rather than dropped.
  const savedRoster = G.availableClassesWithIds;
  G.availableClassesWithIds = [
    { id: 21, name: 'Class 1', gradeOrder: 1 },
    { id: 22, name: 'Class 2', gradeOrder: 2 },
    { id: 23, name: 'Class 9', gradeOrder: 9 },
  ];
  record('a partly covered category names the classes it covers',
    G.subjectCategoryPills({ classNames: ['Class 1', 'Class 9', 'Retired Class'] })
      === '<span class="cat-pill partial" title="Class 1">Primary <span class="cat-pill-note">(Class 1)</span></span>'
        + '<span class="cat-pill" title="Class 9">High School <span class="cat-pill-note">(1)</span></span>'
        + '<span class="cat-pill other" title="Retired Class">Retired Class</span>',
    G.subjectCategoryPills({ classNames: ['Class 1', 'Class 9', 'Retired Class'] }));
  record('a whole band is labelled without listing its classes',
    G.subjectCategoryPills({ classNames: ['Class 1', 'Class 2'] })
      === '<span class="cat-pill" title="Class 1, Class 2">Primary <span class="cat-pill-note">(2)</span></span>',
    G.subjectCategoryPills({ classNames: ['Class 1', 'Class 2'] }));
  G.availableClassesWithIds = savedRoster;

  /* ---------------- the sidebar selection reaches the subjects table -- */
  G.tab = 'subjects';
  await G.load({ classId: 2, categoryKey: 'preprimary' });
  await sleep(250);
  const playRows = Array.from(
    document.querySelectorAll('#gradesBody .card table tbody tr td strong'),
  ).map((s) => s.textContent);
  eq('subjects filtered to the selected class', playRows, ['Maths', 'Science']);
  record('a subject of another class is filtered out',
    !playRows.includes('English'), playRows.join('|'));
  // The multi-class subject still shows both of its categories while filtered.
  const playPills = Array.from(
    document.querySelectorAll('#gradesBody .card table tbody tr'),
  ).map((tr) => Array.from(tr.querySelectorAll('td.class-cell .cat-pill'))
    .map((p) => p.textContent.trim()));
  eq('multi-class subject still lists both categories when filtered', playPills[0],
    ['Pre-Primary (1)', 'Primary (1)']);

  /* ---------------- add form files under the selected class ----------- */
  document.querySelector('#subName').value = 'Geography';
  document.querySelector('#subMax').value = '60';
  document.querySelector('#addSubject').click();
  await sleep(250);
  const sent = window.api.calls.addSubject[window.api.calls.addSubject.length - 1];
  eq('the payload carries the sidebar class id', sent && sent.classIds, [2]);
  record('the payload carries no wildcard flag',
    sent && sent.studentClass === undefined, JSON.stringify(sent));

  // Switching the class in the sidebar moves where the next subject lands,
  // without the form ever offering a class control of its own.
  await G.load({ classId: 1, categoryKey: 'primary' });
  await sleep(250);
  document.querySelector('#subName').value = 'History';
  document.querySelector('#addSubject').click();
  await sleep(250);
  const sentOther = window.api.calls.addSubject[window.api.calls.addSubject.length - 1];
  eq('a new class files its subject under that class', sentOther && sentOther.classIds, [1]);

  // With no class selected there is nothing to file against, so the save is
  // refused rather than creating an unassigned subject.
  await G.load({ classId: null, categoryKey: '' });
  await sleep(200);
  const beforeNoClass = window.api.calls.addSubject.length;
  record('no subject form is offered without a class',
    !document.querySelector('#addSubject'));
  eq('nothing is submitted without a class',
    window.api.calls.addSubject.length, beforeNoClass);
  await G.load({ classId: 2, categoryKey: 'preprimary' });
  await sleep(250);

  /* ---------------- edit modal pre-populates the assignment ---------- */
  // Maths is assigned to both classes, so the modal must tick both and offer
  // no "all classes" escape hatch.
  const mathsRow = Array.from(
    document.querySelectorAll('#gradesBody .card table tbody tr'),
  ).find((tr) => tr.querySelector('td strong').textContent === 'Maths');
  record('multi-class row found', !!mathsRow);
  if (mathsRow) {
    mathsRow.querySelector('button[data-act="edit"]').click();
    await sleep(200);
    const modal = document.querySelector('#modalBackdrop');
    record('edit modal opened', !!modal && !modal.hidden);
    record('no global checkbox in the edit modal',
      !document.querySelector('#e_subGlobal') && modal.querySelectorAll('#e_subClass input[data-global]').length === 0);
    const ticked = Array.from(modal.querySelectorAll('#e_subClass input[data-class-id]'))
      .filter((i) => i.checked).map((i) => i.value);
    eq('both assigned classes are pre-ticked', ticked, ['2', '1']);
    record('the modal groups the classes the same way',
      Array.from(modal.querySelectorAll('#e_subClass .class-group-label'))
        .map((s) => s.textContent).join('|') === 'Pre-Primary|Primary',
      Array.from(modal.querySelectorAll('#e_subClass .class-group-label'))
        .map((s) => s.textContent).join('|'));
    record('the modal offers Select All per category',
      modal.querySelectorAll('#e_subClass input[data-cat-all]').length === 2);
    record('the modal names every class',
      Array.from(modal.querySelectorAll('#e_subClass .class-group-body span'))
        .map((s) => s.textContent).join('|') === 'Play Group|Class 1',
      Array.from(modal.querySelectorAll('#e_subClass .class-group-body span'))
        .map((s) => s.textContent).join('|'));

    // Select All has to work in the modal too, not just in the add form.
    const modalPrimaryAll = modal.querySelector('#e_subClass [data-cat-all="primary"]');
    modalPrimaryAll.checked = true;
    modalPrimaryAll.dispatchEvent(new Event('change', { bubbles: true }));
    eq('Select All in the modal ticks the whole group',
      Array.from(modal.querySelectorAll('#e_subClass [data-group="primary"] input[data-class-id]'))
        .filter((i) => i.checked).map((i) => i.value), ['1']);

    // Un-ticking one class narrows the subject; un-ticking all is refused.
    modal.querySelector('#e_subClass input[data-class-id="1"]').checked = false;
    modal.querySelectorAll('.modal-foot .btn.primary')[0].click();
    await sleep(250);
    const saved = window.api.calls.updateSubject[window.api.calls.updateSubject.length - 1];
    eq('narrowing sends only the ticked class', saved && saved.classIds, [2]);

    // Re-open and clear every box: nothing must be submitted.
    const stillMaths = G.subjects.find((s) => s.name === 'Maths');
    await G.editSubject(stillMaths);
    await sleep(200);
    const modal2 = document.querySelector('#modalBackdrop');
    Array.from(modal2.querySelectorAll('#e_subClass input[data-class-id]'))
      .forEach((i) => { i.checked = false; });
    const beforeEdit = window.api.calls.updateSubject.length;
    modal2.querySelectorAll('.modal-foot .btn.primary')[0].click();
    await sleep(250);
    eq('a subject with no class is not saved',
      window.api.calls.updateSubject.length, beforeEdit);
    modal2.querySelectorAll('.modal-foot .btn.ghost')[0].click();
    await sleep(150);
  }

  /* ---------------- the edit modal fits the picker ---------------- */
  // Regression: the dialog was `modal narrow` (460px) while holding the full
  // grouped class picker. Narrow forced one category per row, the dialog grew
  // past the viewport and Save ended up below the fold, so the layout now uses
  // the standard modal width and lays the groups out in a grid.
  {
    const live = G.subjects.find((s) => s.name === 'Maths');
    await G.editSubject(live);
    await sleep(200);
    const m = document.querySelector('#modalBackdrop');
    const dialog = m.querySelector('.modal');
    const w = dialog.getBoundingClientRect().width;
    const picker = m.querySelector('#e_subClass').getBoundingClientRect();
    record('the edit dialog is not the narrow variant',
      !dialog.classList.contains('narrow'), dialog.className);
    record('the edit dialog is wide enough for grouped classes',
      w > 600, 'rendered ' + Math.round(w) + 'px');
    record('the picker is not squeezed to a sliver',
      picker.width > 400, 'picker ' + Math.round(picker.width) + 'px');
    // The Save button has to be reachable without scrolling the dialog.
    const foot = m.querySelector('.modal-foot').getBoundingClientRect();
    record('Save stays inside the viewport',
      foot.bottom <= window.innerHeight && foot.top >= 0,
      'foot bottom ' + Math.round(foot.bottom) + ' of ' + window.innerHeight);

    // Categories are derived from gradeOrder, never picked by hand, so the
    // dialog has to say so instead of leaving a teacher hunting for a
    // category control that does not exist.
    const note = m.querySelector('.auto-cat-hint');
    record('the dialog explains that categories are automatic', !!note);
    record('the explanation mentions automatic assignment',
      !!note && /automatic/i.test(note.textContent),
      note && note.textContent.trim());
    record('the dialog offers no category control to choose',
      m.querySelector('#e_subClass select, #e_subClass [data-cat-select]') === null);

    // Categories still follow gradeOrder in the picker itself.
    eq('the modal still groups by derived category',
      Array.from(m.querySelectorAll('#e_subClass .class-group')).map((g) => g.dataset.group),
      ['preprimary', 'primary']);
    m.querySelectorAll('.modal-foot .btn.ghost')[0].click();
    await sleep(150);
  }

  /* ---------------- one click, one notification ---------------- */
  // Regression: renderSubjects rewrites #gradesBody but the element survives,
  // so the delegated `button[data-act]` binding was re-installed on every
  // render. After N renders a single click reached the handler N times and
  // every message it produced appeared N times. The toast count is asserted
  // directly, because that is what the user actually sees.
  {
    const toastCount = () => document.querySelectorAll('#toastStack .toast').length;
    const clearToasts = () => { document.querySelector('#toastStack').innerHTML = ''; };
    const findRow = (name) => Array.from(
      document.querySelectorAll('#gradesBody .card table tbody tr'),
    ).find((tr) => tr.querySelector('td strong').textContent === name);

    // Re-render repeatedly, exactly as add / edit / delete / import do.
    for (let i = 0; i < 4; i++) {
      await G.renderSubjects(document.querySelector('#gradesBody'));
      await sleep(30);
    }

    // The duplication is in the handler's reach, not in the toast: four
    // renders mean four live listeners, so one click runs editSubject four
    // times. Counted directly, because that is the root cause.
    let edits = 0;
    let deletes = 0;
    const realEdit = G.editSubject;
    const realRemove = G.removeSubject;
    G.editSubject = async (s) => { edits += 1; return realEdit.call(G, s); };
    G.removeSubject = async (s) => { deletes += 1; return realRemove.call(G, s); };
    findRow('Maths').querySelector('button[data-act="edit"]').click();
    await sleep(250);
    eq('one Edit click runs the handler once, however many renders preceded it', edits, 1);
    document.querySelector('#modalBackdrop .modal-foot .btn.ghost').click();
    await sleep(150);
    findRow('Maths').querySelector('button[data-act="delete"]').click();
    await sleep(250);
    eq('one Delete click runs the handler once', deletes, 1);
    // Cancel the confirmation rather than removing anything.
    const confirmBtn = document.querySelectorAll('#modalBackdrop .modal-foot .btn');
    if (confirmBtn.length) confirmBtn[confirmBtn.length - 1].click();
    await sleep(200);
    G.editSubject = realEdit;
    G.removeSubject = realRemove;

    // A rejected save (the main process refuses a duplicate assignment) must be
    // reported once and must not escape as an unhandled rejection - app.js
    // would turn that into a second, misleading "Unexpected error" toast.
    let unhandled = 0;
    const onUnhandled = () => { unhandled += 1; };
    window.addEventListener('unhandledrejection', onUnhandled);
    const realUpdate = window.api.grades.updateSubject;
    window.api.grades.updateSubject = async (payload) => {
      window.api.calls.updateSubject.push(payload);
      throw new Error('Subject "' + payload.name + '" is already configured for Class 1');
    };

    clearToasts();
    findRow('Maths').querySelector('button[data-act="edit"]').click();
    await sleep(200);
    const m = document.querySelector('#modalBackdrop');
    Array.from(m.querySelectorAll('#e_subClass input[data-class-id]'))
      .forEach((i) => { i.checked = true; });
    m.querySelectorAll('.modal-foot .btn.primary')[0].click();
    await sleep(300);

    eq('a rejected save raises exactly one notification', toastCount(), 1);
    eq('a rejected save does not escape as an unhandled rejection', unhandled, 0);
    record('the rejected save explains itself',
      /already configured/i.test(document.querySelector('#toastStack').textContent),
      document.querySelector('#toastStack').textContent.trim());
    record('the dialog stays open so the ticks can be corrected',
      !document.querySelector('#modalBackdrop').hidden);
    document.querySelector('#modalBackdrop .modal-foot .btn.ghost').click();
    await sleep(150);

    // A refused duplicate add is the same story on the other form.
    window.api.grades.addSubject = async (payload) => {
      window.api.calls.addSubject.push(payload);
      throw new Error('Subject "' + payload.name + '" is already configured for Play Group');
    };
    clearToasts();
    unhandled = 0;
    document.querySelector('#subName').value = 'Science';
    document.querySelector('#addSubject').click();
    await sleep(300);
    eq('a rejected add raises exactly one notification', toastCount(), 1);
    eq('a rejected add does not escape as an unhandled rejection', unhandled, 0);

    // And a client-side refusal (nothing ticked) is still reported once.
    clearToasts();
    findRow('Maths').querySelector('button[data-act="edit"]').click();
    await sleep(200);
    const m3 = document.querySelector('#modalBackdrop');
    Array.from(m3.querySelectorAll('#e_subClass input[data-class-id]'))
      .forEach((i) => { i.checked = false; });
    m3.querySelectorAll('.modal-foot .btn.primary')[0].click();
    await sleep(250);
    eq('an empty selection raises exactly one notification', toastCount(), 1);
    document.querySelector('#modalBackdrop .modal-foot .btn.ghost').click();
    await sleep(150);

    window.removeEventListener('unhandledrejection', onUnhandled);
    window.api.grades.updateSubject = realUpdate;
  }

  /* ---------------- tabs too: #view-grades outlives its own markup ------ */
  // The same trap one level up. load() rewrites #view-grades but the element
  // survives, so bindTabs ran again on every visit and every later tab click
  // rendered the tab once per visit.
  {
    let renders = 0;
    const realRenderTab = G.renderTab;
    G.renderTab = async function () { renders += 1; return realRenderTab.call(G); };
    for (let i = 0; i < 3; i++) {
      await G.load({ classId: 2, categoryKey: 'preprimary' });
      await sleep(120);
    }
    renders = 0;
    const marksTab = Array.from(document.querySelectorAll('#view-grades .tab'))
      .find((t) => t.dataset.tab === 'results');
    record('a results tab is present to click', !!marksTab);
    if (marksTab) {
      marksTab.click();
      await sleep(400);
      eq('one tab click renders the tab once, however many visits preceded it', renders, 1);
    }
    G.renderTab = realRenderTab;
  }

  /* ---------------- assigning a category to a class ---------------- */
  // The sidebar tree is the only reachable route to a class's settings (there is
  // no Classes & Subjects view wired into the router), so a category assigned
  // there is what a user actually has to work with.
  {
    const clearToasts = () => { document.querySelector('#toastStack').innerHTML = ''; };
    const groupsIn = () => Array.from(
      document.querySelectorAll('#navGradesChildren .nav-cat-group'),
    ).map((g) => ({
      cat: g.dataset.cat,
      classes: Array.from(g.querySelectorAll('.nav-class')).map((c) => c.textContent.trim()),
    }));
    const editBtnFor = (id) => document.querySelector(
      '#navGradesChildren .nav-class-edit[data-class-id="' + id + '"]',
    );
    const editBtn = editBtnFor(2);
    record('every class in the tree offers an edit control', !!editBtn);
    record('there is one edit control per class',
      document.querySelectorAll('#navGradesChildren .nav-class-edit').length
        === document.querySelectorAll('#navGradesChildren .nav-class').length);

    // The class starts unassigned, so it must still be banded by its sort order.
    await N.buildTree();
    await sleep(60);
    eq('an unassigned class keeps its derived band', groupsIn(), [
      { cat: 'preprimary', classes: ['Play Group'] },
      { cat: 'primary', classes: ['Class 1'] },
    ]);

    // Re-queried after the rebuild: buildTree replaces the markup, so the node
    // captured before it is detached and clicking it would reach no listener.
    editBtnFor(2).click();
    await sleep(120);
    const select = document.querySelector('#nc_category');
    record('the class editor offers a category control', !!select);
    record('an unassigned class opens on Automatic',
      !!select && select.value === '', select && select.value);
    // "Automatic" plus the five real bands, and nothing else.
    eq('the category control offers Automatic and every band',
      select ? Array.from(select.options).map((o) => o.value) : null,
      ['', 'preprimary', 'primary', 'middle', 'high', 'intermediate']);

    // Assign Play Group to Primary by hand. Its sort order (0) still says
    // Pre-Primary, so this can only be the manual column winning.
    select.value = 'primary';
    const order = document.querySelector('#nc_order');
    record('the editor shows the current sort order', !!order && order.value === '0',
      order && order.value);
    const before = window.api.calls.classUpdate.length;
    document.querySelector('.modal-foot .btn.primary').click();
    await sleep(300);

    eq('saving sends exactly one update', window.api.calls.classUpdate.length, before + 1);
    const sent = window.api.calls.classUpdate[window.api.calls.classUpdate.length - 1];
    eq('the assigned category is sent to the main process', sent.categoryKey, 'primary');
    eq('the save is scoped to the class that was edited', Number(sent.id), 2);

    // The tree rebuilt, and the class followed its new band.
    eq('the class moved to the band it was assigned to', groupsIn(), [
      { cat: 'primary', classes: ['Play Group', 'Class 1'] },
    ]);
    record('reopening the editor shows the assignment',
      (() => {
        document.querySelector(
          '#navGradesChildren .nav-class-edit[data-class-id="2"]',
        ).click();
        return document.querySelector('#nc_category').value === 'primary';
      })());
    document.querySelector('.modal-foot .btn.ghost').click();
    await sleep(120);

    // Handing the class back to Automatic must restore the derived grouping.
    document.querySelector('#navGradesChildren .nav-class-edit[data-class-id="2"]').click();
    await sleep(120);
    document.querySelector('#nc_category').value = '';
    document.querySelector('.modal-foot .btn.primary').click();
    await sleep(300);
    eq('clearing the assignment restores the derived band', groupsIn(), [
      { cat: 'preprimary', classes: ['Play Group'] },
      { cat: 'primary', classes: ['Class 1'] },
    ]);

    // A rejected save must not close the dialog, or the user loses the edit.
    clearToasts();
    const realUpdate = window.api.classes.update;
    window.api.classes.update = async () => { throw new Error('disk is full'); };
    document.querySelector('#navGradesChildren .nav-class-edit[data-class-id="2"]').click();
    await sleep(120);
    document.querySelector('.modal-foot .btn.primary').click();
    await sleep(250);
    eq('a rejected class save raises one notification',
      document.querySelectorAll('#toastStack .toast').length, 1);
    record('a rejected class save keeps the dialog open',
      !!document.querySelector('#nc_category'));
    record('a rejected class save explains itself',
      /disk is full/.test(document.querySelector('#toastStack').textContent),
      document.querySelector('#toastStack').textContent);
    document.querySelector('.modal-foot .btn.ghost').click();
    await sleep(120);
    window.api.classes.update = realUpdate;

    // A hand-assigned band must not change the class it sorts under, and the
    // empty string must never be mistaken for a band named "".
    const cat = eval('classCategory');
    eq('a manual assignment wins over the sort order',
      cat({ id: 2, name: 'Play Group', gradeOrder: 0, categoryKey: 'intermediate' }).key,
      'intermediate');
    eq('an unknown key falls back to the derived band rather than vanishing',
      cat({ id: 2, name: 'Play Group', gradeOrder: 0, categoryKey: 'nonsense' }).key,
      'preprimary');
    eq('a class with no key is still derived',
      cat({ id: 2, name: 'Play Group', gradeOrder: 0, categoryKey: '' }).key,
      'preprimary');
    eq('a missing column derives just as before',
      cat({ id: 1, name: 'Class 1', gradeOrder: 1 }).key, 'primary');
  }

  /* ---------------- escaping ---------------- */
  // buildTree() re-reads the roster from the API, so the hostile name has to be
  // injected there rather than into Nav.treeClasses.
  const hostile = '<img src=x onerror=alert(1)>';
  const realList = window.api.classes.list;
  window.api.classes.list = async () => [{ id: 9, name: hostile, gradeOrder: 1 }];

  const savedClasses = G.classes;
  G.classes = [{ id: 9, name: hostile, gradeOrder: 1 }];
  G.classId = 9;
  G.studentClass = hostile; // otherwise the shell renders the landing page
  const shell = G.renderShell();
  record('class names are escaped in the toolbar', !shell.includes('<img src=x'));
  record('the escaped name is still readable in the toolbar',
    shell.includes(esc(hostile)));

  await N.buildTree();
  const treeEl = document.querySelector('#navGradesChildren');
  // innerHTML serialises an attribute value with only &, " and nbsp escaped, so
  // the raw text inside title="..." still reads as markup even though it is
  // parsed back as text. Asserting on the parsed DOM is the honest check.
  record('no element was created from the class name',
    treeEl.querySelectorAll('img').length === 0);
  record('the escaped name is still shown as text',
    treeEl.querySelector('.nav-class').textContent.trim() === hostile,
    treeEl.querySelector('.nav-class').textContent.trim());

  window.api.classes.list = realList;
  G.classes = savedClasses;
  G.classId = null;
  G.studentClass = '';

  return out;
};