/**
 * Grades & Reports view.
 *
 * One-row toolbar layout:
 *   Class  – dropdown populated from the classes table; changing it
 *            auto-filters everything below to that class.
 *   Exam   – one shared exam name for Marks Entry and Results.
 *   Tabs   – Marks Entry | Results & Report Cards | Subjects
 *
 * Class matching is case-insensitive throughout, because the main process
 * normalises class names inconsistently (COLLATE NOCASE) and a class can be
 * stored with different casing than the one we last selected.
 *
 * All grading maths lives in the main process (see src/main/grading.js);
 * this file only collects input and renders what comes back.
 */
'use strict';

const Grades = {
  tab: 'marks',
  examName: '',
  examOptions: [], // recently used exam names, offered as datalist suggestions
  studentClass: '',
  // Delegations installed by this view, keyed by the container they hang off.
  // renderSubjects rewrites #gradesBody but the element itself survives every
  // render, so a plain addEventListener there would be installed once per
  // render: after N renders a single click reached the handler N times, and
  // every message the handler raised - a validation warning, a confirmation -
  // was repeated N times. delegateOnce keeps exactly one live binding.
  delegations: new WeakMap(),
  // The class the sidebar tree selected. Distinct from studentClass, which is
  // the display name handed to the main process: every query filters by name
  // because that is how students are stored, while the tree navigates by id.
  classId: null,
  categoryKey: '',
  subjects: [],
  students: [],
  marks: new Map(), // key: `${studentId}|${subject}` -> number
  savedKeys: new Set(), // same keys, but only for cells with a row in the DB
  results: null,
  resultRows: [], // rows currently shown in the result sheet (filtered view)
  busy: false,
  classes: [],

  /**
   * Renders the view for whichever class the sidebar selected.
   *
   * @param {object} [params]  Nav.params: { categoryKey, classId }
   */
  async load(params = {}) {
    const view = $('#view-grades');
    if (!view) return;
    view.innerHTML = '<div class="empty"><span class="spinner"></span> Loading grades...</div>';

    if (!this.examName) {
      this.examName = await this.suggestExam();
      this.rememberExam(this.examName);
    }

    this.classes = await window.api.classes.list();

    // The sidebar tree is rebuilt from the same class list, so it stays in step
    // with classes created by a student import while the user is in this view.
    if (typeof Nav !== 'undefined' && Nav.buildTree) Nav.buildTree();

    // undefined means "the caller did not say", so the current selection is
    // kept; an explicit null is the breadcrumb asking to go back to the landing
    // page. Collapsing the two would make it impossible to leave a class.
    const classId =
      params.classId === undefined ? this.classId : Number(params.classId);
    this.classId = classId || null;
    this.categoryKey = params.categoryKey || '';

    const selected = this.classes.find((c) => Number(c.id) === Number(this.classId));
    // With no class chosen the view lands on a "pick a class" prompt rather than
    // silently grading every class in the school, because the tabs are now
    // written assuming exactly one class is in scope.
    this.studentClass = selected ? selected.name : '';

    view.innerHTML = this.renderShell();
    this.bindTabs(view);
    this.bindToolbar(view);
    await this.renderTab();
    this.bindKeys();
  },

  /**
   * Shortcuts for this view.
   *
   * Grades is three tabs in one view, so the set on offer depends on which tab
   * is showing: `s` saves marks on Marks Entry but is meaningless on Results,
   * and `d` deletes a subject only on the Subjects tab. `register()` replaces
   * the whole map for the view, so building it fresh on every load() is what
   * keeps the list honest after a tab change - there is no earlier set left
   * behind to accept a keystroke that no longer means anything.
   */
  bindKeys() {
    const common = {
      m: { keys: '1', label: 'Marks Entry tab', run: () => this.showTab('marks') },
      r: { keys: '2', label: 'Results &amp; Report Cards tab', run: () => this.showTab('results') },
      u: { keys: '3', label: 'Subjects tab', run: () => this.showTab('subjects') },
    };

    // The three tabs do not share a toolbar: Marks Entry and Subjects export
    // to Excel, Results prints. Each tab therefore gets its own I/X shortcuts
    // rather than one pair that silently does nothing on two of the three.
    const perTab = {
      marks: {
        ...common,
        s: {
          keys: 'S',
          label: 'Save the marks grid',
          run: () => Keys.click('#saveMarks') || this.saveGrid(),
        },
        i: { keys: 'I', label: 'Import marks from Excel', run: () => $('#impMarks').click() },
        x: { keys: 'X', label: 'Export the marks to Excel', run: () => $('#expMarks').click() },
      },
      results: {
        ...common,
        c: { keys: 'C', label: 'Print the report card', run: () => Keys.act('card') },
        k: { keys: 'K', label: 'Add or edit a remark', run: () => Keys.act('remark') },
        p: { keys: 'P', label: 'Print every report card', run: () => $('#printAllCards').click() },
        f: { keys: 'F', label: 'Show only students needing attention', run: () => this.toggleFailing() },
      },
      subjects: {
        ...common,
        n: { keys: 'N', label: 'Add a subject', run: () => $('#addSubject').click() },
        e: { keys: 'E', label: 'Edit the highlighted subject', run: () => Keys.act('edit') },
        d: { keys: 'Del', label: 'Delete the highlighted subject', run: () => Keys.act('delete') },
        i: { keys: 'I', label: 'Import students into this class', run: () => $('#impSubjects').click() },
        x: { keys: 'X', label: 'Export the subjects to Excel', run: () => $('#expSubjects').click() },
      },
    };

    Keys.register('grades', perTab[this.tab] || common);
  },

  /** Flips the "Needs attention" filter from the keyboard. */
  toggleFailing() {
    const box = $('#resFailing');
    if (!box) return;
    box.checked = !box.checked;
    this.applyResultFilters();
  },

  /** Switches tabs the way the tab strip does, including the active styling. */
  async showTab(name) {
    if (this.tab === name) return;
    const view = $('#view-grades');
    this.tab = name;
    $$('.tab', view).forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    await this.renderTab();
    this.bindKeys();
  },

  /** Export button for whichever tab is showing, if it has one. */
  exportCurrent() {
    if (this.tab === 'marks') return Keys.click('#expMarks');
    if (this.tab === 'subjects') return Keys.click('#expSubjects');
    return Keys.click('#printAllCards');
  },

  bindTabs(view) {
    // #view-grades persists across load() calls (only its innerHTML changes),
    // so this must stay a single binding.
    delegateOnce(this.delegations, view, 'click', '.tab', async (e, btn) => {
      this.tab = btn.dataset.tab;
      $$('.tab', view).forEach((t) => t.classList.toggle('active', t === btn));
      await this.renderTab();
    });
  },

  async renderTab() {
    const body = $('#gradesBody');
    if (!body) return;
    // Every tab below is written against one class. Without a selection the
    // shell renders a prompt instead, so reaching here means the class was
    // cleared mid-render (a data:changed refresh, say) and we must not query
    // the database with an empty class name, which would return every class.
    if (!this.studentClass) return this.renderNoClassInto(body);
    if (this.tab === 'subjects') return this.renderSubjects(body);
    if (this.tab === 'results') return this.renderResults(body);
    return this.renderMarks(body);
  },

  /** Swaps the body for the "choose a class" prompt. */
  renderNoClassInto(body) {
    body.innerHTML = `
      <div class="card">
        <div class="empty">
          <div class="big">&#9733;</div>
          Choose a class in the sidebar to continue.
        </div>
      </div>`;
  },

  /**
   * Builds the view shell: the exam control and the tab strip.
   *
   * The exam used to live inside each tab behind its own "Load" button, so
   * typing a name and forgetting to press the button silently graded the
   * previous exam. It is now a single shared control bound to both tabs.
   *
   * The CLASS dropdown is gone: the sidebar tree owns class selection now, so
   * repeating it here would give the user two controls for one setting and a
   * silent source of disagreement about which class is open.
   */
  renderShell() {
    if (!this.studentClass) return this.renderNoClass();

    const examOptions = (this.examOptions || []).includes(this.examName)
      ? this.examOptions
      : [this.examName, ...(this.examOptions || [])].filter(Boolean);

    const category = this.categoryLabel();

    return `
      <div class="gr-toolbar no-print">
        <div class="gr-toolbar-row gr-toolbar-tabs">
          <div class="gr-field gr-scope" aria-label="Active class">
            <span class="gr-scope-label">Class</span>
            <span class="gr-scope-cat">${esc(category)}</span>
            <strong class="gr-scope-name">${esc(this.studentClass)}</strong>
          </div>
          <div class="gr-field gr-field-grow">
            <label for="examName">Exam</label>
            <div class="gr-exam">
              <input id="examName" list="examNames" value="${esc(this.examName)}" maxlength="60"
                     placeholder="e.g. Term 1 - 2026" aria-label="Exam name" />
              <datalist id="examNames">
                ${examOptions.map((n) => `<option value="${esc(n)}"></option>`).join('')}
              </datalist>
            </div>
          </div>
          <div class="gr-field gr-field-tabs">
            <label>&nbsp;</label>
            <div class="tabs">
              <button class="tab ${this.tab === 'marks' ? 'active' : ''}" data-tab="marks">Marks Entry</button>
              <button class="tab ${this.tab === 'results' ? 'active' : ''}" data-tab="results">Results</button>
              <button class="tab ${this.tab === 'subjects' ? 'active' : ''}" data-tab="subjects">Subjects</button>
            </div>
          </div>
        </div>
      </div>
      <div id="gradesBody"></div>`;
  },

  /**
   * The landing state when no class is selected in the sidebar.
   *
   * Rendering the tabs against an empty class produced an empty grade grid with
   * no explanation, which reads as "no marks yet" rather than "pick a class".
   */
  renderNoClass() {
    return `
      <div class="gr-toolbar no-print">
        <div class="gr-toolbar-row gr-toolbar-tabs">
          <div class="gr-field gr-field-grow">
            <label for="examName">Exam</label>
            <div class="gr-exam">
              <input id="examName" list="examNames" value="${esc(this.examName)}" maxlength="60"
                     placeholder="e.g. Term 1 - 2026" aria-label="Exam name" />
              <datalist id="examNames">
                ${(this.examOptions || []).map((n) => `<option value="${esc(n)}"></option>`).join('')}
              </datalist>
            </div>
          </div>
        </div>
      </div>
      <div id="gradesBody">
        <div class="card">
          <div class="empty">
            <div class="big">&#9733;</div>
            ${
              this.classes.length
                ? 'Choose a class in the sidebar to enter marks, view results and configure its subjects.'
                : 'No classes yet. Register a student, or add a class from Classes &amp; Subjects, to get started.'
            }
          </div>
        </div>
      </div>`;
  },

  /** The category the active class sits under, for the scope readout. */
  categoryLabel() {
    if (!this.classId) return '';
    const cls = this.classes.find((c) => Number(c.id) === Number(this.classId));
    if (!cls) return '';
    const { label } = classCategory(cls);
    return label;
  },

  /** Binds the shared toolbar control: the exam name. */
  bindToolbar(view) {
    // The exam is shared by the Marks and Results tabs, so it is committed on
    // Enter or blur and both tabs reload from the same source of truth.
    const exam = $('#examName', view);
    if (exam) {
      const commit = async () => {
        const next = (exam.value || '').trim();
        if (!next || next === this.examName) return;
        this.examName = next;
        this.rememberExam(next);
        // Refresh the suggestions in place: renderTab only rewrites
        // #gradesBody, so the shell's datalist must be updated by hand.
        const list = $('#examNames', view);
        if (list) {
          list.innerHTML = (this.examOptions || [])
            .map((n) => `<option value="${esc(n)}"></option>`)
            .join('');
        }
        await this.renderTab();
      };
      exam.addEventListener('change', commit);
      exam.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          exam.blur();
        }
      });
    }
  },

  /** Offers an exam name again next time in the datalist suggestions. */
  rememberExam(name) {
    this.examOptions = [name, ...(this.examOptions || []).filter((n) => n !== name)].slice(0, 12);
  },

  /** A stable exam label for the current term, e.g. "Term 1 - 2026". */
  async suggestExam() {
    const settings = await window.api.settings.getAll();
    State.settings = settings;
    const year = new Date().getFullYear();
    const startMonth = new Date().getMonth(); // 0 = January
    const term = startMonth < 4 ? 1 : startMonth < 8 ? 2 : 3;
    return 'Term ' + term + ' - ' + year;
  },

  /* ------------------------------------------------------------------ */
  /* TAB: MARKS ENTRY                                                    */
  /* ------------------------------------------------------------------ */

  async renderMarks(body) {
    body.innerHTML = `
      <div class="card">
        <div class="card-head">
          <h3>Marks Entry</h3>
          <span class="sub">${esc(this.examName)} &middot; ${esc(this.studentClass)}</span>
        </div>
        <div class="card-body">
          <div class="search-row">
            <button class="btn primary" id="saveMarks">Save marks</button>
            <button class="btn" id="expMarks" title="Export marks to Excel">&#128229; Export</button>
            <button class="btn" id="impMarks" title="Import marks from Excel">&#128202; Import</button>
            <span class="gr-hint">Enter marks and press <kbd>Enter</kbd> to move to the next student.</span>
          </div>
          <div id="marksHost" class="mt"></div>
        </div>
      </div>`;

    $('#saveMarks', body).addEventListener('click', (e) =>
      withBusy(e.currentTarget, () => this.saveGrid()),
    );
    $('#expMarks', body).addEventListener('click', async () => {
      try {
        const result = await window.api.data.exportMarks({ examName: this.examName, studentClass: this.studentClass });
        if (result.ok) notify.ok('Exported', result.rows + ' mark(s) exported to Excel.');
      } catch (err) {
        notify.error('Export failed', err.message);
      }
    });
    $('#impMarks', body).addEventListener('click', async () => {
      try {
        const result = await window.api.data.importMarksDialog(this.examName);
        if (result) {
          notify.ok('Import complete', result.inserted + ' added, ' + result.updated + ' updated, ' + result.skipped + ' skipped.');
          await this.loadGrid();
        }
      } catch (err) {
        notify.error('Import failed', err.message);
      }
    });

    await this.loadGrid();
  },

  /** Pulls subjects, the class roster and any previously saved marks. */
  async loadGrid() {
    // Every reload replaces #marksHost with a fresh element, so the listeners
    // below die with the old node. Rebinding on every load() would pile up
    // handlers that all hold the previous render's `marks` cache.
    const host = $('#marksHost');
    if (!host) return;
    host.innerHTML = '<div class="empty"><span class="spinner"></span> Preparing grid...</div>';

    this.subjects = await window.api.grades.listSubjects({ studentClass: this.studentClass });
    this.students = await window.api.students.list('');

    // Match the class case-insensitively. Class names are compared with
    // COLLATE NOCASE everywhere else in the app and mixed-case names are a
    // supported state, so an exact === here would silently hide students from
    // the grid whenever the stored casing differs from the pill.
    const wanted = (this.studentClass || '').toLowerCase();
    const rows = wanted
      ? this.students.filter((s) => String(s.studentClass || '').toLowerCase() === wanted)
      : this.students;

    if (!this.subjects.length) {
      host.innerHTML =
        '<div class="empty"><div class="big">&#128218;</div>No subjects configured yet. Add subjects on the Subjects tab first.</div>';
      return;
    }
    if (!rows.length) {
      host.innerHTML =
        '<div class="empty"><div class="big">&#128101;</div>No students to grade. Add students first.</div>';
      return;
    }

    // Seed the local cache with what is already stored for this exam.
    this.marks = new Map();
    this.savedKeys = new Set();
    const { results } = await window.api.grades.getResults({
      examName: this.examName,
      studentClass: this.studentClass,
    });
    for (const entry of results) {
      for (const s of entry.report.subjects) {
        const key = entry.student.id + '|' + s.subject;
        this.marks.set(key, Number(s.marksObtained) || 0);
        if (s.hasMark) this.savedKeys.add(key);
      }
    }

    this.paintGrid(host, rows);
  },

  /** Paints (and repaints) the spreadsheet, preserving typed values. */
  /**
   * The mark inputs in reading order, captured once per paint.
   *
   * Enter/Tab navigation used to re-query every cell in the grid on each key
   * press, and each keystroke in a cell re-read every cell in its own row, so
   * the cost of typing one mark grew with the size of the class. Both now walk
   * an array built when the grid is painted.
   */
  markInputs: [],

  paintGrid(host, rows) {
    const head =
      `<thead><tr>` +
      `<th class="col-roll">Roll</th>` +
      `<th class="col-student">Student</th>` +
      `<th class="col-class">Class</th>` +
      this.subjects
        .map(
          (s) =>
            `<th><div class="subject-head"><span class="subj-name">${esc(s.name)}</span><span class="maxm">max ${esc(s.maxMarks)}</span></div></th>`,
        )
        .join('') +
      `<th class="col-total"><div class="subject-head"><span class="subj-name">Total</span><span class="maxm">of ${num(this.subjects.reduce((a, s) => a + Number(s.maxMarks), 0), 0)}</span></div></th>` +
      `</tr></thead>`;

    const bodyRows = rows
      .map((st) => {
        const cells = this.subjects
          .map((sub) => {
            const value = this.marks.get(st.id + '|' + sub.name);
            return `<td><input type="number" min="0" max="${esc(sub.maxMarks)}" step="0.01"
              data-student="${st.id}" data-subject="${esc(sub.name)}" data-max="${esc(sub.maxMarks)}"
              value="${value === undefined ? '' : esc(value)}" class="mark-input" /></td>`;
          })
          .join('');
        return (
          `<tr data-id="${st.id}">
            <td class="col-roll mono">${esc(st.rollNo)}</td>
            <td class="col-student">${esc(st.name)}</td>
            <td class="col-class">${esc(st.studentClass)}</td>${cells}
            <td class="col-total num total" data-total="${st.id}">-</td>
          </tr>`
        );
      })
      .join('');

    host.innerHTML =
      `<div class="marks-grid"><table class="table marks">${head}<tbody>${bodyRows}</tbody></table></div>` +
      `<div class="grade-legend">Grades: <span class="grade-pill Aplus">A+ 90%+</span> <span class="grade-pill A">A 80%+</span>` +
      ` <span class="grade-pill B">B 70%+</span> <span class="grade-pill C">C 60%+</span>` +
      ` <span class="grade-pill D">D 50%+</span> <span class="grade-pill Fail">Fail &lt; ` +
      esc(State.settings.passMarkPercentage || 50) + `%</span></div>`;

    // The grid only changes shape when it is repainted, so the inputs are read
    // once here rather than re-queried on every key press.
    const inputs = (this.markInputs = $$('input.mark-input', host));

    // Keyboard navigation: Enter/Tab moves to next cell, Shift+Tab moves back
    // #marksHost is rebuilt wholesale by loadGrid(), so these are fresh nodes
    // and a plain binding is correct here.
    on(host, 'keydown', 'input.mark-input', (e, input) => {
      const idx = inputs.indexOf(input);
      if (e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey)) {
        e.preventDefault();
        if (idx < inputs.length - 1) inputs[idx + 1].focus();
      } else if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault();
        if (idx > 0) inputs[idx - 1].focus();
      }
    });

    // Live typing: cache the value, flag over-max entries, update the row total.
    on(host, 'input', 'input.mark-input', (e, input) => {
      const raw = input.value.trim();
      const key = input.dataset.student + '|' + input.dataset.subject;
      if (raw === '') this.marks.delete(key);
      else this.marks.set(key, Number(raw));
      const max = Number(input.dataset.max);
      input.classList.toggle('bad', raw !== '' && Number(raw) > max);
      this.updateTotal(host, input.dataset.student);
    });

    $$('input.mark-input', host).forEach((i) => this.updateTotal(host, i.dataset.student));
  },

  /**
   * Recomputes one student's total from that row's inputs.
   *
   * Only the student's own cells are read. The previous version filtered every
   * mark input in the grid by data-student, which meant a single keystroke
   * walked the whole class - 40 students x 8 subjects is 320 inputs scanned to
   * total eight of them.
   */
  updateTotal(host, studentId) {
    const cell = host.querySelector('[data-total="' + studentId + '"]');
    if (!cell) return;
    let sum = 0;
    let filled = 0;
    const row = cell.closest('tr');
    (row ? $$('input[data-subject]', row) : [])
      .filter((i) => i.value.trim() !== '')
      .forEach((i) => {
        sum += Number(i.value) || 0;
        filled += 1;
      });
    if (filled === 0) {
      cell.textContent = '-';
      return;
    }
    const max = this.subjects.reduce((a, s) => a + (Number(s.maxMarks) || 0), 0);
    const decimals = Number.isInteger(sum) ? 0 : 2;
    cell.textContent = num(sum, decimals) + ' / ' + num(max, 0);
  },

  async saveGrid() {
    const host = $('#marksHost');
    if (!host) return;
    const rows = [];
    let invalid = 0;
    let cleared = 0;

    $$('input[data-subject]', host).forEach((input) => {
      const raw = input.value.trim();
      const key = input.dataset.student + '|' + input.dataset.subject;
      const max = Number(input.dataset.max);

      if (raw === '') {
        // A blank cell that previously held a saved mark must delete it,
        // otherwise the old value silently survives in the database.
        if (this.savedKeys && this.savedKeys.has(key)) {
          rows.push({
            studentId: Number(input.dataset.student),
            subject: input.dataset.subject,
            marksObtained: null,
            clear: true,
          });
          cleared += 1;
        }
        return; // untouched, never-stored cells are left alone
      }

      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0 || value > max) {
        invalid += 1;
        input.classList.add('bad');
        return;
      }
      rows.push({
        studentId: Number(input.dataset.student),
        subject: input.dataset.subject,
        marksObtained: value,
        maxMarks: max,
      });
    });

    if (invalid) {
      notify.warn('Invalid marks', invalid + ' entr(y/ies) exceed the subject maximum. Fix them and try again.');
      return;
    }
    if (!rows.length) {
      notify.warn('Nothing to save', 'Enter at least one mark before saving.');
      return;
    }

    const result = await window.api.grades.saveMarks({ examName: this.examName, rows });
    // Remember exactly which cells now hold a stored mark.
    rows.forEach((row) => {
      const key = row.studentId + '|' + row.subject;
      if (row.clear) this.savedKeys.delete(key);
      else this.savedKeys.add(key);
    });
    const parts = [];
    if (result.saved) parts.push(result.saved + ' mark(s) saved');
    if (result.cleared) parts.push(result.cleared + ' mark(s) cleared');
    notify.ok('Marks saved', parts.join(', ') + ' for ' + this.examName + '.');
    // The grid on screen is already correct, so the broadcast for this same
    // write must not reload the roster and rebuild every cell behind it.
    selfRendered();
  },

  /* ------------------------------------------------------------------ */
  /* TAB: SUBJECTS                                                       */
  /* ------------------------------------------------------------------ */

  /**
   * The class id every subject change in this view is scoped to.
   *
   * The sidebar tree selects by id and the view keeps that id in `this.classId`,
   * so this is a lookup rather than the case-insensitive name scan the old class
   * dropdown needed. An empty result means no class is selected, which the
   * callers treat as "refuse the save" rather than "save with no class".
   *
   * @returns {number[]}  the active class id, or [] when none is selected
   */
  activeClassIds() {
    const id = Number(this.classId);
    return Number.isFinite(id) && id > 0 ? [id] : [];
  },

  /**
   * The class names to show in the CLASS column.
   *
   * A subject assigned to a single class shows just that name; one assigned to
   * several shows every name it belongs to. The list is never replaced by a
   * placeholder, because there is no "applies to every class" state any more.
   */
  subjectClassNames(s) {
    if (Array.isArray(s.classNames) && s.classNames.length) return s.classNames;
    // class_subjects rows only ever belong to the class being viewed.
    if (s.source === 'classSubjects' && this.studentClass) return [this.studentClass];
    return String(s.className || '')
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean);
  },

  /**
   * The category pills for one subject row's CLASS cell.
   *
   * The dropdown this replaced could only say "Class 1 +9": it counted the
   * overflow and hid which classes it was hiding. Mapping the assignment up to
   * its parent categories answers the question a teacher actually has - "which
   * level does this subject cover?" - and a pill stays readable in a table cell.
   *
   * A category is shown when at least one of its classes is assigned (Primary
   * for Classes 1-5, say). A fully covered band is labelled with the category
   * alone; a partly covered one keeps the class names it does cover, so a
   * half-ticked group is never mislabelled as whole.
   *
   * @param {object} s  a subjects row
   * @returns {string}  the HTML for the cell
   */
  subjectCategoryPills(s) {
    const names = this.subjectClassNames(s);
    if (!names.length) return '<span class="muted">No classes</span>';

    // Names are matched case-insensitively: the main process compares class
    // names with COLLATE NOCASE, so a subject can legitimately report back a
    // different casing than the classes table holds.
    const wanted = new Set(names.map((n) => String(n).trim().toLowerCase()));
    const known = (this.availableClassesWithIds || []).map((c) =>
      String(c.name || '').trim().toLowerCase(),
    );

    const pills = [];
    for (const group of groupClassesByCategory(this.availableClassesWithIds)) {
      const inGroup = group.classes.filter((c) =>
        wanted.has(String(c.name || '').trim().toLowerCase()),
      );
      if (!inGroup.length) continue;

      const covered = inGroup.map((c) => c.name);
      const whole = inGroup.length === group.classes.length;
      pills.push(
        `<span class="cat-pill${whole ? '' : ' partial'}" title="${esc(covered.join(', '))}">` +
          `${esc(group.label)} <span class="cat-pill-note">(${esc(
            whole ? String(covered.length) : covered.join(', '),
          )})</span></span>`,
      );
    }

    // A class that is on the roster but not in the loaded class list still has
    // to be visible, otherwise collapsing to categories would silently drop a
    // class the subject really is taught in.
    for (const n of names) {
      if (known.includes(String(n).trim().toLowerCase())) continue;
      pills.push(`<span class="cat-pill other" title="${esc(n)}">${esc(n)}</span>`);
    }

    return pills.join('');
  },

  async renderSubjects(body) {
    if (!body) return; // Guard against race condition: data:changed refresh may have replaced the view
    // Subjects are scoped to the sidebar selection: a subject appears here only
    // when the active class is one of the classes it is assigned to.
    this.subjects = await window.api.grades.listSubjects({ studentClass: this.studentClass });
    // The edit modal can still widen an assignment, so the picker needs the full
    // class list - but the add form no longer offers it (see below).
    this.availableClassesWithIds = await window.api.classes.list();

    body.innerHTML = `
      <div class="split">
        <div class="card">
          <div class="card-head"><h3>Add subject</h3></div>
          <div class="card-body">
            <div class="form-grid">
              <div class="field full">
                <label for="subName">Subject name</label>
                <input id="subName" maxlength="60" placeholder="e.g. Mathematics" />
              </div>
              <div class="field">
                <label for="subMax">Maximum marks</label>
                <input id="subMax" type="number" min="1" max="1000" value="100" />
              </div>
              <div class="field full">
                <label>Class</label>
                <!-- No class picker: the view is already scoped to one class, so
                     the new subject is assigned to it automatically. Choosing
                     again here was a second control for the same setting and let
                     the subject land in a class the teacher was not looking at. -->
                <div class="gr-assign-readonly">
                  <span class="gr-scope-cat">${esc(this.categoryLabel())}</span>
                  <strong>${esc(this.studentClass)}</strong>
                </div>
                <span class="hint">This subject is assigned to ${esc(this.studentClass)}. To teach it elsewhere, open it from that class and use Edit.</span>
              </div>
            </div>
            <div class="btn-row">
              <button class="btn primary" id="addSubject">Add subject</button>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>Configured subjects</h3><span class="sub">${this.subjects.length} subject(s)</span>
            <div class="search-row no-print" style="margin-top:6px">
              <button class="btn sm" id="expSubjects" title="Export subjects to Excel">&#128229; Export</button>
              <button class="btn sm" id="impSubjects" title="Import students from Excel. Classes are created automatically.">&#128202; Import students</button>
            </div>
          </div>
          <div class="card-body tight">
            <div class="table-wrap">
              <table>
                <thead><tr><th>#</th><th>Subject</th><th class="num">Max marks</th><th>Class</th><th class="actions">Actions</th></tr></thead>
                <tbody>${
                  this.subjects.length
                    ? this.subjects.map((s, i) => this.subjectRow(s, i)).join('')
                    : emptyRow(5, 'No subjects yet. Add your first subject on the left.', '&#128218;')
                }</tbody>
              </table>
            </div>
          </div>
        </div>
      </div>`;

    // `#addSubject` is re-created by the innerHTML above, so it carries no
    // listeners forward and a plain binding is safe here.
    $('#addSubject', body).addEventListener('click', (e) =>
      withBusy(e.currentTarget, () => this.addSubject()),
    );

    $('#expSubjects', body).addEventListener('click', async () => {
      try {
        const result = await window.api.data.exportClassesSubjects();
        if (result.ok) notify.ok('Exported', 'Classes, subjects & class subjects exported.');
      } catch (err) {
        notify.error('Export failed', err.message);
      }
    });

    // There is no subject importer: the only Excel importer available reads
    // students, and subjects are derived from the classes those students are in.
    // The button is labelled for what it really does so it cannot be mistaken
    // for a subject import.
    $('#impSubjects', body).addEventListener('click', async () => {
      try {
        const result = await window.api.data.importStudentsDialog();
        if (result) {
          const parts = [
            result.created ? result.created + ' added' : null,
            result.updated ? result.updated + ' updated' : null,
            result.skipped ? result.skipped + ' skipped' : null,
          ].filter(Boolean);
          notify.ok(
            'Students imported',
            parts.length
              ? parts.join(', ') + ' student(s). New classes are created automatically.'
              : 'No rows were imported.',
          );
          // Imported students may have introduced new classes, so re-read them
          // before rebuilding this tab's class list.
          this.classes = await window.api.classes.list();
          await this.renderSubjects($('#gradesBody'));
        }
      } catch (err) {
        notify.error('Import failed', err.message);
      }
    });

    // Delegated on the container, not on the rows: the rows are replaced on
    // every render but `body` is not, so this must stay a single binding.
    delegateOnce(this.delegations, body, 'click', 'button[data-act]', async (e, btn) => {
      const source = btn.dataset.source || 'grades';
      const subjectId = Number(btn.dataset.id);

      // Find the subject - use classSubjectId for class_subjects entries
      const subject = this.subjects.find((s) => {
        if (source === 'classSubjects') {
          return s.classSubjectId === subjectId;
        }
        return s.id === subjectId;
      });

      if (!subject) {
        notify.warn('Subject not found', 'Could not find the subject to edit/delete.');
        return;
      }

      if (btn.dataset.act === 'edit') {
        if (source === 'classSubjects') {
          await this.editClassSubject(subject);
        } else {
          await this.editSubject(subject);
        }
      } else {
        if (source === 'classSubjects') {
          await this.removeClassSubject(subject);
        } else {
          await this.removeSubject(subject);
        }
      }
    });
  },

  /**
   * One row of the configured-subjects table.
   *
   * Both grades subjects and class_subjects can now be edited/deleted.
   * We track the source to call the right API endpoint.
   *
   * The CLASS column shows one pill per category the subject is taught in, so a
   * subject spanning ten classes reads as "Primary, High School" instead of a
   * "Class 1 +9" counter the teacher has to open to interpret.
   */
  subjectRow(s, i) {
    // Subjects from class_subjects have id=null and source='classSubjects'
    const isClassSubject = s.source === 'classSubjects';
    const subjectId = isClassSubject ? s.classSubjectId : s.id;

    const actions = `<button class="btn sm" data-act="edit" data-id="${subjectId}" data-source="${s.source || 'grades'}">Edit</button>
       <button class="btn sm danger" data-act="delete" data-id="${subjectId}" data-source="${s.source || 'grades'}">Delete</button>`;

    return `<tr data-id="${subjectId}" data-source="${s.source || 'grades'}">
                            <td class="muted">${i + 1}</td>
                            <td><strong>${esc(s.name)}</strong></td>
                            <td class="num">${esc(s.maxMarks)}</td>
                            <td class="class-cell">${this.subjectCategoryPills(s)}</td>
                            <td class="actions no-print">${actions}</td>
                          </tr>`;
  },

  /**
   * The grouped class picker used by both the add form and the edit modal.
   *
   * The flat list this replaced grew one row per class and gave the teacher no
   * way to say "all Primary". Each category is now a titled block with a Select
   * All checkbox in its header, and the whole picker scrolls as one box so the
   * form stays a fixed height no matter how many classes the school has.
   *
   * @param {object[]} classes   rows from the classes table
   * @param {number[]} selected   class ids to tick
   * @returns {string}            the HTML for the picker
   */
  classPickerHtml(classes, selected) {
    const ticked = new Set((selected || []).map(Number));
    const groups = groupClassesByCategory(classes);
    if (!groups.length) return '<span class="muted">No classes yet</span>';

    return groups
      .map((group) => {
        const n = group.classes.length;
        const chosen = group.classes.filter((c) => ticked.has(Number(c.id))).length;
        // data-cat-all marks the group toggle, data-class-id marks a member.
        // checkedClassIds only collects the latter, so ticking Select All never
        // leaks a fake class id into the saved payload.
        return `
          <div class="class-group" data-group="${esc(group.key)}">
            <div class="class-group-head">
              <label class="checkbox-item class-group-all" title="Select every ${esc(group.label)} class">
                <input type="checkbox" data-cat-all="${esc(group.key)}"${chosen === n ? ' checked' : ''} />
                <span class="class-group-label">${esc(group.label)}</span>
                <span class="class-group-count">${chosen}/${n}</span>
              </label>
            </div>
            <div class="class-group-body">
              ${group.classes
                .map(
                  (c) => `
                <label class="checkbox-item">
                  <input type="checkbox" value="${c.id}" data-class-id="${c.id}"${
                    ticked.has(Number(c.id)) ? ' checked' : ''
                  } />
                  <span>${esc(c.name)}</span>
                </label>`,
                )
                .join('')}
            </div>
          </div>`;
      })
      .join('');
  },

  /**
   * Wires Select All, and keeps each group header in step with its members.
   *
   * The header is a real checkbox, so it has to report three states: clear,
   * fully ticked, and "some but not all" (indeterminate). A group must never
   * keep claiming to be selected after one of its classes is unticked, which is
   * what would happen if the header only reacted to its own clicks.
   *
   * @param {HTMLElement} root  the picker container
   */
  bindClassPicker(root) {
    if (!root) return;

    /** Repaints every group header from the current state of its members. */
    const sync = () => {
      for (const group of $$('.class-group', root)) {
        const head = $('input[data-cat-all]', group);
        if (!head) continue;
        const boxes = $$('input[data-class-id]', group);
        const chosen = boxes.filter((b) => b.checked).length;
        head.checked = boxes.length > 0 && chosen === boxes.length;
        // Set through the DOM property rather than an attribute so the partial
        // state clears itself as soon as the group becomes whole or empty.
        head.indeterminate = chosen > 0 && chosen < boxes.length;
        const count = $('.class-group-count', group);
        if (count) count.textContent = `${chosen}/${boxes.length}`;
      }
    };

    on(root, 'change', 'input[data-cat-all]', (e, head) => {
      const group = head.closest('.class-group');
      const wanted = head.checked;
      for (const box of $$('input[data-class-id]', group)) box.checked = wanted;
      sync();
    });

    on(root, 'change', 'input[data-class-id]', sync);
    sync();
  },

  async addSubject() {
    const name = ($('#subName').value || '').trim();
    const maxMarks = Number($('#subMax').value);
    // The class comes from the sidebar selection, not from a form control: the
    // view is already scoped to one class, so asking again only created a way
    // to file the subject somewhere the teacher is not looking.
    const selectedClassIds = this.activeClassIds();

    if (!name) {
      notify.warn('Subject required', 'Please enter a subject name.');
      $('#subName').focus();
      return;
    }
    if (!(maxMarks > 0)) {
      notify.warn('Invalid maximum', 'Maximum marks must be greater than zero.');
      $('#subMax').focus();
      return;
    }
    // A subject with no class would never appear in any grid, so it is refused
    // here rather than saved into a state the user cannot see.
    if (!selectedClassIds.length) {
      notify.warn('No class selected', 'Pick a class in the sidebar before adding a subject.');
      return;
    }

    // A rejected write is an expected outcome here - the main process refuses
    // a duplicate subject for a class, and that is feedback about the input,
    // not a crash. Caught locally it is reported once as a warning; left
    // uncaught it escapes to the global handler in app.js and is reported as
    // "Unexpected error" with no indication of what to change.
    try {
      await window.api.grades.addSubject({ name, maxMarks, classIds: selectedClassIds });
    } catch (err) {
      notify.warn('Subject not added', err.message);
      $('#subName').focus();
      return;
    }
    notify.ok('Subject added', name + ' is now part of ' + this.studentClass + '.');
    selfRendered();
    await this.renderSubjects($('#gradesBody'));
  },

  /**
   * Ids of the class checkboxes ticked inside `root`.
   *
   * @param {string} root  selector for the container holding the checkboxes
   * @returns {number[]}    the ticked class ids, de-duplicated
   */
  checkedClassIds(root) {
    const boxes = document.querySelectorAll(root + ' input[data-class-id]');
    const ids = [];
    for (const cb of boxes) {
      if (!cb.checked) continue;
      const cid = Number(cb.value);
      if (cid && !ids.includes(cid)) ids.push(cid);
    }
    return ids;
  },

  async editSubject(subject) {
    // The main process sends the resolved assignment as classIds/classNames; the
    // denormalised subjects.classIds column is only a fallback for a caller that
    // hands us a raw row.
    const assigned = Array.isArray(subject.classIds) && subject.classIds.length
      ? subject.classIds.map(Number)
      : parseSubjectClassIds(subject);

    // Not `modal narrow`: the picker below shows every class in the school
    // grouped by category, and squeezing those groups into 460px wrapped them
    // to one-per-line, so the dialog grew taller than the viewport and pushed
    // Save under the fold. The default modal width lays the groups out side by
    // side and keeps the whole thing on screen.
    openModal((close) =>
      el('div', { class: 'modal' }, [
        el('div', { class: 'modal-head' }, [
          el('h3', { text: 'Edit ' + subject.name }),
        ]),
        el('div', { class: 'modal-body' }, [
          el('div', { class: 'form-grid' }, [
            el('div', { class: 'field full' }, [
              el('label', { for: 'e_subName', text: 'Subject name' }),
              el('input', { id: 'e_subName', value: subject.name, maxlength: '60' }),
            ]),
            el('div', { class: 'field full' }, [
              el('label', { for: 'e_subMax', text: 'Maximum marks' }),
              el('input', { id: 'e_subMax', type: 'number', min: '1', max: '1000', value: subject.maxMarks }),
            ]),
            el('div', { class: 'field full' }, [
              el('label', { for: 'e_subClass', text: 'Classes' }),
              // The edit modal uses the same grouped picker as the add form, so
              // a teacher can widen or narrow an assignment by category here too.
              el('div', {
                class: 'class-checkboxes class-picker',
                id: 'e_subClass',
                html: this.classPickerHtml(this.availableClassesWithIds, assigned),
              }),
              el('span', { class: 'hint', text: 'Tick every class this subject is taught in, or use a category\'s Select All.' }),
              // Categories are derived, never chosen: each class carries a
              // gradeOrder and the band follows from it. Saying so stops
              // teachers looking for a category control that is not there.
              el('span', {
                class: 'hint auto-cat-hint',
                html:
                  'Categories are assigned automatically from each class\'s year, ' +
                  'so there is nothing to choose here - tick the classes and the ' +
                  'Pre-Primary, Primary, Middle, High School and Intermediate ' +
                  'groupings follow on their own.',
              }),
            ]),
          ]),
        ]),
        el('div', { class: 'modal-foot' }, [
          el('button', { class: 'btn ghost', text: 'Cancel', onClick: close }),
          el('button', {
            class: 'btn primary',
            text: 'Save',
            onClick: (e) =>
              withBusy(e.currentTarget, async () => {
                const name = ($('#e_subName').value || '').trim();
                const maxMarks = Number($('#e_subMax').value);
                const selectedClassIds = this.checkedClassIds('#e_subClass');

                if (!name) {
                  notify.warn('Subject required', 'Please enter a subject name.');
                  return;
                }
                if (!(maxMarks > 0)) {
                  notify.warn('Invalid maximum', 'Maximum marks must be greater than zero.');
                  return;
                }
                if (!selectedClassIds.length) {
                  notify.warn('Select a class', 'Tick at least one class for this subject.');
                  return;
                }
                // Widening the assignment can collide with a subject of the same name
                // already set up in one of the newly ticked classes. That is a
                // rejected input, so it is reported here as one warning and the
                // dialog stays open with the ticks intact; without this the
                // rejection escapes to the global handler in app.js and shows
                // up as "Unexpected error" with the modal already gone.
                try {
                  await window.api.grades.updateSubject({
                    id: subject.id,
                    name,
                    maxMarks,
                    classIds: selectedClassIds,
                  });
                } catch (err) {
                  notify.warn('Subject not saved', err.message);
                  return;
                }
                notify.ok('Subject updated', name + ' has been saved.');
                close();
                selfRendered();
                await this.renderSubjects($('#gradesBody'));
              }),
          }),
        ]),
      ]),
    );

    // openModal has appended the node by the time it returns, so the picker is
    // in the document and can be wired like the one in the add form.
    this.bindClassPicker($('#e_subClass'));
  },

  async removeSubject(subject) {
    const ok = await confirmDialog({
      title: 'Delete subject',
      message: 'Delete the subject ' + subject.name + '?',
      detail: 'Every mark recorded for this subject is deleted too.',
      confirmText: 'Delete subject',
      danger: true,
    });
    if (!ok) return;
    await window.api.grades.removeSubject({ id: subject.id });
    notify.ok('Subject deleted', subject.name + ' has been removed.');
    selfRendered();
    await this.renderSubjects($('#gradesBody'));
  },

  async editClassSubject(subject) {
    openModal((close) =>
      el('div', { class: 'modal narrow' }, [
        el('div', { class: 'modal-head' }, [el('h3', { text: 'Edit ' + subject.name })]),
        el('div', { class: 'modal-body' }, [
          el('div', { class: 'form-grid' }, [
            el('div', { class: 'field full' }, [
              el('label', { for: 'cs_subName', text: 'Subject name' }),
              el('input', { id: 'cs_subName', value: subject.name, maxlength: '120' }),
            ]),
            el('div', { class: 'field full' }, [
              el('label', { for: 'cs_subCode', text: 'Subject code (optional)' }),
              el('input', { id: 'cs_subCode', value: subject.code || '', maxlength: '20' }),
            ]),
            el('div', { class: 'field full' }, [
              el('label', { for: 'cs_subStatus', text: 'Status' }),
              el('select', { id: 'cs_subStatus' }, [
                el('option', { value: 'Active', text: 'Active', selected: subject.status !== 'Inactive' }),
                el('option', { value: 'Inactive', text: 'Inactive', selected: subject.status === 'Inactive' }),
              ]),
            ]),
          ]),
        ]),
        el('div', { class: 'modal-foot' }, [
          el('button', { class: 'btn ghost', text: 'Cancel', onClick: close }),
          el('button', {
            class: 'btn primary',
            text: 'Save',
            onClick: (e) =>
              withBusy(e.currentTarget, async () => {
                const name = ($('#cs_subName').value || '').trim();
                const code = ($('#cs_subCode').value || '').trim();
                const status = $('#cs_subStatus')?.value || 'Active';
                if (!name) {
                  notify.warn('Subject required', 'Please enter a subject name.');
                  return;
                }
                await window.api.subjects.update({ id: Number(subject.classSubjectId), name, code, status });
                notify.ok('Subject updated', name + ' has been saved.');
                close();
                selfRendered();
                await this.renderSubjects($('#gradesBody'));
              }),
          }),
        ]),
      ]),
    );
  },

  async removeClassSubject(subject) {
    const ok = await confirmDialog({
      title: 'Delete subject',
      message: 'Delete the subject ' + subject.name + '?',
      confirmText: 'Delete subject',
      danger: true,
    });
    if (!ok) return;
    await window.api.subjects.remove({ id: Number(subject.classSubjectId) });
    notify.ok('Subject deleted', subject.name + ' has been removed.');
    selfRendered();
    await this.renderSubjects($('#gradesBody'));
  },

  /* ------------------------------------------------------------------ */
  /* TAB: RESULTS & REPORT CARDS                                         */
  /* ------------------------------------------------------------------ */

  async renderResults(body) {
    if (!this.students.length) this.students = await window.api.students.list('');

    body.innerHTML = `
      <div class="card">
        <div class="card-head">
          <h3>Results &amp; Report Cards</h3>
          <span class="sub">${esc(this.examName)} &middot; ${esc(this.studentClass)}</span>
        </div>
        <div class="card-body">
          <div class="search-row">
            <button class="btn primary" id="printAllCards">Print all report cards</button>
            <div class="gr-search">
              <input id="resSearch" type="search" placeholder="Search name or roll no..."
                     aria-label="Search results" autocomplete="off" />
            </div>
            <label class="gr-toggle">
              <input type="checkbox" id="resFailing" />
              <span>Needs attention</span>
            </label>
            <span class="gr-hint" id="resCount"></span>
          </div>
        </div>
      </div>
      <div id="resultsHost" class="mt"></div>`;

    const search = $('#resSearch', body);
    const failing = $('#resFailing', body);
    search.addEventListener('input', () => this.applyResultFilters());
    failing.addEventListener('change', () => this.applyResultFilters());

    $('#printAllCards', body).addEventListener('click', (e) =>
      withBusy(e.currentTarget, () => this.printAll()),
    );

    await this.loadResults();
  },

  /**
   * Re-filters the already-loaded result rows in place.
   *
   * Filtering runs over the cached results rather than re-querying, so
   * typing in the search box is instant and never re-sorts the underlying data.
   */
  applyResultFilters() {
    const host = $('#resultsHost');
    if (!host || !this.results) return;

    const term = ($('#resSearch')?.value || '').trim().toLowerCase();
    const onlyFailing = !!$('#resFailing')?.checked;

    this.resultRows = this.results.results.filter((entry) => {
      if (onlyFailing && entry.report.isPass) return false;
      if (!term) return true;
      return (
        String(entry.report.name || '').toLowerCase().includes(term) ||
        String(entry.report.rollNo || '').toLowerCase().includes(term)
      );
    });

    this.paintResults(host, this.results);
  },

  async loadResults() {
    const host = $('#resultsHost');
    if (!host) return;
    host.innerHTML = '<div class="empty"><span class="spinner"></span> Computing results...</div>';

    const data = await window.api.grades.getResults({
      examName: this.examName,
      studentClass: this.studentClass,
    });
    State.settings = data.settings;
    this.results = data;
    // Default to the unfiltered set; applyResultFilters narrows this on demand.
    this.resultRows = data.results;
    this.paintResults(host, data);
  },

  /**
   * Renders the KPI strip and the result sheet.
   *
   * `this.resultRows` holds the rows currently displayed: the full result set,
   * narrowed by applyResultFilters when a search term or the "needs attention"
   * toggle is active. The KPI tiles always describe the whole class, not the
   * filtered slice, so searching for one student cannot silently change the
   * pass rate you are looking at.
   */
  paintResults(host, data) {
    const { results, subjects, summary } = data;
    const passRate = summary.students ? (summary.passed / summary.students) * 100 : 0;

    if (!results.length) {
      host.innerHTML =
        '<div class="card"><div class="empty"><div class="big">&#128203;</div>' +
        'No marks have been recorded for this exam yet. Use the Marks Entry tab first.</div></div>';
      this.resultRows = [];
      return;
    }

    const rows = this.resultRows || results;
    const filtered = rows.length !== results.length;
    const count = $('#resCount');
    if (count) {
      count.textContent = filtered
        ? `Showing ${rows.length} of ${results.length}`
        : `${results.length} student(s)`;
    }

    // One column per subject so a weak area is visible without opening every
    // report card. Capped so a 20-subject class cannot push the totals off the
    // screen; the report card always shows the full breakdown.
    const shown = subjects.slice(0, 8);
    const extraSubjects = subjects.length - shown.length;

    host.innerHTML = `
      <div class="grid cols-4">
        ${kpi('Students', summary.students, 'in this view', 'accent-brand')}
        ${kpi('Passed', summary.passed, passRate.toFixed(1) + '% of the class', 'accent-ok')}
        ${kpi('Failed', summary.failed, 'below the pass mark', summary.failed ? 'accent-danger' : 'accent-ok')}
        ${kpi('Class average', pct(summary.averagePercentage), 'pass mark ' + summary.passMark + '%')}
      </div>

      <div class="card mt">
        <div class="card-head">
          <h3>Result Sheet</h3>
          <span class="sub">${esc(data.examName)} &middot; ${subjects.length} subject(s)</span>
        </div>
        <div class="card-body tight">
          <div class="table-wrap">
            <table class="res-table">
              <thead>
                <tr>
                  <th class="num">Pos</th><th>Roll</th><th>Student</th><th>Class</th>
                  ${shown.map((s) => `<th class="num">${esc(s.name)}</th>`).join('')}
                  ${extraSubjects > 0 ? `<th class="num muted">+${extraSubjects}</th>` : ''}
                  <th class="num">Total</th><th class="num">%</th><th>Grade</th><th>Result</th>
                  <th class="actions">Actions</th>
                </tr>
              </thead>
              <tbody>${
                rows.length
                  ? rows.map((r) => this.resultRow(r, shown)).join('')
                  : emptyRow(9, 'No student matches your search or filter.', '&#128269;')
              }</tbody>
            </table>
          </div>
        </div>
      </div>`;

    // The delegated listener must be attached only once per host element.
    // paintResults runs again on every search keystroke and re-binding would
    // make each row action fire N times. The flag lives on the element because
    // renderResults replaces #resultsHost with a brand new node.
    if (!host.dataset.actionsBound) {
      host.dataset.actionsBound = '1';
      on(host, 'click', 'button[data-act]', async (e, btn) => {
        const rollNo = btn.dataset.roll;
        if (btn.dataset.act === 'card') await this.printCard(rollNo);
        else if (btn.dataset.act === 'remark') await this.editRemark(rollNo);
      });
    }
  },

  resultRow(entry, shownSubjects = []) {
    const r = entry.report;

    // Subject marks come from this student's own report, so each student's
    // curriculum is reflected even when the sheet is showing one class.
    const bySubject = new Map(
      r.subjects.map((s) => [String(s.subject).toLowerCase(), s]),
    );
    const subjectCells = shownSubjects
      .map((s) => {
        const hit = bySubject.get(String(s.name).toLowerCase());
        if (!hit || !hit.hasMark) return '<td class="num muted">-</td>';
        return `<td class="num ${hit.isPass ? '' : 'res-fail'}">${num(hit.marksObtained)}</td>`;
      })
      .join('');

    return `<tr data-roll="${esc(r.rollNo)}">
      <td class="num">${r.position || '-'}</td>
      <td class="mono">${esc(r.rollNo)}</td>
      <td><strong>${esc(r.name)}</strong></td>
      <td>${esc(r.studentClass)}</td>${subjectCells}
      <td class="num">${num(r.totalObtained)} / ${num(r.totalMax, 0)}</td>
      <td class="num">${num(r.percentage)}%</td>
      <td>${gradePill(r.grade)}</td>
      <td>${badge(r.isPass ? 'Pass' : 'Fail', r.isPass ? 'ok' : 'danger')}</td>
      <td class="actions no-print">
        <button class="btn sm" data-act="card" data-roll="${esc(r.rollNo)}">Report card</button>
        <button class="btn sm" data-act="remark" data-roll="${esc(r.rollNo)}">Remark</button>
      </td>
    </tr>`;
  },

  async editRemark(rollNo) {
    const entry = this.results.results.find((r) => r.report.rollNo === rollNo);
    const current = entry ? entry.report.remark : '';

    openModal((close) =>
      el('div', { class: 'modal narrow' }, [
        el('div', { class: 'modal-head' }, [el('h3', { text: 'Remark for ' + rollNo })]),
        el('div', { class: 'modal-body' }, [
          el('div', { class: 'field' }, [
            el('label', { for: 'remarkText', text: 'Remark printed on the report card' }),
            el('textarea', { id: 'remarkText', maxlength: '400' }, current),
            el('span', { class: 'hint', text: 'Leave the auto-generated remark if you are happy with it.' }),
          ]),
        ]),
        el('div', { class: 'modal-foot' }, [
          el('button', { class: 'btn ghost', text: 'Cancel', onClick: close }),
          el('button', {
            class: 'btn primary',
            text: 'Save remark',
            onClick: (e) =>
              withBusy(e.currentTarget, async () => {
                const remark = ($('#remarkText').value || '').trim();
                await window.api.grades.saveRemark({ rollNo, remark });
                notify.ok('Remark saved', 'The report card for ' + rollNo + ' will show this remark.');
                close();
                await this.loadResults();
              }),
          }),
        ]),
      ]),
    );
  },

  /* ------------------------------------------------------------------ */
  /* Report card printing                                                */
  /* ------------------------------------------------------------------ */

  async cardData(rollNo) {
    const data = await window.api.grades.getReport({ rollNo, examName: this.examName });
    State.settings = data.settings;
    return data;
  },

  async printCard(rollNo) {
    const data = await this.cardData(rollNo);
    printDocument(reportCard(data), 'report');
  },

  async previewCard(rollNo) {
    const data = await this.cardData(rollNo);
    const holder = el('div', {});
    renderPreview(holder, reportCard(data));

    openModal((close) =>
      el('div', { class: 'modal' }, [
        el('div', { class: 'modal-head' }, [
          el('h3', { text: 'Report card preview' }),
          el('button', { class: 'btn ghost sm', text: 'Close', onClick: close }),
        ]),
        el('div', { class: 'modal-body' }, [holder]),
        el('div', { class: 'modal-foot' }, [
          el('button', { class: 'btn ghost', text: 'Close', onClick: close }),
          el('button', { class: 'btn primary', text: 'Print', onClick: () => printDocument(reportCard(data), 'report') }),
        ]),
      ]),
    );
  },

  /** Prints one document containing a card per student, one card per sheet. */
  async printAll() {
    if (!this.results || !this.results.results.length) {
      notify.warn('Nothing to print', 'Load a result set with at least one student first.');
      return;
    }
    const docs = [];
    for (const entry of this.results.results) {
      const data = await this.cardData(entry.report.rollNo);
      docs.push(reportCard(data));
    }
    // Cards are joined directly: print.css already starts every card after the
    // first on a fresh sheet. Emitting an extra .page-break separator here as
    // well made the break fire twice and inserted a blank page between cards.
    printDocument(docs.join(''), 'report');
  },
};

