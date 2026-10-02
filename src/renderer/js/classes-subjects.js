/**
 * Classes & Subjects view - split-panel manager for school class categories
 * and the subjects taught in each one.
 *
 * Left panel  : the class list (sorted by grade order) with add/edit/delete.
 * Right panel : the subjects of the selected class, with search, an add/edit/
 *               delete action per card and an empty state.
 *
 * All persistence goes through the classes / subjects namespaces exposed by
 * preload.js, which map to the ipcMain handlers registered in src/main/ipc.js.
 */
'use strict';

const ClassesSubjects = {
  classes: [],
  subjects: [],
  activeId: null,
  search: '',
  /** Set while a dialog is open so data:changed refreshes do not yank it away. */
  busy: false,

  /* ------------------------------------------------------------------ */
  /* Data                                                                */
  /* ------------------------------------------------------------------ */

  async load() {
    const view = $('#view-classes');
    view.innerHTML = '<div class="empty"><span class="spinner"></span> Loading classes...</div>';

    this.classes = await window.api.classes.list();
    // Keep the selection stable across reloads; fall back to the first class.
    if (!this.classes.some((c) => c.id === this.activeId)) {
      this.activeId = this.classes.length ? this.classes[0].id : null;
    }

    await this.loadSubjects();
    this.render();
  },

  async loadSubjects() {
    this.subjects = this.activeId ? await window.api.subjects.list(this.activeId) : [];
  },

  async refresh() {
    if (this.busy) return;
    await this.load();
  },

  get activeClass() {
    return this.classes.find((c) => c.id === this.activeId) || null;
  },

  /** Case-insensitive filter over subject name and code. */
  visibleSubjects() {
    const term = this.search.trim().toLowerCase();
    if (!term) return this.subjects;
    return this.subjects.filter(
      (s) =>
        s.name.toLowerCase().includes(term) ||
        (s.code || '').toLowerCase().includes(term),
    );
  },

  /* ------------------------------------------------------------------ */
  /* Render                                                              */
  /* ------------------------------------------------------------------ */

  render() {
    const view = $('#view-classes');
    view.innerHTML = `
      <div class="cs-split">
        ${this.classPanel()}
        ${this.subjectPanel()}
      </div>`;
    this.bind(view);
  },

  /** Left panel: list of class categories. */
  classPanel() {
    const total = this.classes.length;
    const items = this.classes.length
      ? this.classes.map((c) => this.classItem(c)).join('')
      : `<div class="empty">
           <div class="big">&#128218;</div>
           No classes yet.<br />Add your first class category to begin.
         </div>`;

    return `
      <section class="card cs-classes">
        <div class="card-head">
          <h3>Classes</h3>
          <button class="btn primary sm" id="csAddClass">+ Add Class</button>
        </div>
        <div class="cs-class-list">${items}</div>
        <div class="cs-class-foot">
          <span class="muted">${total} class${total === 1 ? '' : 'es'} configured</span>
        </div>
      </section>`;
  },

  classItem(c) {
    const count = this.activeId === c.id ? this.subjects.length : null;
    return `
      <div class="cs-class-row${c.id === this.activeId ? ' is-active' : ''}" data-id="${c.id}">
        <div class="cs-class-main">
          <div class="cs-class-name">${esc(c.name)}</div>
          <div class="cs-class-meta">
            <span class="mono">Order ${Number(c.gradeOrder)}</span>
            ${count === null ? '' : `<span class="dot">&middot;</span><span>${count} subject${count === 1 ? '' : 's'}</span>`}
          </div>
        </div>
        <div class="cs-class-actions">
          <button class="btn sm" data-act="edit-class" data-id="${c.id}" title="Edit class">Edit</button>
          <button class="btn sm danger" data-act="delete-class" data-id="${c.id}" title="Delete class">Delete</button>
        </div>
      </div>`;
  },
  /** Right panel: subject manager for the active class. */
  subjectPanel() {
    const active = this.activeClass;
    if (!active) {
      return `
        <section class="card cs-subjects">
          <div class="card-head"><h3>Subjects</h3></div>
          <div class="empty">
            <div class="big">&#128214;</div>
            Select a class on the left, or create one, to manage its subjects.
          </div>
        </section>`;
    }

    const all = this.subjects;
    const shown = this.visibleSubjects();
    const activeCount = all.filter((s) => s.status === 'Active').length;

    const header = `
      <div class="cs-subject-head">
        <div class="cs-subject-heading">
          <h3>${esc(active.name)}</h3>
          <p class="cs-subject-sub">
            ${all.length} subject${all.length === 1 ? '' : 's'} &middot;
            ${activeCount} active
          </p>
        </div>
        <div class="search-row no-print">
          <input type="search" id="csSearch" placeholder="Filter subjects..."
                 value="${esc(this.search)}" aria-label="Filter subjects" />
          <button class="btn primary sm" id="csAddSubject">+ Add Subject</button>
        </div>
      </div>`;

    let body;
    if (!all.length) {
      body = `<div class="empty">
          <div class="big">&#128218;</div>
          <strong>No subjects yet</strong><br />
          Add the subjects taught in ${esc(active.name)}.<br />
          <span class="muted">e.g. Mathematics, English, Science</span>
        </div>`;
    } else if (!shown.length) {
      body = `<div class="empty">
          <div class="big">&#128269;</div>
          No subjects match &ldquo;${esc(this.search)}&rdquo;.
        </div>`;
    } else {
      body = `<div class="cs-subject-grid">${shown.map((s) => this.subjectCard(s)).join('')}</div>`;
    }

    return `
      <section class="card cs-subjects">
        ${header}
        <div class="cs-subject-body">${body}</div>
      </section>`;
  },

  subjectCard(s) {
    const kind = s.status === 'Active' ? 'ok' : 'D';
    return `
      <article class="cs-subject-card" data-id="${s.id}">
        <div class="cs-subject-top">
          <div class="cs-subject-name" title="${esc(s.name)}">${esc(s.name)}</div>
          ${badge(s.status, kind)}
        </div>
        <div class="cs-subject-meta">
          ${s.code ? `<span class="mono cs-code">${esc(s.code)}</span>` : '<span class="muted">No code</span>'}
        </div>
        <div class="cs-subject-actions no-print">
          <button class="btn sm" data-act="edit-subject" data-id="${s.id}">Edit</button>
          <button class="btn sm danger" data-act="delete-subject" data-id="${s.id}">Delete</button>
        </div>
      </article>`;
  },

  /* ------------------------------------------------------------------ */
  /* Events                                                              */
  /* ------------------------------------------------------------------ */

  bind(view) {
    $('#csAddClass', view).addEventListener('click', () => this.openClassForm(null));

    const search = $('#csSearch', view);
    if (search) {
      let timer = null;
      search.addEventListener('input', (e) => {
        clearTimeout(timer);
        const value = e.target.value;
        timer = setTimeout(() => {
          this.search = value;
          this.render();               // preserves this.search in the input
          const box = $('#csSearch');
          if (box) {
            box.focus();
            box.setSelectionRange(box.value.length, box.value.length);
          }
        }, 200);
      });
    }

    const addSubject = $('#csAddSubject', view);
    if (addSubject) addSubject.addEventListener('click', () => this.openSubjectForm(null));

    // Delegated handlers - one listener each instead of one per row.
    const classList = $('.cs-class-list', view);
    on(classList, 'click', '[data-act]', (e, btn) => {
      const target = this.classes.find((c) => c.id === Number(btn.dataset.id));
      if (!target) return;
      if (btn.dataset.act === 'edit-class') this.openClassForm(target);
      else this.deleteClass(target);
    });

    on(classList, 'click', '.cs-class-row', (e, row) => {
      if (e.target.closest('[data-act]')) return;   // action button, not a select
      this.select(Number(row.dataset.id));
    });

    const grid = $('.cs-subject-body', view);
    if (grid) {
      on(grid, 'click', '[data-act]', (e, btn) => {
        const target = this.subjects.find((s) => s.id === Number(btn.dataset.id));
        if (!target) return;
        if (btn.dataset.act === 'edit-subject') this.openSubjectForm(target);
        else this.deleteSubject(target);
      });
    }
  },

  async select(id) {
    if (id === this.activeId) return;
    this.activeId = id;
    this.search = '';
    await this.loadSubjects();
    this.render();
  },
  /* ------------------------------------------------------------------ */
  /* Class CRUD                                                          */
  /* ------------------------------------------------------------------ */

  /** Add/edit dialog. `existing` is null when creating. */
  openClassForm(existing) {
    const editing = !!(existing && existing.id);
    const suggestedOrder = this.classes.length
      ? Math.max(...this.classes.map((c) => Number(c.gradeOrder))) + 1
      : 1;

    this.busy = true;
    openModal((close) =>
      el('div', { class: 'modal narrow' }, [
        el('div', { class: 'modal-head' }, [
          el('h3', { text: editing ? 'Edit class' : 'Add class' }),
        ]),
        el('div', { class: 'modal-body' }, [
          el('div', { class: 'form-grid' }, [
            el('div', { class: 'field full' }, [
              el('label', { for: 'cs_className', text: 'Class name' }),
              el('input', {
                id: 'cs_className',
                value: editing ? existing.name : '',
                maxlength: '120',
                placeholder: 'e.g. Class 10',
              }),
              el('span', { class: 'hint', text: 'Shown everywhere a class is picked.' }),
            ]),
            el('div', { class: 'field' }, [
              el('label', { for: 'cs_gradeOrder', text: 'Sort order' }),
              el('input', {
                id: 'cs_gradeOrder',
                type: 'number',
                min: '0',
                value: editing ? String(existing.gradeOrder) : String(suggestedOrder),
              }),
              el('span', { class: 'hint', text: 'Lower numbers sort first.' }),
            ]),
          ]),
        ]),
        el('div', { class: 'modal-foot' }, [
          el('button', { class: 'btn ghost', text: 'Cancel', onClick: close }),
          el('button', {
            class: 'btn primary',
            text: editing ? 'Save changes' : 'Add class',
            onClick: (e) =>
              withBusy(e.currentTarget, async () => {
                let saved = false;
                try {
                  saved = await this.submitClass(existing, close);
                } finally {
                  this.busy = false;
                }
                if (saved) await this.load();
              }),
          }),
        ]),
      ]),
    );

    const nameField = $('#cs_className');
    if (nameField) nameField.focus();
  },

  async submitClass(existing, close) {
    const nameInput = $('#cs_className');
    const orderInput = $('#cs_gradeOrder');
    const name = nameInput ? nameInput.value.trim() : '';
    const orderRaw = orderInput ? orderInput.value.trim() : '0';
    const order = orderRaw === '' ? 0 : Number(orderRaw);

    if (!name) {
      notify.warn('Class name required', 'Please enter a name for the class.');
      if (nameInput) nameInput.focus();
      return false;
    }
    if (!Number.isFinite(order) || order < 0) {
      notify.warn('Invalid sort order', 'Sort order must be a number of 0 or more.');
      if (orderInput) orderInput.focus();
      return false;
    }

    const clash = this.classes.find(
      (c) => c.name.toLowerCase() === name.toLowerCase() && c.id !== (existing && existing.id),
    );
    if (clash) {
      notify.warn(
        'Class already exists',
        'A class named "' + name + '" is already configured.',
      );
      if (nameInput) nameInput.focus();
      return false;
    }

    if (existing && existing.id) {
      await window.api.classes.update({ id: existing.id, name, gradeOrder: order });
      notify.ok('Class updated', name + ' has been saved.');
    } else {
      const created = await window.api.classes.create({ name, gradeOrder: order });
      this.activeId = created.id;
      notify.ok('Class added', name + ' is ready for subjects.');
    }

    close();
    return true;
  },

  async deleteClass(target) {
    const isActive = this.activeId === target.id;
    const count = isActive ? this.subjects.length : 0;
    const ok = await confirmDialog({
      title: 'Delete class',
      message: 'Delete ' + target.name + '?',
      detail: count
        ? count + ' subject(s) in this class will be deleted as well. This cannot be undone.'
        : 'All subjects in this class will be deleted with it. This cannot be undone.',
      confirmText: 'Delete class',
      danger: true,
    });
    if (!ok) return;

    await window.api.classes.remove(target.id);
    if (isActive) this.activeId = null;
    notify.ok('Class deleted', target.name + ' and its subjects have been removed.');
    await this.load();
  },
  /* ------------------------------------------------------------------ */
  /* Subject CRUD                                                        */
  /* ------------------------------------------------------------------ */

  openSubjectForm(existing) {
    const active = this.activeClass;
    if (!active) return;
    const editing = !!(existing && existing.id);

    this.busy = true;
    openModal((close) =>
      el('div', { class: 'modal narrow' }, [
        el('div', { class: 'modal-head' }, [
          el('h3', { text: editing ? 'Edit subject' : 'Add subject' }),
          el('span', { class: 'sub', text: active.name }),
        ]),
        el('div', { class: 'modal-body' }, [
          el('div', { class: 'form-grid' }, [
            el('div', { class: 'field full' }, [
              el('label', { for: 'cs_subName', text: 'Subject name' }),
              el('input', {
                id: 'cs_subName',
                value: editing ? existing.name : '',
                maxlength: '120',
                placeholder: 'e.g. Mathematics',
              }),
            ]),
            el('div', { class: 'field' }, [
              el('label', { for: 'cs_subCode', text: 'Code (optional)' }),
              el('input', {
                id: 'cs_subCode',
                value: editing ? existing.code || '' : '',
                maxlength: '20',
                placeholder: 'e.g. MATH',
              }),
            ]),
            el('div', { class: 'field' }, [
              el('label', { for: 'cs_subStatus', text: 'Status' }),
              el('select', { id: 'cs_subStatus' }, [
                el('option', { value: 'Active', text: 'Active' }),
                el('option', { value: 'Inactive', text: 'Inactive' }),
              ]),
            ]),
          ]),
        ]),
        el('div', { class: 'modal-foot' }, [
          el('button', { class: 'btn ghost', text: 'Cancel', onClick: close }),
          el('button', {
            class: 'btn primary',
            text: editing ? 'Save changes' : 'Add subject',
            onClick: (e) =>
              withBusy(e.currentTarget, async () => {
                let saved = false;
                try {
                  saved = await this.submitSubject(existing, close);
                } finally {
                  this.busy = false;
                }
                if (saved) await this.load();
              }),
          }),
        ]),
      ]),
    );

    // Preselect the stored status when editing.
    const select = $('#cs_subStatus');
    if (select && editing) select.value = existing.status || 'Active';
    const nameField = $('#cs_subName');
    if (nameField) nameField.focus();
  },

  async submitSubject(existing, close) {
    const active = this.activeClass;
    if (!active) return false;

    const val = (id) => {
      const node = $(id);
      return node ? node.value.trim() : '';
    };
    const name = val('#cs_subName');
    const code = val('#cs_subCode');
    const status = val('#cs_subStatus') || 'Active';

    if (!name) {
      notify.warn('Subject name required', 'Please enter a subject name.');
      const node = $('#cs_subName');
      if (node) node.focus();
      return false;
    }

    const clash = this.subjects.find(
      (s) => s.name.toLowerCase() === name.toLowerCase() && s.id !== (existing && existing.id),
    );
    if (clash) {
      notify.warn(
        'Duplicate subject',
        '"' + name + '" is already listed in ' + active.name + '.',
      );
      const node = $('#cs_subName');
      if (node) node.focus();
      return false;
    }

    if (existing && existing.id) {
      await window.api.subjects.update({ id: existing.id, name, code, status });
      notify.ok('Subject updated', name + ' has been saved.');
    } else {
      await window.api.subjects.create({ classId: active.id, name, code, status });
      notify.ok('Subject added', name + ' was added to ' + active.name + '.');
    }

    close();
    return true;
  },

  async deleteSubject(target) {
    const active = this.activeClass;
    const ok = await confirmDialog({
      title: 'Delete subject',
      message: 'Delete ' + target.name + '?',
      detail:
        'It will be removed from ' + (active ? active.name : 'this class') +
        '. This cannot be undone.',
      confirmText: 'Delete subject',
      danger: true,
    });
    if (!ok) return;

    await window.api.subjects.remove(target.id);
    notify.ok('Subject deleted', target.name + ' has been removed.');
    await this.load();
  },
};