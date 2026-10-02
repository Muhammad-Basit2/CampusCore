/**
 * Diagnostic helper: reports per-line paren/brace/bracket balance while
 * correctly ignoring comments, string literals and template literals.
 * Usage: node tools/balance.js src/main/ipc.js
 */
'use strict';

const fs = require('fs');

const file = process.argv[2];
const src = fs.readFileSync(file, 'utf8');

let depth = { paren: 0, brace: 0, bracket: 0 };
const stack = [];
let line = 1;
let col = 0;
let i = 0;

const pairs = { ')': '(', ']': '[', '}': '{' };

function note(ch) {
  if (ch === '(') { depth.paren += 1; stack.push({ ch, line }); }
  else if (ch === '{') { depth.brace += 1; stack.push({ ch, line }); }
  else if (ch === '[') { depth.bracket += 1; stack.push({ ch, line }); }
  else if (ch in pairs) {
    if (!stack.length) {
      console.log(`UNMATCHED CLOSE ${ch} at line ${line}`);
      return;
    }
    const top = stack.pop();
    const expect = pairs[ch];
    if (top.ch !== expect) {
      console.log(`MISMATCH at line ${line}: found ${ch} but innermost open is ${top.ch} from line ${top.line}`);
    }
  }
}

while (i < src.length) {
  const ch = src[i];
  const next = src[i + 1];
  col += 1;

  if (ch === '\n') { line += 1; col = 0; i += 1; continue; }

  // line comment
  if (ch === '/' && next === '/') {
    while (i < src.length && src[i] !== '\n') i += 1;
    continue;
  }
  // block comment
  if (ch === '/' && next === '*') {
    i += 2;
    while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
      if (src[i] === '\n') { line += 1; col = 0; }
      i += 1;
    }
    i += 2;
    continue;
  }
  // template literal (may contain ${ } - we skip contents entirely)
  if (ch === '`') {
    i += 1;
    while (i < src.length && src[i] !== '`') {
      if (src[i] === '\\') i += 1;
      if (src[i] === '\n') { line += 1; col = 0; }
      i += 1;
    }
    i += 1;
    continue;
  }
  // string literal
  if (ch === '"' || ch === "'") {
    const quote = ch;
    i += 1;
    while (i < src.length && src[i] !== quote) {
      if (src[i] === '\\') i += 1;
      if (src[i] === '\n') { line += 1; col = 0; }
      i += 1;
    }
    i += 1;
    continue;
  }

  note(ch);
  i += 1;
}

console.log('final depth:', depth);
if (stack.length) {
  console.log(`UNCLOSED (${stack.length}):`);
  for (const s of stack) console.log(`  ${s.ch} opened at line ${s.line}`);
}
