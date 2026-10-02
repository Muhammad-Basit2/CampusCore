/**
 * Print page-count harness.
 * ---------------------------------------------------------------------------
 * Builds real report-card markup with the renderer code that actually ships
 * (reportCard() from grades.js + the grading maths from the main process),
 * renders it through the real print.css, exports a PDF with printToPDF() and
 * reports how many physical pages the job produced.
 *
 * This is the only reliable way to answer "does one report card fit on one
 * page?" without a printer - Chromium's print layout cannot be observed from
 * the DOM.
 *
 * Run with:  npx electron tools/print-page-test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const url = require('url');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const TMP = path.join(__dirname, '.print-tmp');
const { buildReport } = require(path.join(ROOT, 'src', 'main', 'grading.js'));

/* ---------------------------------------------------------------- helpers */

/** Pulls reportCard() straight out of the shipped renderer file. */
function reportCardSource() {
  const src = fs.readFileSync(path.join(RENDERER, 'js', 'grades.js'), 'utf8');
  const start = src.indexOf('function reportCard(');
  if (start < 0) throw new Error('reportCard() not found in grades.js');
  return src.slice(start);
}

/**
 * Evaluates the real reportCard() inside a Node vm sandbox so the harness
 * exercises the exact shipped markup builder without depending on renderer JS
 * injection. esc() / num() / State are the real helpers copied from ui.js.
 */
function buildReportCardFn() {
  const sandbox = {
    esc(value) {
      if (value === null || value === undefined) return '';
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    },
    num(value, decimals) {
      decimals = decimals === undefined ? 2 : decimals;
      const n = Number(value) || 0;
      return n.toLocaleString('en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      });
    },
    State: { settings: {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(reportCardSource() + '\nthis.__reportCard = reportCard;', sandbox);
  return sandbox.__reportCard;
}

function countPdfPages(buffer) {
  const text = buffer.toString('latin1');
  const counts = (text.match(/\/Count\s+(\d+)/g) || [])
    .map((m) => parseInt(m.replace(/\D+/g, ''), 10))
    .filter((n) => Number.isFinite(n));
  if (counts.length) return Math.max(...counts);
  const pages = text.match(/\/Type\s*\/Page[^s]/g);
  return pages ? pages.length : 0;
}

/* ------------------------------------------------------------- test data */

const SUBJECTS = [
  'English', 'Mathematics', 'Physics', 'Chemistry',
  'Biology', 'Computer Science', 'Islamiat', 'Urdu',
  'History', 'Geography', 'Drawing', 'Music',
  'Economics', 'Fine Arts', 'Physical Education', 'Arabic',
];

const SETTINGS = {
  schoolName: 'CampusCore Public School',
  schoolTagline: 'Excellence in every field',
  schoolLogo: '',
  reportHeading: 'Report Card',
  academicYear: '2025 - 2026',
  teacherName: 'Mr. Ahmed Khan',
  principalName: 'Dr. Sara Iqbal',
};

const EXAM = 'Term 2 - 2026';

function makeCards(count, { subjectCount = SUBJECTS.length, remark = '' } = {}) {
  const used = SUBJECTS.slice(0, subjectCount);
  const cards = [];
  for (let i = 0; i < count; i += 1) {
    const student = {
      rollNo: String(i + 1),
      name: 'Student Number ' + (i + 1),
      studentClass: i % 2 === 0 ? 'Class 10' : 'Class 9',
      guardian: 'Guardian ' + (i + 1),
    };
    const rows = used.map((subject, j) => ({
      subject,
      marksObtained: 40 + ((i * 7 + j * 5) % 55),
      maxMarks: 100,
    }));
    cards.push({
      report: buildReport(student, rows, 50, remark),
      settings: SETTINGS,
      examName: EXAM,
    });
  }
  return cards;
}

/* --------------------------------------------------------------- harness */

/** The real stylesheets, inlined so no file:// load is required. */
function readStyles() {
  const dir = path.join(RENDERER, 'styles');
  return (
    '<style>' + fs.readFileSync(path.join(dir, 'main.css'), 'utf8') + '</style>' +
    '<style>' + fs.readFileSync(path.join(dir, 'print.css'), 'utf8') + '</style>'
  );
}

async function renderPdf(cardsHtml) {
  const html = [
    '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" />',
    readStyles(),
    '</head><body>',
    '<div id="printRoot" class="print-root no-print" data-print="report">',
    '<div class="doc-stage">' + cardsHtml + '</div></div>',
    '</body></html>',
  ].join('');

  // Written to disk: an inline data: URL large enough to hold both
  // stylesheets crashes the renderer in this Electron build.
  fs.mkdirSync(TMP, { recursive: true });
  const tmp = path.join(TMP, 'print-' + process.pid + '.html');
  fs.writeFileSync(tmp, html, 'utf8');

  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 1600,
    // JavaScript stays ENABLED: with javascript:false this Electron build
    // refuses to load any URL (ERR_FAILED -2) and nothing ever renders.
    webPreferences: { contextIsolation: true },
  });

  try {
    // loadURL(pathToFileURL(...)) rather than loadFile(): loadFile returns
    // ERR_FAILED (-2) on this machine.
    await win.loadURL(url.pathToFileURL(tmp).href);
    // Let the stylesheets apply before the print layout is computed.
    await new Promise((r) => setTimeout(r, 500));

    return await win.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      margins: { marginType: 'default' },
    });
  } finally {
    if (!win.isDestroyed()) win.destroy();
    fs.unlinkSync(tmp);
  }
}

