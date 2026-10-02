/**
 * Small exact-string patcher used during development.
 *
 * The repo mixes CRLF and LF files and some carry a UTF-8 BOM, so naive
 * replacements silently fail to match. This normalises to a plain string,
 * applies exact replacements, and writes back with the file's original
 * encoding/line-ending style.
 *
 * Usage: node tools/patch-file.js <file> <patch.json>
 * Patch JSON: [{ "find": "...", "replace": "..." }, ...]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const [, , target, patchPath] = process.argv;
if (!target || !patchPath) {
  console.error('usage: node tools/patch-file.js <file> <patch.json>');
  process.exit(2);
}

const abs = path.resolve(target);
const raw = fs.readFileSync(abs);
const hadBom = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
let text = raw.toString('utf8');
if (hadBom) text = text.slice(1);

const crlf = /\r\n/.test(text);
const patches = JSON.parse(fs.readFileSync(patchPath, 'utf8'));

let applied = 0;
// Normalise the file to LF for matching, then restore its original style on
// write. Both sides must be normalised or CRLF files never match.
const useCrlf = /\r\n/.test(text);
text = text.replace(/\r\n/g, '\n');

for (const p of patches) {
  const find = p.find.replace(/\r\n/g, '\n');
  const replace = p.replace.replace(/\r\n/g, '\n');
  // Count occurrences so we never silently edit the wrong spot.
  const parts = text.split(find);
  if (parts.length - 1 !== 1) {
    console.error(
      `FAIL ${abs}: expected exactly 1 match, found ${parts.length - 1} for:\n${find.slice(0, 160)}`,
    );
    process.exit(1);
  }
  text = parts.join(replace);
  applied += 1;
}

let out = text;
if (useCrlf) out = out.replace(/\n/g, '\r\n');
fs.writeFileSync(
  abs,
  Buffer.concat([
    hadBom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0),
    Buffer.from(out, 'utf8'),
  ]),
);
console.log(`OK ${abs} (${applied} patch(es), ${useCrlf ? 'CRLF' : 'LF'}${hadBom ? ', BOM' : ''})`);
