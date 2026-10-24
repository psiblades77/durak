const fs = require('fs');
const html = fs.readFileSync('public/index.html', 'utf8');
const lines = html.split('\n');
lines.forEach((l, i) => {
  if (l.includes('chess_move') || (l.includes('from') && l.includes('to') && l.includes('send'))) {
    console.log(i + 1, l.trim());
  }
});

