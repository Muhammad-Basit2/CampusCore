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
  grades: { title: 'Grades & Reports', subtitle: 'Enter marks and print report cards', render: () => Grades.load() },
  settings: { title: 'Settings', subtitle: 'School profile, branding and printing', render: () => Settings.load() },
};

const Nav = {
  current: 'dashboard',
  params: {},

  init() {
    on($('#nav'), 'click', '.nav-item', (e, btn) => this.go(btn.dataset.view));
    $('#sidebarToggle').addEventListener('click', () => $('#app').classList.toggle('collapsed'));
    this.bindShortcuts();

    // Menu-driven navigation from the main process.
    window.api.on('nav:goto', (view) => this.go(view));
    window.api.on('nav:help', () => this.showShortcuts());
    window.api.on('app:error', (message) => notify.error('Application error', message));
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

    try {
      await def.render();
    } catch (err) {
      notify.error(`Could not load ${def.title}`, err.message);
    }
  },

  /** Reloads the active view (used after a data:changed push). */
  async refresh() {
    const def = VIEWS[this.current];
    if (def) await def.render();
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
