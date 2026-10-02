/**
 * Application bootstrap.
 *
 * Runs last (see index.html) and is responsible for:
 *   - loading settings and applying branding before the first view renders
 *   - showing the database path in the sidebar
 *   - handing control to the Nav router
 *   - refreshing the active view when the main process reports a data change
 *   - a single global handler for unexpected renderer errors
 */
'use strict';

const App = {
  started: false,

  async start() {
    if (this.started) return;
    this.started = true;

    try {
      State.settings = await window.api.settings.getAll();
    } catch (err) {
      notify.error('Could not load settings', err.message);
    }

    Settings.applyBranding();
    await this.showDatabasePath();
    Nav.init();

    // The main process pushes this after any successful write, which keeps the
    // dashboard KPIs and lists consistent without manual refreshes.
    window.api.on('data:changed', () => {
      window.api.settings.getAll().then((s) => {
        State.settings = s;
        Settings.applyBranding();
      }).catch(() => {});
      Nav.refresh().catch(() => {});
    });

    await Nav.go('dashboard');

    if (!navigator.onLine) {
      notify.info('Offline mode', 'CampusCore works fully offline. All data stays on this computer.');
    }
    window.addEventListener('online', () => notify.ok('Back online', 'CampusCore never needs an internet connection.'));
  },

  async showDatabasePath() {
    const el$ = $('#dbPath');
    if (!el$) return;
    try {
      const file = await window.api.app.getDbPath();
      el$.textContent = file;
      el$.title = 'Database location: ' + file;
    } catch (err) {
      el$.textContent = 'Database location unavailable';
    }
  },
};

/* ------------------------------------------------------------------ */
/* Last-resort error surfacing                                        */
/* ------------------------------------------------------------------ */

window.addEventListener('error', (e) => {
  notify.error('Unexpected error', (e && e.message) || 'Something went wrong.');
});

window.addEventListener('unhandledrejection', (e) => {
  const reason = e && e.reason;
  notify.error('Unexpected error', (reason && reason.message) || String(reason || 'Promise rejected.'));
});

/* Kick off once the DOM is parsed. */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => App.start());
} else {
  App.start();
}
