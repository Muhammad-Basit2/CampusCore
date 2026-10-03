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
  /** Handle for the pending coalesced refresh. */
  _refreshTimer: null,
  /** Set while a view is re-rendering in response to a broadcast. */
  _refreshing: false,
  /** A refresh arrived while one was running: run once more when it finishes. */
  _refreshAgain: false,
  /**
   * Timestamp of the last write this window made and re-rendered itself.
   *
   * A view that has just saved calls markSelfRender(), because it reloads on
   * purpose; the main process broadcasts that same write a moment later, and
   * rendering it as well would query the database and rebuild the same rows a
   * second time for one save.
   */
  _selfRenderedAt: 0,

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
    window.api.on('data:changed', (what) => this.onDataChanged(what));

    await Nav.go('dashboard');

    if (!navigator.onLine) {
      notify.info('Offline mode', 'CampusCore works fully offline. All data stays on this computer.');
    }
    window.addEventListener('online', () => notify.ok('Back online', 'CampusCore never needs an internet connection.'));
  },

  /**
   * Called by a view that has just written and re-rendered itself.
   *
   * Only the next broadcast is affected, and only if it arrives promptly, so a
   * change genuinely made somewhere else still refreshes the view afterwards.
   */
  markSelfRender() {
    this._selfRenderedAt = Date.now();
  },

  /**
   * Handles a data:changed push.
   *
   * Two costs are removed here:
   *
   *  - Bursts are coalesced. Importing a roster writes once per row, and the
   *    previous handler started a full re-query and re-render for every one of
   *    them. A burst now collapses into a single refresh once the writes settle.
   *  - Overlapping renders are dropped. When a broadcast landed while a save's
   *    own reload was still in flight, both ran at once and raced over the same
   *    markup. The second is now queued behind the first instead.
   */
  onDataChanged() {
    window.api.settings
      .getAll()
      .then((s) => {
        State.settings = s;
        Settings.applyBranding();
      })
      .catch(() => {});

    // The write behind this broadcast was already re-rendered by the view that
    // made it, so rendering it again would duplicate that work exactly.
    if (Date.now() - this._selfRenderedAt < 500) return;

    clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(() => this.scheduleRefresh(), 120);
  },

  async scheduleRefresh() {
    if (this._refreshing) {
      this._refreshAgain = true;
      return;
    }
    this._refreshing = true;
    try {
      await Nav.refresh();
    } catch (err) {
      notify.error('Could not refresh', err.message);
    } finally {
      this._refreshing = false;
      if (this._refreshAgain) {
        this._refreshAgain = false;
        await this.scheduleRefresh();
      }
    }
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
