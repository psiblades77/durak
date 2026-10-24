const fs = require('fs');
const html = fs.readFileSync('public/index.html', 'utf8');
const lines = html.split('\n');
lines.forEach((l, i) => {
  if (l.includes('g.turn') || l.includes('turn === me') || l.includes('turn === 0')) {
    console.log(i + 1, l.trim());
  }
});

