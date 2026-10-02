/**
 * View router, sidebar behaviour and the global keyboard shortcut layer.
 *
 * Shortcuts are owned by the renderer (not the application menu) so that they
 * behave identically no matter which view or input has focus. Electron's own
 * Ctrl+R reload has been moved to Ctrl+Shift+R in main.js to free Ctrl+R.
 */
'use strict';

const VIEWS = {
  dashboard: { title: 'Dashboard', subtitle: 'Overview of your school', render: () => Dashboard.load() },
  students: { title: 'Students', subtitle: 'Manage student records', render: () => Students.load() },
  fees: { title: 'Fee & Invoicing', subtitle: 'Create invoices and record payments', render: () => Fees.load() },
  grades: {
    title: 'Grades & Reports',
    subtitle: 'Enter marks and print report cards',
    render: (params) => Grades.load(params),
  },
  settings: { title: 'Settings', subtitle: 'School profile, branding and printing', render: () => Settings.load() },
};

const Nav = {
  current: 'dashboard',
  params: {},

/**
   * Grades & Reports context.
   *
   * The view used to own its own class dropdown; class selection now belongs to
   * the sidebar tree, so the router has to remember which category and class the
   * user drilled into and hand them to Grades on every render.
   */
  grades: { categoryKey: '', classId: null },
  init() {
    on($('#nav'), 'click', '.nav-item', (e, btn) => {
      // Grades is a tree with a landing page behind it rather than a plain
      // destination, so its header has its own handler instead of just going to
      // the view; the two cannot share one call or the tree never opens.
      if (btn.dataset.view === 'grades') return this.openGrades();
      this.go(btn.dataset.view);
    });
    on($('#nav'), 'click', '.nav-cat', (e, btn) => this.toggleGroup(btn));
    on($('#nav'), 'click', '.nav-class', (e, btn) => this.selectClass(btn));
    // "Grades & Reports" in the breadcrumb drops back to the un-scoped landing
    // page and re-opens the tree, so the crumb is the way out of a class.
    $('#crumbs').addEventListener('click', (e) => {
      if (!e.target.closest('[data-crumb="view"]')) return;
      this.grades.classId = null;
      this.grades.categoryKey = '';
      this.toggleTree(true);
      this.paintTree();
      this.go('grades', { categoryKey: '', classId: null });
    });
    $('#sidebarToggle').addEventListener('click', () => $('#app').classList.toggle('collapsed'));
    this.bindShortcuts();

    // Menu-driven navigation from the main process.
    window.api.on('nav:goto', (view) => this.go(view));
    window.api.on('nav:help', () => this.showShortcuts());
    window.api.on('app:error', (message) => notify.error('Application error', message));
  },
/* ------------------------------------------------------------------ */
  /* Grades tree                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * The Grades sidebar header: opens the view and the tree in one click.
   *
   * Both halves matter. The tree is only meaningful next to the landing page,
   * and it is built from the classes table, so it has to be populated before the
   * first paint rather than after Grades.load() settles. Building it here (and
   * not only in the view) is what stops a first click landing on an empty tree.
   */
  async openGrades() {
    this.toggleTree(true);
    await this.buildTree();
    // A class that is already selected keeps its scope; otherwise the view
    // falls back to its "pick a class" landing page.
    await this.go('grades', {
      categoryKey: this.grades.categoryKey,
      classId: this.grades.classId,
    });
  },

  /**
   * Rebuilds the category / class tree from the classes table.
   *
   * Classes are grouped by the same gradeOrder bands the Subjects tab uses, so a
   * class sits under exactly one heading and the sidebar and the picker can never
   * disagree about which category a class belongs to. Classes come and go as
   * students are registered, so the tree is rebuilt on every grades load rather
   * than only at boot.
   */
  async buildTree() {
    const host = $('#navGradesChildren');
    if (!host) return;

    let classes = [];
    try {
      classes = await window.api.classes.list();
    } catch (err) {
      host.innerHTML = '';
      return;
    }

    this.treeClasses = classes;
    const groups = groupClassesByCategory(classes);
    if (!groups.length) {
      host.innerHTML = '<div class="nav-note">No classes yet</div>';
      return;
    }

    host.innerHTML = groups
      .map((group) => `
        <div class="nav-cat-group" data-cat="${esc(group.key)}">
          <button class="nav-cat" data-cat="${esc(group.key)}" aria-expanded="false">
            <span class="nav-caret" aria-hidden="true">&#9656;</span>
            <span class="nav-cat-label">${esc(group.label)}</span>
            <span class="nav-cat-count">${group.classes.length}</span>
          </button>
          <div class="nav-cat-body">
            ${group.classes
              .map(
                (c) => `
              <button class="nav-class" data-class-id="${c.id}" data-cat="${esc(group.key)}"
                      title="${esc(group.label)} &middot; ${esc(c.name)}">
                <span class="nav-dot" aria-hidden="true"></span>
                <span class="nav-label">${esc(c.name)}</span>
              </button>`,
              )
              .join('')}
          </div>
        </div>`)
      .join('');

    this.paintTree();
  },

  /** Opens or closes the whole grades tree. */
  toggleTree(force) {
    const btn = $('#navGrades .nav-item');
    const open = force === undefined ? !this.treeOpen : force;
    this.treeOpen = open;
    $('#navGrades').classList.toggle('open', open);
    btn.setAttribute('aria-expanded', String(open));
  },

  /** Expands one category, collapsing the others so the tree stays scannable. */
  toggleGroup(btn, force) {
    if (!btn) return;
    const open = force === undefined ? btn.getAttribute('aria-expanded') !== 'true' : force;
    $$('.nav-cat').forEach((other) => {
      if (other === btn) return;
      other.setAttribute('aria-expanded', 'false');
      const wrap = other.closest('.nav-cat-group');
      if (wrap) wrap.classList.remove('open');
    });
    btn.setAttribute('aria-expanded', String(open));
    const wrap = btn.closest('.nav-cat-group');
    if (wrap) wrap.classList.toggle('open', open);
  },

  /** Selects a class, scoping the grades view to it. */
  async selectClass(btn) {
    this.grades.categoryKey = btn.dataset.cat;
    this.grades.classId = Number(btn.dataset.classId);
    await this.go('grades', {
      categoryKey: this.grades.categoryKey,
      classId: this.grades.classId,
    });
  },

  /** The category label a class id sits under, or null when it is not in the tree. */
  categoryOf(classId) {
    const group = groupClassesByCategory(this.treeClasses || [])
      .find((g) => g.classes.some((c) => Number(c.id) === Number(classId)));
    return group ? { key: group.key, label: group.label } : null;
  },

  /** The class row for a class id, or null when the tree has not loaded it. */
  classOf(classId) {
    return (this.treeClasses || []).find((c) => Number(c.id) === Number(classId)) || null;
  },

  /**
   * Highlights the active row and opens the branch that contains it.
   *
   * The active class is scrolled into view too, because with a dozen classes the
   * selected one is routinely below the fold in a long sidebar.
   */
  paintTree() {
    $$('.nav-class').forEach((btn) => {
      btn.classList.toggle('active', Number(btn.dataset.classId) === Number(this.grades.classId));
    });
    const active = $('.nav-class.active');
    if (active) {
      this.toggleGroup($('.nav-cat[data-cat="' + active.dataset.cat + '"]'), true);
      active.scrollIntoView({ block: 'nearest' });
    }
  },

  /** Switches the active view, updating sidebar, topbar and content. */
  async go(view, params = {}) {
    const def = VIEWS[view];
    if (!def) return;
    this.current = view;
    Nav.params = params;

    $$('.nav-item').forEach((b) => {
      const active = b.dataset.view === view;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', String(active));
    });
    $$('.view').forEach((section) => {
      section.classList.toggle('active', section.dataset.view === view);
    });

    $('#viewTitle').textContent = def.title;
    $('#viewSubtitle').textContent = def.subtitle;
    this.setCrumbs(view, params);

    try {
      await def.render(params);
    } catch (err) {
      notify.error(`Could not load ${def.title}`, err.message);
    }
  },

  /**
   * Renders the breadcrumb trail under the topbar title.
   *
   * Only Grades has more than one level, so every other view clears the trail
   * instead of leaving the previous section's path on screen.
   */
  setCrumbs(view, params) {
    const host = $('#crumbs');
    if (!host) return;

    if (view !== 'grades' || !params.classId) {
      host.innerHTML = '';
      host.classList.remove('active');
      return;
    }

    const category = this.categoryOf(params.classId);
    const cls = this.classOf(params.classId);
    host.classList.add('active');
    host.innerHTML = `
      <button class="crumb" data-crumb="view" type="button">Grades &amp; Reports</button>
      <span class="crumb-sep" aria-hidden="true">&rsaquo;</span>
      ${
        category
          ? `<span class="crumb-static">${esc(category.label)}</span>` +
            '<span class="crumb-sep" aria-hidden="true">&rsaquo;</span>'
          : ''
      }
      <span class="crumb-current" aria-current="page">${esc(cls ? cls.name : 'Class')}</span>`;
  },

  /** Reloads the active view (used after a data:changed push). */
  async refresh() {
    const def = VIEWS[this.current];
    if (def) await def.render(this.current === 'grades' ? Nav.params : {});
  },

  /**
   * Global shortcuts.
   *   Ctrl+D Dashboard  Ctrl+S Students  Ctrl+I Fees
   *   Ctrl+R Grades     Ctrl+G Settings   Ctrl+B Classes
   *   F1 Help
   *   Up/Down move the row highlight, Enter opens the highlighted row.
   */
  bindShortcuts() {
    document.addEventListener('keydown', (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);

      if (e.key === 'F1') {
        e.preventDefault();
        this.showShortcuts();
        return;
      }

      if (e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
        const map = { d: 'dashboard', s: 'students', i: 'fees', r: 'grades', g: 'settings' };
        const target = map[e.key.toLowerCase()];
        if (target) {
          e.preventDefault();
          this.go(target);
          return;
        }
      }

      // Modals handle Escape themselves (see openModal in ui.js).
      if (!$('#modalBackdrop').hidden) return;

      if (e.key === 'Escape') {
        const active = document.activeElement;
        if (!typing && active && active.blur) active.blur();
        return;
      }
      if (typing) return;

      // -------------------- row navigation -------------------------
      const table = this.focusedTable();
      if (!table) return;

      const rows = $$('tbody tr', table).filter((r) => !r.classList.contains('empty-row'));
      if (!rows.length) return;

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const current = table.querySelector('tr.is-active');
        const index = rows.indexOf(current);
        const next = e.key === 'ArrowDown'
          ? Math.min(index + 1, rows.length - 1)
          : Math.max(index - 1, 0);
        rows.forEach((r) => r.classList.remove('is-active'));
        const target = rows[index === -1 ? 0 : next];
        target.classList.add('is-active');
        target.scrollIntoView({ block: 'nearest' });
      }

      if (e.key === 'Enter') {
        const activeRow = table.querySelector('tr.is-active');
        if (activeRow) {
          e.preventDefault();
          activeRow.click();
        }
      }
    });

    // Clicking inside a table makes it the keyboard target.
    document.addEventListener('click', (e) => {
      const table = e.target.closest('table');
      if (!table) return;
      $$('tr.is-active').forEach((r) => r.classList.remove('is-active'));
      const row = e.target.closest('tbody tr');
      if (row && !row.classList.contains('empty-row')) row.classList.add('is-active');
    });
  },

  /** The table under the caret, or the first table in the active view. */
  focusedTable() {
    const active = document.activeElement;
    const own = active && active.closest ? active.closest('table') : null;
    if (own) return own;
    return $$('.view.active table')[0] || null;
  },

  showShortcuts() {
    const rows = [
      ['Ctrl + D', 'Go to Dashboard'],
      ['Ctrl + S', 'Go to Students'],
      ['Ctrl + I', 'Go to Fee &amp; Invoicing'],
      ['Ctrl + R', 'Go to Grades &amp; Reports'],
      ['Ctrl + G', 'Go to Settings'],
      ['Ctrl + B', 'Go to Classes &amp; Subjects'],
      ['Ctrl + Shift + R', 'Reload the application window'],
      ['&uarr; / &darr;', 'Move between table rows'],
      ['Enter', 'Open the highlighted row'],
      ['F1', 'Show this help'],
      ['Esc', 'Close a dialog / clear focus'],
    ];
    openModal((close) =>
      el('div', { class: 'modal narrow' }, [
        el('div', { class: 'modal-head' }, [
          el('h3', { text: 'Keyboard Shortcuts' }),
          el('button', { class: 'btn ghost sm', text: 'Close', onClick: close }),
        ]),
        el('div', { class: 'modal-body' }, [
          el('table', {
            class: 'shortcut-table',
            html: rows.map(([k, d]) => `<tr><td><kbd>${k}</kbd></td><td class="muted">${d}</td></tr>`).join(''),
          }),
        ]),
      ]),
    );
  },
};
