const fs = require('fs');
const code = fs.readFileSync('server.js', 'utf8');
const lines = code.split('\n');
lines.forEach((l, i) => {
  if (l.includes('1 - p') || l.includes('1 - color')) {
    console.log(i + 1, l.trim());
  }
});

