/**
 * Shared UI helpers: DOM utilities, formatting, toasts, modals, confirm
 * dialogs and the print pipeline.
 *
 * Classic script (no modules) so it can share globals with the other files.
 */
'use strict';

/* ------------------------------------------------------------------ */
/* DOM helpers                                                        */
/* ------------------------------------------------------------------ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Escapes text for safe interpolation into innerHTML. */
function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Delegated listener: `handler` runs when the event originates inside a
 * descendant matching `selector`.
 *
 * Returns a disposer. Delegation is normally bound once to a container that
 * outlives its children, but any view that re-renders itself with `innerHTML`
 * and re-binds on each pass would stack a new listener on every render, so one
 * click would fire the handler N times - and anything the handler notifies
 * about would be reported N times. Callers that re-bind should either use the
 * disposer or go through `delegateOnce` below.
 *
 * @returns {function():void} removes exactly the listener that was added
 */
function on(root, event, selector, handler) {
  if (!root) return () => {};
  const listener = (e) => {
    const target = e.target.closest(selector);
    if (target && root.contains(target)) handler(e, target);
  };
  root.addEventListener(event, listener);
  return () => root.removeEventListener(event, listener);
}

/**
 * Same as `on`, but idempotent: binding the same event + selector to the same
 * root twice replaces the previous binding instead of adding a second one.
 *
 * A view that rebuilds its markup on every render binds to the persistent
 * container it renders into - `#gradesBody`, `#view-grades`. The element
 * survives, so a plain addEventListener there is installed once per render and
 * every click is handled N times, repeating every message it raised. Re-binding
 * under the same key just moves the single listener to the current handler.
 *
 * Bindings are keyed by root *and* event+selector, so one root can carry several
 * independent delegations without them evicting each other.
 *
 * @param {WeakMap} registry  shared across calls; created by the caller
 */
function delegateOnce(registry, root, event, selector, handler) {
  if (!root) return () => {};
  let byEvent = registry.get(root);
  if (!byEvent) {
    byEvent = new Map();
    registry.set(root, byEvent);
  }
  const key = `${event}|${selector}`;
  const previous = byEvent.get(key);
  if (previous) previous();
  const dispose = on(root, event, selector, handler);
  byEvent.set(key, dispose);
  return dispose;
}

/* ------------------------------------------------------------------ */
/* Formatting                                                         */
/* ------------------------------------------------------------------ */

const State = {
  settings: {
    schoolName: 'CampusCore School',
    schoolLogo: '',
    currencySymbol: 'Rs',
    academicYear: '',
    passMarkPercentage: '50',
  },
};

function money(value) {
  const n = Number(value) || 0;
  const sym = State.settings.currencySymbol || '';
  return `${sym} ${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function num(value, decimals = 2) {
  const n = Number(value) || 0;
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function pct(value) {
  return `${(Number(value) || 0).toFixed(2)}%`;
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function currentMonthLabel() {
  return new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function formatDate(value) {
  if (!value) return '-';
  const d = new Date(String(value).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: '2-digit' });
}

function formatDateTime(value) {
  if (!value) return '-';
  const d = new Date(String(value).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return String(value);
  return `${d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: '2-digit' })} ${d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
}

function badge(text, kind) {
  const cls = String(text).replace(/\s+/g, '');
  return `<span class="badge ${esc(kind || cls)}">${esc(text)}</span>`;
}

function statusBadge(status) {
  return badge(status, status === 'Paid' ? 'ok' : status === 'Partial' ? 'warn' : 'danger');
}

function gradePill(grade) {
  return `<span class="grade-pill ${esc(grade)}">${esc(grade)}</span>`;
}

/** KPI tile shared by the Dashboard, Students, Fees and Grades views. */
function kpi(label, value, foot, accent) {
  return `<div class="stat ${accent || ''}">
      <div class="label">${esc(label)}</div>
      <div class="value">${esc(String(value))}</div>
      <div class="foot">${esc(foot)}</div>
    </div>`;
}


function emptyRow(colspan, message, icon = '&#128269;') {
  return `<tr class="empty-row"><td colspan="${colspan}">
    <div class="empty"><div class="big">${icon}</div>${esc(message)}</div></td></tr>`;
}

/* ------------------------------------------------------------------ */
/* Toasts                                                             */
/* ------------------------------------------------------------------ */

function toast(title, message = '', kind = 'info', ms = 3600) {
  const stack = $('#toastStack');
  if (!stack) return;
  const node = el('div', { class: `toast ${kind}` }, [
    el('div', { class: 't-title', text: title }),
    message ? el('div', { class: 't-msg', text: message }) : null,
  ]);
  stack.append(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .3s';
    setTimeout(() => node.remove(), 320);
  }, ms);
}

const notify = {
  ok: (t, m) => toast(t, m, 'ok'),
  info: (t, m) => toast(t, m, 'info'),
  warn: (t, m) => toast(t, m, 'warn'),
  error: (t, m) => toast(t, m, 'err', 6000),
};