/* ====================================================================== */
/* Subject class helpers                                                  */
/* ====================================================================== */

/**
 * The class categories the school is split into, in the order they are shown.
 *
 * A category is not stored for most classes: it is derived from each class's
 * `gradeOrder`, so renaming or re-ordering classes regroups them automatically
 * without a migration or an extra field on the classes table. A school that
 * needs a different grouping can assign any class by hand (see classCategory),
 * which overrides the derived band for that class only.
 *
 * `max` is the highest `gradeOrder` that still belongs to the band; the bands
 * are contiguous and end at Infinity, so every class lands in exactly one of
 * them and is never dropped from the picker.
 */
const CLASS_CATEGORIES = [
  { key: 'preprimary', label: 'Pre-Primary', max: 0 },
  { key: 'primary', label: 'Primary', max: 5 },
  { key: 'middle', label: 'Middle', max: 8 },
  { key: 'high', label: 'High School', max: 10 },
  { key: 'intermediate', label: 'Intermediate', max: Infinity },
];

/**
 * The category a class belongs to.
 *
 * A hand-assigned `categoryKey` on the class always wins. `gradeOrder` is the
 * fallback for every class that has never been assigned by hand, which keeps a
 * school that has not touched this feature grouped exactly as it was before the
 * column existed.
 *
 * Class names are free text ("Play Group", "Kinder", "Senior 11-12"), so the
 * fallback deliberately does not guess from the name - that would misfile a
 * school that names its classes differently. Anything the scale does not place
 * is reported as its own "Other" band so it still gets a group and a Select All
 * in the form.
 *
 * @param {object} cls  a row from the classes table
 * @returns {{key: string, label: string}}  the band this class belongs to
 */