/* ------------------------------------------------------------------ main */

const PAGE_BREAK = '<div class="page-break"></div>';

/**
 * cards   - how many report cards the job contains
 * subs    - subject rows on each card
 * joined  - true  -> cards flow together, no separator
 *          false -> exactly what printAll() produces: cards joined directly,
 *                   with print.css's `.paper + .paper` rule doing the break
 * separator - true -> inject the old .page-break div (kept to prove that
 *                   combining it with the CSS rule is what caused blank pages)
 */
const SCENARIOS = {
  '1card-1': { cards: 1, subs: 1, joined: true },
  '1card-3': { cards: 1, subs: 3, joined: true },
  '1card-5': { cards: 1, subs: 5, joined: true },
  '1card-8': { cards: 1, subs: 8, joined: true },
  '1card-12': { cards: 1, subs: 12, joined: true },
  '1card-16': { cards: 1, subs: 16, joined: true },
  '2card-flow': { cards: 2, subs: 8, joined: true },
  '2card-printall': { cards: 2, subs: 8, joined: false },
  '4card-flow': { cards: 4, subs: 8, joined: true },
  '4card-printall': { cards: 4, subs: 8, joined: false },
  '4card-legacy-sep': { cards: 4, subs: 8, joined: false, separator: true },
};

/**
 * Isolation probes: tiny fixed markup rendered through the real stylesheets so
 * the contributor to the second page can be identified one variable at a time.
 *
 *   empty      - bare <div> inside printRoot
 *   paper      - <div class="paper"> only
 *   no-page    - <div class="paper"> with `page: sheet` neutralised
 *   no-stage   - no .doc-stage wrapper
 */
