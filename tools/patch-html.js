const fs = require('fs');
const c = fs.readFileSync('C:/Users/Basit/Desktop/CampusCore/src/renderer/index.html', 'utf8');
// Fix: view-classes needs </section> before the new sections
let fixed = c.replace('data-view="classes">\n          <section class="view" id="view-teachers"', 'data-view="classes"></section>\n          <section class="view" id="view-teachers"');
fs.writeFileSync('C:/Users/Basit/Desktop/CampusCore/src/renderer/index.html', fixed);
console.log('fixed');
