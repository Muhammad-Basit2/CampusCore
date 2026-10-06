/**
 * Global keyboard command layer.
 *
 * Every shortcut in CampusCore is resolved here, from a single document-level
 * keydown listener, against a registry of named commands. Three reasons it works
 * this way rather than as a listener per view:
 *
 *   - The resolution order is unambiguous. A modal wins, then a focused text
 *     field wins, then the active view's commands, then the global ones. A
 *     per-view listener has no such order and starts double-firing the moment
 *     two views both bind `e`.
 *   - Shortcuts survive re-renders. Views rebuild their markup wholesale, so a
 *     handler bound to a row dies with that row; a command bound to a name does
 *     not.
 *   - The help dialog and the sidebar hints are generated from the registry, so
 *     a shortcut can never be documented but missing, or present but unlisted.
 *
 * Commands are registered as either a bare function or a descriptor:
 *
 *     Keys.register('students', {
 *       n: { keys: 'N', label: 'New student', run: () => this.openForm() },
 *       d: { keys: 'Del', label: 'Delete the highlighted student', run: () => ... },
 *     });
 *
 * Classic script (no modules) so it can share globals with the other files.
 */
'use strict';

const Keys = {
  /** context (view id) -> command map. Filled by each view on load. */
  registry: new Map(),
  /** The row/card the keyboard is pointing at right now. */
  active: null,
  /** Its data-id, so the highlight survives the re-render that follows a save. */
  activeId: null,
  /** Guards against binding the document listener more than once. */
  bound: false,

  /* ------------------------------------------------------------------ */
  /* Registry                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Installs (or replaces) the command map for one view.
   *
   * @param {string} context   a key of Nav's VIEWS map, e.g. 'students'
   * @param {object} commands  name -> function | { keys, label, run }
   */
  register(context, commands) {
    this.registry.set(context, commands || {});
  },

  /** Normalises a registry entry down to { keys, label, run }. */
  entry(context, name) {
    const raw = (this.registry.get(context) || {})[name];
    if (!raw) return null;
    if (typeof raw === 'function') return { keys: name, label: '', run: raw };
    return {
      keys: raw.keys || name,
      label: raw.label || '',
      run: typeof raw.run === 'function' ? raw.run : () => {},
    };
  },

  /**
   * Runs the named command: the active view's own command first, then the
   * global set.
   *
   * @returns {boolean} true when a command ran, so the caller can
   *                    e.preventDefault() and swallow the keystroke.
   */
  fire(name) {
    const context = (typeof Nav === 'undefined' ? '' : Nav.current) || '';
    let entry = this.entry(context, name);
    if (!entry) {
      const global = this.globalCommands();
      if (typeof global[name] === 'function') entry = { keys: name, label: '', run: global[name] };
    }
    if (!entry) return false;
    try {
      const result = entry.run();
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch (err) {
      notify.error('Keyboard action failed', err.message);
    }
    return true;
  },

  /** Clicks a control by selector, if it is on screen. Returns true if clicked. */
  click(selector) {
    const node = $(selector);
    if (!node || node.disabled) return false;
    node.click();
    return true;
  },

  /* ------------------------------------------------------------------ */
  /* Focus helpers                                                       */
  /* ------------------------------------------------------------------ */

  /** True when the caret is in something that swallows plain letter keys. */
  typing() {
    const active = document.activeElement;
    if (!active) return false;
    if (active.isContentEditable) return true;
    return /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName);
  },

  modalOpen() {
    const backdrop = $('#modalBackdrop');
    return !!(backdrop && !backdrop.hidden);
  },

  /**
   * Focuses the current view's search box.
   *
   * Prefers a real search input; the fallback covers views whose filter is a
   * plain text field. Checkboxes, radios and file inputs are skipped so `/`
   * never lands somewhere it cannot be typed into.
   *
   * @returns {boolean} true when a field took the caret
   */
  focusSearch() {
    const view = $('.view.active');
    if (!view) return false;
    const input =
      view.querySelector('input[type="search"]') ||
      view.querySelector('input.gr-search input') ||
      view.querySelector('input:not([type="file"]):not([type="checkbox"]):not([type="radio"])');
    if (!input || input.disabled) return false;
    input.focus();
    if (input.select) input.select();
    return true;
  },
  /* ------------------------------------------------------------------ */
  /* Pointer / caret movement                                           */
  /* ------------------------------------------------------------------ */

  /**
   * The items the arrow keys walk: table rows in any list, or the cards in the
   * Classes & Subjects subject grid.
   *
   * The marks grid is deliberately excluded. Its rows hold a text input per
   * subject and is driven by Tab/Enter from inside the cells, and giving it a
   * row highlight on top of that would fight the user for the caret.
   *
   * @returns {HTMLElement[]}
   */
  items() {
    const view = $('.view.active');
    if (!view) return [];
    return Array.from(
      view.querySelectorAll('tbody tr:not(.empty-row), .cs-class-row, .cs-subject-card'),
    ).filter((node) => node.offsetParent !== null);
  },

  /** Paints (or clears) the keyboard highlight. */
  paint(node) {
    if (this.active && this.active !== node) this.active.classList.remove('is-kbd');
    this.active = node || null;
    this.activeId = node ? node.dataset.id || node.dataset.roll || null : null;
    if (node) {
      node.classList.add('is-kbd');
      node.scrollIntoView({ block: 'nearest' });
    }
  },

  /**
   * Moves the highlight by `step`, clamped to the list.
   *
   * The node is looked up in the live list on every press rather than held as
   * an index, because every view re-renders its rows after a save: a held index
   * would point at whatever row happened to land in that slot.
   */
  move(step) {
    const list = this.items();
    if (!list.length) return;
    const index = list.indexOf(this.active);
    let next;
    if (index === -1) next = step > 0 ? 0 : list.length - 1;
    else next = Math.min(Math.max(index + step, 0), list.length - 1);
    this.paint(list[next]);
  },

  /**
   * Jumps to the first or last item.
   *
   * @param {string} where  the KeyboardEvent.key value, 'Home' or 'End'.
   *   Compared case-insensitively: a mismatch here is silent, it would just
   *   always land on the first row and look like Home and End doing the same.
   */
  jump(where) {
    const list = this.items();
    if (!list.length) return;
    const last = String(where).toLowerCase() === 'end';
    this.paint(last ? list[list.length - 1] : list[0]);
  },

  /** The highlighted item, if it is still in the document. */
  current() {
    if (this.active && this.active.isConnected) return this.active;
    const list = this.items();
    return list.length ? list[0] : null;
  },

  /**
   * Re-establishes the highlight after a re-render.
   *
   * Views rebuild their markup wholesale, so the previously highlighted node is
   * detached by the time the data arrives. The id is remembered, the equivalent
   * row is found in the fresh markup and the highlight is put back, so holding
   * the caret on one student through a delete keeps it on the next one.
   */
  restore() {
    const list = this.items();
    if (!list.length) {
      this.active = null;
      this.activeId = null;
      return;
    }
    const id = this.activeId;
    if (id !== null && id !== undefined) {
      const match = list.find((node) => (node.dataset.id || node.dataset.roll || null) === id);
      if (match) {
        this.paint(match);
        return;
      }
    }
    this.paint(list[0]);
  },

  /**
   * Clicks one named action (`data-act="..."`) on the highlighted row.
   *
   * Views expose several actions per row, so a shortcut has to say *which* one
   * it means - `e` edits even though "Fees" is the first button on a student
   * row. This resolves through the same delegated listeners a mouse click would
   * reach, so the keyboard can never drift from the click behaviour.
   *
   * @param {string} action  the value of the button's data-act
   * @returns {boolean} true when the action ran
   */
  act(action) {
    const row = this.current();
    if (!row) return false;
    const button = row.querySelector(`[data-act="${action}"]`);
    if (!button) return false;
    button.click();
    return true;
  },

  /**
   * Runs a row's primary action: Enter fires the row's edit action, so the
   * highlighted row behaves the way a click on it would.
   *
   * @returns {boolean} true when an action button was found and clicked
   */
  activate() {
    const row = this.current();
    if (!row) return false;
    if (this.act('edit') || this.act('edit-subject')) return true;
    const action = row.querySelector(
      '.actions button[data-act], .cs-subject-actions button[data-act]',
    );
    if (!action) return false;
    action.click();
    return true;
  },
  /* ------------------------------------------------------------------ */
  /* Global commands                                                     */
  /* ------------------------------------------------------------------ */

  /** The chords that are not owned by any one view. */
  globalCommands() {
    return {
      'nav.dashboard': () => Nav.go('dashboard'),
      'nav.students': () => Nav.go('students'),
      'nav.fees': () => Nav.go('fees'),
      'nav.grades': () => Nav.go('grades'),
      'nav.classes': () => Nav.go('classes'),
      'nav.settings': () => Nav.go('settings'),
    };
  },

  /** Ctrl/Cmd + letter -> command name, or '' when there isn't one. */
  chord(e) {
    if (!e.ctrlKey && !e.metaKey) return '';
    if (e.altKey || e.shiftKey) return '';
    return (
      {
        d: 'nav.dashboard',
        s: 'nav.students',
        i: 'nav.fees',
        r: 'nav.grades',
        b: 'nav.classes',
        g: 'nav.settings',
      }[e.key.toLowerCase()] || ''
    );
  },

  /* ------------------------------------------------------------------ */
  /* Dispatcher                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * The resolution order for one keystroke.
   *
   * A modal owns the keyboard while it is open - it handles Escape and Enter
   * itself (see openModal in ui.js) - so nothing here runs behind a dialog.
   * Plain letters then go to the active view's commands, and anything left over
   * falls through to the global set.
   */
  handle(e) {
    if (this.modalOpen()) return;

    const typing = this.typing();
    const chordName = this.chord(e);

    // Escape is claimed even inside a field: it is the one way back out of
    // typing, and a field that cannot be escaped with the keyboard is a trap.
    if (typing && e.key === 'Escape') {
      const focused = document.activeElement;
      if (focused && focused.blur) focused.blur();
      return;
    }

    // Inside a field, Enter belongs to the field. The layer only claims it for
    // Ctrl+Enter, which is "submit whatever I am editing".
    if (typing && e.key === 'Enter' && !chordName) {
      if (e.ctrlKey || e.metaKey) {
        const viewName = (typeof Nav === 'undefined' ? '' : Nav.current) || '';
        const currentView = $(`#view-${viewName}`);
        if (currentView) {
          const saveBtn = currentView.querySelector(
            '#saveSettings, #saveMarks, #addSubject, button.btn.primary[data-act="save"]'
          );
          if (saveBtn && !saveBtn.disabled) {
            e.preventDefault();
            saveBtn.click();
            return;
          }
        }
      }
      return;
    }
    // Any other key inside a field belongs to the field too, unless it is a
    // chord this app defines.
    if (typing && !chordName && !(e.ctrlKey || e.metaKey)) return;
    if (typing && chordName) {
      e.preventDefault();
      this.fire(chordName);
      return;
    }

    if (e.ctrlKey && e.metaKey) return;   // Ctrl+click, AltGr and friends
    if (e.altKey) return;

    // ---- chords --------------------------------------------------------
    if (chordName) {
      e.preventDefault();
      this.fire(chordName);
      return;
    }
    // Ctrl+Shift+R reloads; plain Ctrl+R is "Grades & Report Cards", which is
    // why the View menu moved its reload accelerator (see main.js).
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'r') {
      e.preventDefault();
      window.location.reload();
      return;
    }
    if (e.ctrlKey || e.metaKey) return;   // leave the rest to Electron

    // ---- plain keys ----------------------------------------------------
    if (e.key === '/' || e.key === '?') {
      if (this.focusSearch()) e.preventDefault();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      this.move(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      this.jump(e.key);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      this.activate();
      return;
    }
    if (e.key === 'Escape') {
      const focused = document.activeElement;
      if (focused && focused.blur) focused.blur();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (this.fire('d')) e.preventDefault();
      return;
    }

    // ---- letter commands ----------------------------------------------
    // The active view wins over the global set; `help` is the one global letter
    // that is bound unconditionally, because F1 must never be shadowed.
    const name = e.key.toLowerCase();
    const context = (typeof Nav === 'undefined' ? '' : Nav.current) || '';
    if (this.entry(context, name)) {
      e.preventDefault();
      this.fire(name);
      return;
    }
    if (name === 'f1') {
      e.preventDefault();
      Nav.showShortcuts();
    }
  },

  /** Installs the one document listener. */
  bind() {
    if (this.bound) return;
    this.bound = true;
    document.addEventListener('keydown', (e) => {
      try {
        this.handle(e);
      } catch (err) {
        notify.error('Keyboard action failed', err.message);
      }
    });
    // Any click inside a list re-anchors the highlight, so the keyboard picks up
    // where the mouse left off.
    document.addEventListener('click', (e) => {
      const row = e.target.closest
        ? e.target.closest('tbody tr:not(.empty-row), .cs-class-row, .cs-subject-card')
        : null;
      if (!row) return;
      if (this.items().includes(row)) this.paint(row);
    });
  },
  /* ------------------------------------------------------------------ */
  /* Help                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * The rows shown in the F1 dialog: the global commands plus the ones the
   * active view adds, generated from the registry so the help can never drift
   * from what the dispatcher will actually accept.
   */
  helpSections() {
    const sections = [
      {
        title: 'Navigate',
        rows: [
          ['Ctrl + D', 'Dashboard'],
          ['Ctrl + S', 'Students'],
          ['Ctrl + I', 'Fee &amp; Invoicing'],
          ['Ctrl + R', 'Grades &amp; Report Cards'],
          ['Ctrl + B', 'Classes &amp; Subjects'],
          ['Ctrl + G', 'Settings'],
        ],
      },
      {
        title: 'Select &amp; search',
        rows: [
          ['&uarr; / &darr;', 'Move between records'],
          ['Home / End', 'First / last record'],
          ['Enter', 'Open the highlighted record'],
          ['/', 'Focus the search box'],
          ['Esc', 'Leave the field you are in'],
        ],
      },
    ];

    const context = (typeof Nav === 'undefined' ? '' : Nav.current) || '';
    const commands = this.registry.get(context) || {};
    const rows = Object.keys(commands)
      .map((name) => {
        const entry = this.entry(context, name);
        if (!entry || !entry.keys || !entry.label) return null;
        return [`<kbd>${entry.keys}</kbd>`, entry.label];
      })
      .filter(Boolean);
    if (rows.length) sections.push({ title: this.viewTitle(context), rows });
    return sections;
  },

  viewTitle(context) {
    return (
      {
        students: 'Students',
        fees: 'Fee &amp; Invoicing',
        grades: 'Grades &amp; Report Cards',
        classes: 'Classes &amp; Subjects',
        settings: 'Settings',
      }[context] || 'This view'
    );
  },

  /**
   * Opens the help dialog. Nav.showShortcuts() delegates here so there is one
   * implementation of the shortcut list, not two.
   */
  showHelp() {
    const sections = this.helpSections()
      .map(
        (section) => `
        <section class="shortcut-section">
          <h4>${section.title}</h4>
          <dl class="shortcut-list">
            ${section.rows
              .map(([keys, label]) => `<div><dt>${keys}</dt><dd>${label}</dd></div>`)
              .join('')}
          </dl>
        </section>`,
      )
      .join('');

    return openModal((close) =>
      el('div', { class: 'modal wide' }, [
        el('div', { class: 'modal-head' }, [
          el('h3', { text: 'Keyboard shortcuts' }),
          el('button', { class: 'btn ghost sm', text: 'Close', onClick: close }),
        ]),
        // The body is set with `html`, not passed as a child: el() appends a
        // non-Node child as a text node, so an object here would render as the
        // literal text "[object Object]".
        el('div', { class: 'modal-body', html: `<div class="shortcuts">${sections}</div>` }),
      ]),
    );
  },
};
