const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');

const srv = http.createServer((req, res) => {
  fs.readFile(path.join(__dirname, 'public', 'index.html'), (e, d) => {
    res.writeHead(e ? 500 : 200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(d);
  });
});
const wss = new WebSocketServer({ server: srv });
const rooms = new Map();

// ---------- правила ----------
const beats = (a, d, t) => (d.s === a.s && d.r > a.r) || (d.s === t && a.s !== t);

function newGame() {
  const deck = [];
  for (let s = 0; s < 4; s++) for (let r = 6; r <= 14; r++) deck.push({ r, s });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  const g = { deck, hands: [[], []], table: [], taking: false, winner: null, trump: deck[0].s };
  for (let i = 0; i < 6; i++) { g.hands[0].push(deck.pop()); g.hands[1].push(deck.pop()); }
  const low = p => Math.min(99, ...g.hands[p].filter(c => c.s === g.trump).map(c => c.r));
  g.att = low(1) < low(0) ? 1 : 0; // первым ходит обладатель младшего козыря
  return g;
}

function canThrow(g) {
  const def = 1 - g.att, und = g.table.filter(x => !x.d).length;
  if (g.table.length >= 6 || und + 1 > g.hands[def].length) return false;
  return g.hands[g.att].some(c => g.table.some(x => x.a.r === c.r || (x.d && x.d.r === c.r)));
}

function finish(g) {
  const def = 1 - g.att;
  if (g.taking) g.table.forEach(x => { g.hands[def].push(x.a); if (x.d) g.hands[def].push(x.d); });
  g.table = [];
  for (const p of [g.att, def]) while (g.hands[p].length < 6 && g.deck.length) g.hands[p].push(g.deck.pop());
  if (!g.taking) g.att = def;
  g.taking = false;
  if (!g.deck.length) {
    const e0 = !g.hands[0].length, e1 = !g.hands[1].length;
    if (e0 && e1) g.winner = -1; else if (e0) g.winner = 0; else if (e1) g.winner = 1;
  }
}

function move(room, p, m) {
  const g = room.g;
  if (!g || g.winner !== null) return;
  const def = 1 - g.att, H = g.hands[p];
  if (m.t === 'card') {
    const i = H.findIndex(c => c.r === m.r && c.s === m.s);
    if (i < 0) return;
    const c = H[i];
    if (p === g.att) {
      if (g.table.length && !g.table.some(x => x.a.r === c.r || (x.d && x.d.r === c.r))) return;
      const und = g.table.filter(x => !x.d).length;
      if (g.table.length >= 6 || und + 1 > g.hands[def].length) return;
      H.splice(i, 1); g.table.push({ a: c, d: null });
    } else {
      if (g.taking) return;
      const k = g.table.findIndex(x => !x.d && beats(x.a, c, g.trump));
      if (k < 0) return;
      H.splice(i, 1); g.table[k].d = c;
    }
  } else if (m.t === 'take') {
    if (p !== def || g.taking || !g.table.some(x => !x.d)) return;
    g.taking = true;
  } else if (m.t === 'done') {
    if (p !== g.att || !g.table.length || (!g.taking && g.table.some(x => !x.d))) return;
    finish(g);
  } else return;
  // автозавершение, если подкидывать уже нечего
  if (g.winner === null && g.table.length && (g.taking || g.table.every(x => x.d)) && !canThrow(g)) finish(g);
}

// ---------- комнаты ----------
const view = (room, p) => {
  const g = room.g;
  return {
    t: 'state', me: p, code: room.code,
    peers: room.tok.map(Boolean), on: room.ws.map(Boolean),
    g: g && {
      hand: g.hands[p], opp: g.hands[1 - p].length, deck: g.deck.length, trump: g.trump,
      tc: g.deck[0] || null, table: g.table, att: g.att, taking: g.taking, winner: g.winner,
    },
  };
};
const push = room => room.ws.forEach((w, p) => w && w.readyState === 1 && w.send(JSON.stringify(view(room, p))));
const err = (ws, m) => ws.send(JSON.stringify({ t: 'err', m }));
const genCode = () => {
  let c;
  do { c = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[(Math.random() * 24) | 0]).join(''); } while (rooms.has(c));
  return c;
};

wss.on('connection', ws => {
  let room = null, seat = -1;
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'join') {
      const code = m.code ? String(m.code).toUpperCase() : null;
      if (code) room = rooms.get(code);
      else { room = { code: genCode(), tok: [null, null], ws: [null, null], g: null, last: Date.now() }; rooms.set(room.code, room); }
      if (!room) return err(ws, 'Комната не найдена');
      seat = room.tok.indexOf(m.token);
      if (seat < 0) seat = room.tok.indexOf(null);
      if (seat < 0) { room = null; return err(ws, 'В комнате уже двое игроков'); }
      room.tok[seat] = m.token;
      if (room.ws[seat] && room.ws[seat] !== ws) room.ws[seat].close();
      room.ws[seat] = ws;
      if (!room.g && room.tok[0] && room.tok[1]) room.g = newGame();
      push(room);
    } else if (room) {
      room.last = Date.now();
      if (m.t === 'again') { if (room.g && room.g.winner !== null) room.g = newGame(); }
      else move(room, seat, m);
      push(room);
    }
  });
  ws.on('close', () => { if (room && room.ws[seat] === ws) { room.ws[seat] = null; push(room); } });
});

setInterval(() => {
  for (const [c, r] of rooms) if (Date.now() - r.last > 3600e3) rooms.delete(c);
}, 600e3);

srv.listen(process.env.PORT || 3000, () => console.log('Дурак: http://localhost:' + (process.env.PORT || 3000)));
