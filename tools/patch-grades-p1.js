const fs = require('fs');
let content = fs.readFileSync('src/renderer/js/grades.js', 'utf8');
if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);

const idxStart = content.indexOf('async renderSubjects(body)');
const idxEnd = content.indexOf('/* TAB: RESULTS');

console.log('Start:', idxStart, 'End:', idxEnd, 'Length:', content.length);

const newCode = 