function classCategory(cls) {
  // An unrecognised key (a stale build, a hand-edited database) must not make
  // the class vanish, so fall through to the derived band instead.
  const assigned = String((cls && cls.categoryKey) || '').trim();
  const manual = CLASS_CATEGORIES.find((c) => c.key === assigned);
  if (manual) return manual;

  const order = Number(cls && cls.gradeOrder);
  const band = Number.isFinite(order)
    ? CLASS_CATEGORIES.find((c) => order <= c.max)
    : null;
  return band || { key: 'other', label: 'Other' };
}

/** True when this class's category came from a hand assignment, not the fallback. */
function hasManualCategory(cls) {
  const assigned = String((cls && cls.categoryKey) || '').trim();
  return !!assigned && CLASS_CATEGORIES.some((c) => c.key === assigned);
}

/**
 * The classes grouped into their categories, ready to render.
 *
 * Groups are emitted in CLASS_CATEGORIES order, and within a group the classes
 * keep the order `classes.list` returned them in (which is itself sorted by
 * gradeOrder), so the picker reads top-to-bottom like the school roll.
 *
 * @param {object[]} classes  rows from the classes table
 * @returns {{key: string, label: string, classes: object[]}[]}
 */
function groupClassesByCategory(classes) {
  const groups = new Map();
  for (const c of classes || []) {
    const { key, label } = classCategory(c);
    if (!groups.has(key)) groups.set(key, { key, label, classes: [] });
    groups.get(key).classes.push(c);
  }
  // Emit in the declared band order rather than insertion order, so a school
  // whose classes were entered out of sequence still reads Pre-Primary first,
  // and the "other" catch-all sinks to the bottom instead of leading.
  const ordered = CLASS_CATEGORIES.map((c) => groups.get(c.key)).filter(Boolean);
  if (groups.has('other')) ordered.push(groups.get('other'));
  return ordered;
}

