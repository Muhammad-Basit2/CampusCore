/**
 * Renderer-side test for the Grades & Reports view.
 *
 * The smoke suite covers the main process only, so nothing exercised the
 * DOM the user actually clicks. This harness loads the real ui.js and
 * grades.js in a hidden Electron window, stubs window.api with fixture data
 * and drives the redesigned toolbar, grid, search and filters.
 *
 * Run with:  npx electron tools/grades-ui-test.js
 */
'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const HARNESS = path.join(__dirname, 'grades-ui-harness.html');

const failures = [];

async function run() {
  app.setPath('userData', path.join(__dirname, '..', '.ui-test-userdata'));
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  await app.whenReady();

  const win = new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: true,
    },
  });

  win.webContents.on('console-message', (_e, _level, message) => {
    if (/error/i.test(message)) console.log('  [renderer] ' + message);
  });

  await win.loadFile(HARNESS);

  // The assertions live inside the page so they touch the real DOM, then the
  // raw results are tallied here in Node. A throw inside the page loses its
  // stack across the process boundary, so it is captured in the page and
  // rethrown with that stack attached.
  const results = await win.webContents.executeJavaScript(`
    window.__run().catch((err) => {
      throw new Error((err && err.stack) || String(err));
    })
  `);

  let passed = 0;
  console.log('');
  for (const r of results) {
    if (r.ok) {
      passed++;
      console.log(`  PASS  ${r.name}${r.detail ? '  ->  ' + r.detail : ''}`);
    } else {
      failures.push(r.name);
      console.log(`  FAIL  ${r.name}${r.detail ? '  ->  ' + r.detail : ''}`);
    }
  }

  console.log('');
  console.log('================================================================');
  console.log(`RESULT: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('Failures:');
    failures.forEach((f) => console.log('  - ' + f));
  }
  console.log('================================================================');

  win.destroy();
  app.exit(failures.length ? 1 : 0);
}

run().catch((err) => {
  console.error('HARNESS CRASHED:', err);
  app.exit(1);
});