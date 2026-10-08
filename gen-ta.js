const fs = require('fs');
const p = 'c:/Users/Basit/Desktop/CampusCore/src/renderer/js/teacher-attendance.js';
const c = fs.readFileSync(p, 'utf8');
console.log('current: ', c.length);