/* ------------------------------------------------------------------ */
/* Modals                                                             */
/* ------------------------------------------------------------------ */

let modalCloser = null;

/** Opens a modal. `render(close)` must return the modal element. */
function openModal(render) {
  const backdrop = $('#modalBackdrop');
  if (modalCloser) modalCloser();
  backdrop.innerHTML = '';
  backdrop.hidden = false;

  const close = () => {
    backdrop.hidden = true;
    backdrop.innerHTML = '';
    document.removeEventListener('keydown', onKey, true);
    modalCloser = null;
  };
  function onKey(e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === 'Enter') {
      const target = e.target;
      // If focused on a button or link, let native keyboard activation take place
      if (target && (target.tagName === 'BUTTON' || target.tagName === 'A')) {
        return;
      }
      // If typing in a multiline textarea, save on Ctrl+Enter / Cmd+Enter
      if (target && target.tagName === 'TEXTAREA') {
        if (!e.ctrlKey && !e.metaKey) return;
      }
      const submit = backdrop.querySelector(
        '.modal-foot .btn.primary, .modal-foot .btn.danger, .modal-foot button[type="submit"], .modal .btn.primary'
      );
      if (submit && !submit.disabled) {
        e.preventDefault();
        e.stopPropagation();
        submit.click();
      }
    }
  }
  document.addEventListener('keydown', onKey, true);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });

  modalCloser = close;
  backdrop.append(render(close));
  return close;
}

/** Promise-based confirm dialog. */
function confirmDialog({ title, message, detail = '', confirmText = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value, close) => {
      settled = true;
      resolve(value);
      close();
    };
    openModal((close) =>
      el('div', { class: 'modal narrow' }, [
        el('div', { class: 'modal-head' }, [el('h3', { text: title })]),
        el('div', { class: 'modal-body' }, [
          el('p', { text: message, style: 'margin:0 0 8px' }),
          detail ? el('p', { class: 'muted', text: detail, style: 'margin:0;font-size:12.5px' }) : null,
        ]),
        el('div', { class: 'modal-foot' }, [
          el('button', { class: 'btn ghost', text: 'Cancel', onClick: () => done(false, close) }),
          el('button', {
            class: `btn ${danger ? 'danger' : 'primary'}`,
            text: confirmText,
            onClick: () => done(true, close),
          }),
        ]),
      ]),
    );
    // Focus the confirm button so the dialog is fully operable from the
    // keyboard: Enter confirms, Escape cancels (handled by openModal) and Tab
    // reaches Cancel. Without this the caret stays on whatever was focused
    // underneath, so Enter would re-trigger the action that opened the dialog.
    const confirm = $('.modal-foot .btn.primary, .modal-foot .btn.danger', $('#modalBackdrop'));
    if (confirm) confirm.focus();
    // Resolve false if dismissed via Escape or a backdrop click.
    const backdrop = $('#modalBackdrop');
    const observer = new MutationObserver(() => {
      if (backdrop.hidden && !settled) {
        settled = true;
        observer.disconnect();
        resolve(false);
      }
    });
    observer.observe(backdrop, { attributes: true, attributeFilter: ['hidden'] });
  });
}

/* ------------------------------------------------------------------ */
/* Async button helper                                                */
/* ------------------------------------------------------------------ */

async function withBusy(button, fn) {
  if (!button) return fn();
  const original = button.innerHTML;
  button.disabled = true;
  button.innerHTML = '<span class="spinner"></span> Working...';
  try {
    return await fn();
  } finally {
    button.disabled = false;
    button.innerHTML = original;
  }
}

/**
 * Tells the bootstrap that this view has just re-rendered after a write.
 *
 * Defined here rather than called as App.markSelfRender() at every call site so
 * that a view is safe to render before the bootstrap has run - the renderer
 * test harness loads the view modules on their own, without app.js.
 */
function selfRendered() {
  if (typeof App !== 'undefined' && App.markSelfRender) App.markSelfRender();
}

/* ------------------------------------------------------------------ */
/* Print pipeline                                                     */
/* ------------------------------------------------------------------ */

/**
 * Stages HTML into #printRoot, applies the print mode and opens the system
 * print dialog. The preview markup is identical to what is printed.
 */
function printDocument(html, mode) {
  const root = $('#printRoot');
  root.setAttribute('data-print', mode);
  root.innerHTML = `<div class="doc-stage">${html}</div>`;

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    root.removeAttribute('data-print');
    root.innerHTML = '';
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);

  // Let the engine lay out the document before invoking print.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      window.print();
      setTimeout(cleanup, 1500); // fail-safe if afterprint never fires
    });
  });
}

/** Renders a document into a preview container (screen only). */
function renderPreview(container, html) {
  if (!container) return;
  container.innerHTML = `<div class="doc-stage">${html}</div>`;
}
