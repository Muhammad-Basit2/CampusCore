const fs = require('fs');
let html = fs.readFileSync('C:/Users/Basit/Desktop/CampusCore/src/renderer/index.html', 'utf8');
var idx1 = html.indexOf('<button class= nav-item data-view=classes');
if (idx1 >= 0) {
  var before = html.substring(0, idx1);
  var after = html.substring(idx1);
  var newItems = '<button class=\nav-item\ data-view=\teachers\ role=\tab\ aria-selected=\false\>\n            <span class=\nav-ico\>&#128104;</span>\n            <span class=\nav-label\>Teachers</span>\n            <kbd>Ctrl+T</kbd>\n          </button>\n          <button class=\nav-item\ data-view=\teacher-attendance\ role=\tab\ aria-selected=\false\>\n            <span class=\nav-ico\>&#128197;</span>\n            <span class=\nav-label\>Teacher Attendance</span>\n            <kbd>Ctrl+Y</kbd>\n          </button>\n          <button class=\nav-item\ data-view=\payroll\ role=\tab\ aria-selected=\false\>\n            <span class=\nav-ico\>&#128176;</span>\n            <span class=\nav-label\>Teacher Payroll</span>\n            <kbd>Ctrl+P</kbd>\n          </button>\n          <button class=\nav-item\ data-view=\student-attendance\ role=\tab\ aria-selected=\false\>\n            <span class=\nav-ico\>&#128104;&#65039;</span>\n            <span class=\nav-label\>Student Attendance</span>\n            <kbd>Ctrl+A</kbd>\n          </button>\n';
  // Find where classes button ends
  var endIdx = html.indexOf('</button>', idx1) + '</button>'.length;
  html = html.substring(0, endIdx) + newItems + html.substring(endIdx);
}
var viewsIdx = html.indexOf('<section class=view id=view-classes');
if (viewsIdx >= 0) {
  var endViewsIdx = html.indexOf('</div>', viewsIdx);
  var newViews = '\n           <section class=\view\ id=\view-teachers\ data-view=\teachers\></section>\n           <section class=\view\ id=\view-teacher-attendance\ data-view=\teacher-attendance\></section>\n           <section class=\view\ id=\view-payroll\ data-view=\payroll\></section>\n           <section class=\view\ id=\view-student-attendance\ data-view=\student-attendance\></section>\n';
  html = html.substring(0, endViewsIdx) + newViews + html.substring(endViewsIdx);
}
fs.writeFileSync('C:/Users/Basit/Desktop/CampusCore/src/renderer/index.html', html, 'utf8');
console.log('Done');