async function renderProbe(mode) {
  const wrap = (inner) => [
    '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" />',
    readStyles(),
    '</head><body>',
    '<div id="printRoot" class="print-root no-print" data-print="report">',
    inner,
    '</div>',
    '</body></html>',
  ].join('');

  let inner;
  if (mode === 'empty') {
    inner = '<div>hello</div>';
  } else if (mode === 'paper') {
    inner = '<div class="doc-stage"><div class="paper">hello</div></div>';
  } else if (mode === 'no-stage') {
    inner = '<div class="paper">hello</div>';
  } else if (mode === 'no-page') {
    inner = '<style>#printRoot[data-print="report"] .paper{page:auto!important}</style>' +
      '<div class="doc-stage"><div class="paper">hello</div></div>';
  } else if (mode.startsWith('card-')) {
    // Overrides applied on top of the REAL card to find what forces page 2.
    const fix = {
      'card-base': '',
      'card-nopage': '#printRoot[data-print="report"] .paper{page:auto!important}',
      'card-minh': '#printRoot[data-print="report"] .paper{min-height:0!important}',
      'card-nofoot':
        '#printRoot[data-print="report"] table.doc-table tfoot{display:table-row-group!important}',
      'card-nohead':
        '#printRoot[data-print="report"] table.doc-table thead{display:table-row-group!important}',
      'card-nosigns':
        '#printRoot .doc-signs{margin-top:8px!important}',
      'card-nowrap': '#printRoot .doc-signs{page-break-inside:avoid}',
    }[mode] || '';
    inner = '<div class="doc-stage">' +
      (fix ? '<style>' + fix + '</style>' : '') +
      cardsHtmlFor(SCENARIOS['1card-8']) + '</div>';
  } else if (mode === 'table-split') {
    // The report table is the first block that pushes content to page 2.
    // Rendering it alone (thead + tfoot, no rows) shows whether the forced
    // table-header-group / table-footer-group repetition alone overflows.
    inner = '<div class="doc-stage"><div class="paper">' +
      '<table class="doc-table"><thead><tr><th>Subject</th><th class="num">Marks</th></tr></thead>' +
      '<tfoot><tr><td>TOTAL</td><td class="num">10</td></tr></tfoot></table></div></div>';
  } else if (mode === 'table-empty') {
    inner = '<div class="doc-stage"><div class="paper">' +
      '<table class="doc-table"><thead><tr><th>Subject</th><th class="num">Marks</th></tr></thead>' +
      '<tbody><tr><td>&nbsp;</td><td class="num">1</td></tr></tbody></table></div></div>';
  } else if (mode === 'signs') {
    inner = '<div class="doc-stage"><div class="paper"><div class="doc-signs">' +
      '<div class="sign"><div class="line">Teacher</div></div>' +
      '<div class="sign"><div class="line">Parent</div></div>' +
      '<div class="sign"><div class="line">Principal</div></div></div></div></div>';
  } else if (mode.startsWith('parts')) {
    // Bisects the report card: "parts3" renders only the first N child blocks
    // of the real card, to find which one spills onto a second page.
    const n = parseInt(mode.replace('parts', ''), 10) || 0;
    const card = cardsHtmlFor(SCENARIOS['1card-1']);
    // Split the card's direct children and keep only the first n.
    const parts = card.split(/(?=<div class="report-head"|<div class="report-heading"|<div class="report-info"|<table class="doc-table"|<div class="report-summary"|<div class="remark-box"|<div class="doc-signs"|<div class="grade-legend")/);
    parts[0] = '<div class="paper">';
    let trimmed = parts.slice(0, n + 1).join('');
    if (trimmed.slice(-7) !== '</div>') trimmed += '</div>';
    inner = '<div class="doc-stage">' + trimmed + '</div>';
  } else {
    throw new Error('Unknown probe mode: ' + mode);
  }

  fs.mkdirSync(TMP, { recursive: true });
  const tmp = path.join(TMP, 'probe-' + process.pid + '.html');
  fs.writeFileSync(tmp, wrap(inner), 'utf8');

  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 1600,
    webPreferences: { contextIsolation: true },
  });

  try {
    await win.loadURL(url.pathToFileURL(tmp).href);
    await new Promise((r) => setTimeout(r, 400));
    return await win.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      margins: { marginType: 'default' },
    });
  } finally {
    if (!win.isDestroyed()) win.destroy();
    fs.unlinkSync(tmp);
  }
}

/**
 * Diagnostic: renders one card and reports, from inside the renderer, how tall
 * each block is compared with the printable A4 height. This is what identifies
 * which element spills onto page two.
 */
