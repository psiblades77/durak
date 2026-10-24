const fs = require('fs');
const html = fs.readFileSync('public/index.html', 'utf8');
const lines = html.split('\n');
lines.forEach((l, i) => {
  if (l.includes("entry.k") || l.includes("x.k === 'ans'") || l.includes(".log.map")) {
    console.log(i + 1, l.trim());
  }
});