/**
 * Reads the class ids off a raw `subjects` row.
 *
 * `subjects.classIds` is a JSON array column written by the main process as a
 * denormalised copy of the subject_classes junction table, so a row that has
 * never been through a subject_classes read still knows its assignment.
 *
 * @param {object} subject  a subjects row
 * @returns {number[]}      the assigned class ids, or [] when unparseable
 */
function parseSubjectClassIds(subject) {
  const raw = subject && subject.classIds;
  if (Array.isArray(raw)) return raw.map(Number).filter(Boolean);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(Number).filter(Boolean) : [];
  } catch (err) {
    // A malformed column must not break the edit form; the teacher just sees
    // nothing ticked and has to choose the classes again.
    return [];
  }
}

/* ====================================================================== */
/* Report card document                                                  */
/* ====================================================================== */

function reportCard({ report, settings, examName }) {
  const s = settings || State.settings;
  const r = report;

  const head =
    '<div class="report-head">' +
    (s.schoolLogo
      ? '<img class="logo" src="' + esc(s.schoolLogo) + '" alt="" />'
      : '<div class="logo" style="display:flex;align-items:center;justify-content:center;background:#0f766e;color:#fff;font-weight:800;font-size:26px;border-radius:10px">CC</div>') +
    '<div><div class="name">' + esc(s.schoolName || 'School') + '</div>' +
    '<div class="tagline">' + esc(s.schoolTagline || '') + '</div></div>' +
    '</div>';

  const heading =
    '<div class="report-heading"><h2>' + esc(s.reportHeading || 'Report Card') + '</h2>' +
    '<div class="year">' + esc(examName || '') + (s.academicYear ? ' &middot; Session ' + esc(s.academicYear) : '') + '</div></div>';

  const info =
    '<div class="report-info">' +
    '<div class="kv"><span class="k">Roll No</span><span class="v">' + esc(r.rollNo) + '</span></div>' +
    '<div class="kv"><span class="k">Class</span><span class="v">' + esc(r.studentClass) + '</span></div>' +
    '<div class="kv"><span class="k">Student</span><span class="v">' + esc(r.name) + '</span></div>' +
    '<div class="kv"><span class="k">Guardian</span><span class="v">' + (esc(r.guardian) || '-') + '</span></div>' +
    '</div>';

  const rows = r.subjects
    .map(
      (row, i) =>
        '<tr><td class="num">' + (i + 1) + '</td><td>' + esc(row.subject) + '</td>' +
        '<td class="num">' + num(row.marksObtained) + '</td>' +
        '<td class="num">' + num(row.maxMarks, 0) + '</td>' +
        '<td class="num">' + num(row.percentage) + '%</td>' +
        '<td>' + row.grade + '</td>' +
        '<td>' + (row.isPass ? 'Pass' : 'Fail') + '</td></tr>',
    )
    .join('');

  const table =
    '<table class="doc-table"><thead><tr><th style="width:24px">#</th><th>Subject</th>' +
    '<th class="num" style="width:50px">Marks</th><th class="num" style="width:45px">Max</th>' +
    '<th class="num" style="width:45px">%</th><th style="width:45px">Grade</th><th style="width:40px">Result</th></tr></thead>' +
    '<tbody>' + (rows || '<tr><td colspan="7" style="text-align:center;color:#64748b">No subjects configured</td></tr>') + '</tbody>' +
    '<tfoot><tr><td colspan="2">TOTAL</td><td class="num">' + num(r.totalObtained) + '</td>' +
    '<td class="num">' + num(r.totalMax, 0) + '</td><td class="num">' + num(r.percentage) + '%</td>' +
    '<td>' + r.grade + '</td><td>' + (r.isPass ? 'PASS' : 'FAIL') + '</td></tr></tfoot></table>';

  const summary =
    '<div class="report-summary">' +
    '<div class="cell"><div class="l">Position</div><div class="v">' + (r.position || '-') + '</div></div>' +
    '<div class="cell"><div class="l">Percentage</div><div class="v">' + num(r.percentage) + '%</div></div>' +
    '<div class="cell"><div class="l">Grade</div><div class="v">' + esc(r.grade) + '</div></div>' +
    '<div class="cell"><div class="l">Result</div><div class="v" style="color:' + (r.isPass ? '#15803d' : '#b91c1c') + '">' +
    (r.isPass ? 'PASS' : 'FAIL') + '</div></div>' +
    '</div>';

  const remark =
    '<div class="remark-box"><div class="l">Remark</div><div class="t">' + esc(r.remark || '') + '</div></div>';

  const signs =
    '<div class="doc-signs">' +
    '<div class="sign"><div class="line">' + (esc(s.teacherName) || 'Class teacher') + '</div></div>' +
    '<div class="sign"><div class="line">Parent / Guardian</div></div>' +
    '<div class="sign"><div class="line">' + (esc(s.principalName) || 'Principal') + '</div></div>' +
    '</div>';

  return '<div class="paper">' + head + heading + info + table + summary + remark + signs +
    '<div class="grade-legend">Grading: A+ 90%+ &middot; A 80%+ &middot; B 70%+ &middot; C 60%+ &middot; ' +
    'D 50%+ &middot; Fail below ' + esc(r.passMark) + '%</div>' +
    '</div>';
}