async function measureOneCard(cardsHtml) {
  // The print rules live inside @media print, so the screen DOM reports zero
  // for every block. `webContents.printToPDF` can switch emulation to print
  // media, which makes the real print geometry measurable in the DOM.
  const html = [
    '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" />',
    readStyles(),
    '</head><body>',
    '<div id="printRoot" class="print-root no-print" data-print="report">',
    '<div class="doc-stage">' + cardsHtml + '</div></div>',
    '</body></html>',
  ].join('');

  fs.mkdirSync(TMP, { recursive: true });
  const tmp = path.join(TMP, 'measure-' + process.pid + '.html');
  fs.writeFileSync(tmp, html, 'utf8');

  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 1600,
    webPreferences: { contextIsolation: true },
  });

  try {
    await win.loadURL(url.pathToFileURL(tmp).href);
    await new Promise((r) => setTimeout(r, 400));
    win.webContents.enableDeviceEmulation({
      screenPosition: 'mobile',
      screenSize: { width: 794, height: 1123 }, // A4 @96dpi
      viewSize: { width: 794, height: 1123 },
      viewPosition: { x: 0, y: 0 },
      scale: 1,
    });
    // webContents has no setEmulatedMedia(); go through the debugger protocol.
    try {
      win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
        media: 'print',
      });
      await new Promise((r) => setTimeout(r, 400));
    } catch (e) {
      console.log('MEASURE (print emulation unavailable: ' + e.message + ')');
    }

    return await win.webContents.executeJavaScript(`
      (function () {
        var MM = 96 / 25.4;
        var pageH = (297 - 12 - 14) * MM;
        var paper = document.querySelector('.paper');
        var out = {
          printablePagePx: Math.round(pageH),
          paperHeight: paper ? Math.round(paper.getBoundingClientRect().height) : null,
          contentTotal: 0,
          blocks: []
        };
        if (paper) {
          for (var i = 0; i < paper.children.length; i++) {
            var el = paper.children[i];
            var cs = getComputedStyle(el);
            var h = el.getBoundingClientRect().height +
              parseFloat(cs.marginTop) + parseFloat(cs.marginBottom);
            out.contentTotal += h;
            out.blocks.push({
              cls: el.className || el.tagName.toLowerCase(),
              h: Math.round(h)
            });
          }
          out.contentTotal = Math.round(out.contentTotal);
        }
        return out;
      })()
    `, true);
  } finally {
    if (!win.isDestroyed()) win.destroy();
    fs.unlinkSync(tmp);
  }
}

/** Builds the card markup for a scenario using the real reportCard(). */
function cardsHtmlFor(spec) {
  const reportCard = buildReportCardFn();
  const cards = makeCards(spec.cards, spec.subs || SUBJECTS.length);
  const sep = spec.separator ? PAGE_BREAK : '';
  return cards.map((c) => reportCard(c)).join(sep);
}

async function main() {
  const key = process.argv[2];
  if (!key) {
    console.log('Scenarios: ' + Object.keys(SCENARIOS).join(', '));
    console.log('Usage: npx electron tools/print-page-test.js <scenario|probe-*>');
    app.exit(0);
    return;
  }

  // Diagnostics run before scenario validation: they are not scenarios.
  if (key === 'measure') {
    const m = await measureOneCard(cardsHtmlFor(SCENARIOS['1card-8']));
    console.log('MEASURE ' + JSON.stringify(m, null, 2));
    return;
  }
  if (key.startsWith('probe-')) {
    const pdf = await renderProbe(key.replace('probe-', ''));
    console.log('RESULT|' + key + '|pages=' + countPdfPages(pdf));
    return;
  }

  const spec = SCENARIOS[key];
  if (!spec) {
    console.log('Unknown scenario: ' + key);
    app.exit(1);
    return;
  }

  const pdf = await renderPdf(cardsHtmlFor(spec));
  const pages = countPdfPages(pdf);
  const out = path.join(os.tmpdir(), 'campuscore-print-' + key + '.pdf');
  fs.writeFileSync(out, pdf);

  console.log(
    'RESULT|' + key + '|cards=' + spec.cards + '|pages=' + pages +
    '|perCard=' + (pages / spec.cards).toFixed(2) + '|' + out,
  );
}

app.whenReady()
  .then(main)
  .then(() => app.exit(0))
  .catch((err) => {
    console.error('Harness error:', err && err.stack ? err.stack : err);
    app.exit(1);
  });

