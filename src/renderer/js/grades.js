/**
 * Grades & Reports view.
 *
 * Class-first layout:
 *   Top row  – class category buttons (e.g. "Class 1", "Class 2") populated
 *              from the classes table; clicking one auto-filters everything
 *              below to that class.
 *   Tabs     – Marks Entry | Results & Report Cards | Subjects
 *
 * The Marks and Results tabs reuse the existing spreadsheet and report-card
 * rendering code, but the class selector is now the primary navigation so the
 * teacher can jump straight to a class without opening a dropdown.
 *
 * All grading maths lives in the main process (see src/main/grading.js);
 * this file only collects input and renders what comes back.
 */
'use strict';

const Grades = {
  tab: 'marks',
  examName: '',
  studentClass: '',
  subjects: [],
  students: [],
  marks: new Map(), // key: `${studentId}|${subject}` -> number
  savedKeys: new Set(), // same keys, but only for cells with a row in the DB
  results: null,
  busy: false,
  classes: [],
   addingClass: false,

  async load() {
    const view = $('#view-grades');
    view.innerHTML = '<div class="empty"><span class="spinner"></span> Loading grades...</div>';

    if (!this.examName) this.examName = await this.suggestExam();

    this.classes = await window.api.classes.list();
    // Default to the first class; fall back to "all" if none exist.
    this.studentClass = this.classes.length ? this.classes[0].name : '';

    view.innerHTML = this.renderShell();
    this.bindTabs(view);
    this.bindClassPills(view);
    await this.renderTab();
  },

  bindTabs(view) {
    on(view, 'click', '.tab', async (e, btn) => {
      this.tab = btn.dataset.tab;
      $$('.tab', view).forEach((t) => t.classList.toggle('active', t === btn));
      await this.renderTab();
    });
  },

  async renderTab() {
    const body = $('#gradesBody');
    if (this.tab === 'subjects') return this.renderSubjects(body);
    if (this.tab === 'results') return this.renderResults(body);
    return this.renderMarks(body);
  },

  /** Builds the class-pill bar + tab strip shell. */
  renderShell() {
    const pills = this.classes.length
      ? this.classes
          .map(
            (c) =>
              `<button class="class-pill ${c.name === this.studentClass ? 'active' : ''}" data-class="${esc(c.name)}">${esc(c.name)}</button>`,
          )
          .join('')
      : '<span class="muted">No classes configured yet</span>';

    const addBtn = this.addingClass
      ? `<div class="add-class-form">
           <input class="add-class-input" id="newClassName" placeholder="Class name..." autofocus />
           <button class="add-class-save" id="newClassSave">Add</button>
           <button class="add-class-cancel" id="newClassCancel">✕</button>
         </div>`
      : `<button class="add-class-btn" id="addNewClass" title="Add new class">+ Class</button>`;

    return `
      <div class="class-bar no-print">
        <div class="class-pills">${pills}</div>
        ${addBtn}
        <div class="tabs" style="margin-left:auto">
          <button class="tab ${this.tab === 'marks' ? 'active' : ''}" data-tab="marks">Marks Entry</button>
          <button class="tab ${this.tab === 'results' ? 'active' : ''}" data-tab="results">Results &amp; Report Cards</button>
          <button class="tab ${this.tab === 'subjects' ? 'active' : ''}" data-tab="subjects">Subjects</button>
        </div>
      </div>
      <div id="gradesBody"></div>`;
  },

  /** Clicking a class pill switches the active class and re-renders the tab. */
  bindClassPills(view) {
    on(view, 'click', '.class-pill', async (e, btn) => {
      this.studentClass = btn.dataset.class;
      $$('.class-pill', view).forEach((p) => p.classList.toggle('active', p === btn));
      await this.renderTab();
    });
    on(view, 'click', '#addNewClass', () => {
      this.addingClass = true;
      view.innerHTML = this.renderShell();
      const input = $('#newClassName');
      if (input) input.focus();
    });
    on(view, 'click', '#newClassSave', async (e, btn) => {
      const input = $('#newClassName');
      const name = input?.value?.trim();
      if (!name) return;
      try {
        await window.api.classes.create({ name, gradeOrder: this.classes.length });
        this.classes = await window.api.classes.list();
        this.addingClass = false;
        this.studentClass = name;
        view.innerHTML = this.renderShell();
        this.bindTabs(view);
        this.bindClassPills(view);
        await this.renderTab();
      } catch (err) {
        alert(err.message || 'Failed to create class');
      }
    });
    on(view, 'click', '#newClassCancel', () => {
      this.addingClass = false;
      view.innerHTML = this.renderShell();
    });
    on(view, 'keydown', '#newClassName', (e, input) => {
      if (e.key === 'Enter') {
        input.dispatchEvent(new Event('change'));
        view.querySelector('#newClassSave')?.click();
      } else if (e.key === 'Escape') {
        view.querySelector('#newClassCancel')?.click();
      }
    });
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
        <div class="card-head"><h3>Marks Entry — ${esc(this.studentClass || 'all classes')}</h3></div>
        <div class="card-body">
          <div class="search-row">
            <div class="field" style="min-width:230px">
              <label for="examName">Exam</label>
              <input id="examName" value="${esc(this.examName)}" maxlength="60" />
            </div>
            <button class="btn primary" id="loadMarks" style="align-self:flex-end">Load grid</button>
            <button class="btn" id="saveMarks" style="align-self:flex-end">Save marks</button>
          </div>
          <div id="marksHost" class="mt"></div>
        </div>
      </div>`;

    $('#examName', body).addEventListener('change', (e) => {
      this.examName = e.target.value.trim() || 'Term 1';
    });
    $('#loadMarks', body).addEventListener('click', () => this.loadGrid());
    $('#saveMarks', body).addEventListener('click', (e) =>
      withBusy(e.currentTarget, () => this.saveGrid()),
    );

    await this.loadGrid();
  },

  /** Pulls subjects, the class roster and any previously saved marks. */
  async loadGrid() {
    const host = $('#marksHost');
    if (!host) return;
    host.innerHTML = '<div class="empty"><span class="spinner"></span> Preparing grid...</div>';

    this.subjects = await window.api.grades.listSubjects({ studentClass: this.studentClass });
    this.students = await window.api.students.list('');

    const rows = this.studentClass
      ? this.students.filter((s) => s.studentClass === this.studentClass)
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

    // Keyboard navigation: Enter/Tab moves to next cell, Shift+Tab moves back
    on(host, 'keydown', 'input.mark-input', (e, input) => {
      const inputs = Array.from(host.querySelectorAll('input.mark-input'));
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

  updateTotal(host, studentId) {
    const cell = host.querySelector('[data-total="' + studentId + '"]');
    if (!cell) return;
    let sum = 0;
    let filled = 0;
    $$('input[data-subject]', host)
      .filter((i) => i.dataset.student === studentId && i.value.trim() !== '')
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
  },

  /* ------------------------------------------------------------------ */
  /* TAB: SUBJECTS                                                       */
  /* ------------------------------------------------------------------ */

  async renderSubjects(body) {
    if (!body) return; // Guard against race condition: data:changed refresh may have replaced the view
    this.subjects = await window.api.grades.listSubjects({ studentClass: this.studentClass });
    const classesData = await window.api.grades.listClasses();
    this.availableClasses = classesData.classes;
    const wildcard = classesData.wildcard;

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
              <div class="field">
                <label for="subClass">Class</label>
                <select id="subClass">
                  <option value="">Shared (all classes)</option>
                  ${classesData.classes.map((cname) => `<option value="${esc(cname)}">${esc(cname)}</option>`).join('')}
                </select>
              </div>
            </div>
            <div class="btn-row">
              <button class="btn primary" id="addSubject">Add subject</button>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>Configured subjects</h3><span class="sub">${this.subjects.length} subject(s)</span></div>
          <div class="card-body tight">
            <div class="table-wrap">
              <table>
                <thead><tr><th>#</th><th>Subject</th><th class="num">Max marks</th><th>Class</th><th class="actions">Actions</th></tr></thead>
                <tbody>${
                  this.subjects.length
                    ? this.subjects.map((s, i) => this.subjectRow(s, i, wildcard)).join('')
                    : emptyRow(5, 'No subjects yet. Add your first subject on the left.', '&#128218;')
                }</tbody>
              </table>
            </div>
          </div>
        </div>
      </div>`;

    $('#addSubject', body).addEventListener('click', (e) =>
      withBusy(e.currentTarget, () => this.addSubject()),
    );

    on(body, 'click', 'button[data-act]', async (e, btn) => {
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
   */
  subjectRow(s, i, wildcard) {
    // Subjects from class_subjects have id=null and source='classSubjects'
    const isClassSubject = s.source === 'classSubjects';
    const subjectId = isClassSubject ? s.classSubjectId : s.id;
    
    const actions = `<button class="btn sm" data-act="edit" data-id="${subjectId}" data-source="${s.source || 'grades'}">Edit</button>
       <button class="btn sm danger" data-act="delete" data-id="${subjectId}" data-source="${s.source || 'grades'}">Delete</button>`;
    
    const cls = s.className === wildcard ? 'Shared (all classes)' : s.className || 'Shared';
    return `<tr data-id="${subjectId}" data-source="${s.source || 'grades'}">
                            <td class="muted">${i + 1}</td>
                            <td><strong>${esc(s.name)}</strong></td>
                            <td class="num">${esc(s.maxMarks)}</td>
                            <td>${esc(cls)}</td>
                            <td class="actions no-print">${actions}</td>
                          </tr>`;
  },

  async addSubject() {
    const name = ($('#subName').value || '').trim();
    const maxMarks = Number($('#subMax').value);
    const classSelect = $('#subClass')?.value || '';
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
    await window.api.grades.addSubject({ name, maxMarks, studentClass: classSelect });
    notify.ok('Subject added', name + ' is now part of the grading grid.');
    await this.renderSubjects($('#gradesBody'));
  },

  async editSubject(subject) {
    openModal((close) =>
      el('div', { class: 'modal narrow' }, [
        el('div', { class: 'modal-head' }, [el('h3', { text: 'Edit ' + subject.name })]),
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
              el('label', { for: 'e_subClass', text: 'Class' }),
              el('select', { id: 'e_subClass' }, [
                // A shared subject is stored under the '*' wildcard, so that is
                // what selects the "Shared" option rather than a named class.
                el('option', {
                  value: '',
                  text: 'Shared (all classes)',
                  selected: !subject.className || subject.className === '*',
                }),
                ...this.availableClasses.map((cname) =>
                  el('option', {
                    value: cname,
                    text: cname,
                    selected: subject.className === cname,
                  }),
                ),
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
                const name = ($('#e_subName').value || '').trim();
                const maxMarks = Number($('#e_subMax').value);
                const classSelect = $('#e_subClass')?.value || '';
                if (!name) {
                  notify.warn('Subject required', 'Please enter a subject name.');
                  return;
                }
                if (!(maxMarks > 0)) {
                  notify.warn('Invalid maximum', 'Maximum marks must be greater than zero.');
                  return;
                }
                await window.api.grades.updateSubject({ id: subject.id, name, maxMarks, studentClass: classSelect });
                notify.ok('Subject updated', name + ' has been saved.');
                close();
                await this.renderSubjects($('#gradesBody'));
              }),
          }),
        ]),
      ]),
    );
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
    await this.renderSubjects($('#gradesBody'));
  },

  /* ------------------------------------------------------------------ */
  /* TAB: RESULTS & REPORT CARDS                                         */
  /* ------------------------------------------------------------------ */

  async renderResults(body) {
    if (!this.students.length) this.students = await window.api.students.list('');

    body.innerHTML = `
      <div class="card">
        <div class="card-head"><h3>Results — ${esc(this.studentClass || 'all classes')}</h3></div>
        <div class="card-body">
          <div class="search-row">
            <div class="field" style="min-width:230px">
              <label for="resExam">Exam</label>
              <input id="resExam" value="${esc(this.examName)}" maxlength="60" />
            </div>
            <button class="btn primary" id="loadResults" style="align-self:flex-end">Show results</button>
            <button class="btn" id="printAllCards" style="align-self:flex-end">Print all report cards</button>
          </div>
        </div>
      </div>
      <div id="resultsHost" class="mt"></div>`;

    $('#resExam', body).addEventListener('change', (e) => {
      this.examName = e.target.value.trim() || 'Term 1';
    });
    $('#loadResults', body).addEventListener('click', () => this.loadResults());
    $('#printAllCards', body).addEventListener('click', (e) =>
      withBusy(e.currentTarget, () => this.printAll()),
    );

    await this.loadResults();
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
    this.paintResults(host, data);
  },

  paintResults(host, data) {
    const { results, subjects, summary } = data;
    const passRate = summary.students ? (summary.passed / summary.students) * 100 : 0;

    if (!results.length) {
      host.innerHTML =
        '<div class="card"><div class="empty"><div class="big">&#128203;</div>' +
        'No marks have been recorded for this exam yet. Use the Marks Entry tab first.</div></div>';
      return;
    }

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
            <table>
              <thead>
                <tr>
                  <th class="num">Pos</th><th>Roll</th><th>Student</th><th>Class</th>
                  <th class="num">Total</th><th class="num">%</th><th>Grade</th><th>Result</th>
                  <th class="actions">Actions</th>
                </tr>
              </thead>
              <tbody>${results.map((r) => this.resultRow(r)).join('')}</tbody>
            </table>
          </div>
        </div>
      </div>`;

    on(host, 'click', 'button[data-act]', async (e, btn) => {
      const rollNo = btn.dataset.roll;
      if (btn.dataset.act === 'card') await this.printCard(rollNo);
      else if (btn.dataset.act === 'remark') await this.editRemark(rollNo);
    });
  },

  resultRow(entry) {
    const r = entry.report;
    return `<tr data-roll="${esc(r.rollNo)}">
      <td class="num">${r.position || '-'}</td>
      <td class="mono">${esc(r.rollNo)}</td>
      <td><strong>${esc(r.name)}</strong></td>
      <td>${esc(r.studentClass)}</td>
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
