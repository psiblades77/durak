const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');

const MIME = { '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((req, res) => {
  const m = req.url.split('?')[0].match(/^\/icons\/([\w.-]+)$/);
  const file = m ? path.join('icons', m[1]) : 'index.html';
  fs.readFile(path.join(__dirname, 'public', file), (e, d) => {
    res.writeHead(e ? (m ? 404 : 500) : 200, { 'Content-Type': m ? (MIME[path.extname(file)] || 'application/octet-stream') : 'text/html; charset=utf-8' });
    res.end(d);
  });
});
const wss = new WebSocketServer({ server: srv });
const rooms = new Map();
const KINDS = ['durak', 'ttt', 'c4', 'rps', 'wd', 'pk', 'pt'];

function newGame(k) {
  if (k === 'durak') return newDurak();
  if (k === 'ttt') return { b: Array(9).fill(-1), turn: 0, winner: null, line: null };
  if (k === 'c4') return { b: Array(42).fill(-1), turn: 0, winner: null, line: null };
  if (k === 'pt') return { phase: 'mode', mode: null, theme: null, imgs: [null, null], winner: null };
  if (k === 'wd') return { phase: 'who', setter: null, word: null, guesses: [], winner: null };
  if (k === 'pk') return { phase: 'prep', cats: [null, null], log: [], turn: 0, step: 'item', item: null, ans: null, guess: null, winner: null };
  return { picks: [null, null], wins: [0, 0], last: null, winner: null };
}

function line4(b, i, p) {
  const r = (i / 7) | 0, c = i % 7;
  for (const [dr, dc] of [[0,1],[1,0],[1,1],[1,-1]]) {
    const cells = [i];
    for (const s of [1, -1]) for (let k = 1; k < 4; k++) {
      const rr = r + dr * k * s, cc = c + dc * k * s;
      if (rr < 0 || rr > 5 || cc < 0 || cc > 6 || b[rr * 7 + cc] !== p) break;
      cells.push(rr * 7 + cc);
    }
    if (cells.length >= 4) return cells;
  }
  return null;
}

// ---------- Wordies ----------
const norm = s => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
const txt = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
function wdScore(word, guess) {
  const r = Array(word.length).fill(0), cnt = {};
  for (let i = 0; i < word.length; i++) {
    if (word[i] === ' ') r[i] = -1;
    else if (guess[i] === word[i]) r[i] = 2;
    else cnt[word[i]] = (cnt[word[i]] || 0) + 1;
  }
  for (let i = 0; i < word.length; i++) if (r[i] === 0 && cnt[guess[i]] > 0) { r[i] = 1; cnt[guess[i]]--; }
  return r; // 2 — на месте, 1 — есть в слове, 0 — нет, -1 — пробел
}
function moveWd(g, p, m) {
  if (g.phase === 'who' && m.t === 'wsetter') { g.setter = m.who === 'me' ? p : 1 - p; g.phase = 'set'; }
  else if (g.phase === 'set' && m.t === 'word' && p === g.setter) {
    const w = norm(m.w);
    if (w.length < 3 || w.length > 15 || !/^\p{L}+( \p{L}+)*$/u.test(w)) return 'Слово: 3–15 символов, только буквы и пробелы';
    g.word = w; g.phase = 'guess';
  } else if (g.phase === 'guess' && m.t === 'guess' && p !== g.setter) {
    const L = norm(m.w).replace(/ /g, ''), n = g.word.replace(/ /g, '').length;
    if (L.length !== n) return 'Нужно букв: ' + n;
    if (!/^\p{L}+$/u.test(L)) return 'Только буквы и пробелы';
    let k = 0;
    const gs = [...g.word].map(ch => ch === ' ' ? ' ' : L[k++]).join('');
    const r = wdScore(g.word, gs);
    g.guesses.push({ w: gs, r });
    if (r.every(x => x !== 0 && x !== 1)) { g.winner = p; g.phase = 'done'; }
    else if (g.guesses.length >= 6) { g.winner = g.setter; g.phase = 'done'; }
  }
}

// ---------- «Я иду в поход…» ----------
function movePk(g, p, m) {
  const o = 1 - p, t = txt(m.w, 40);
  if (m.t === 'giveup' && g.phase === 'play') { g.phase = 'done'; g.winner = -1; return; }
  if (g.phase === 'prep') {
    if (m.t === 'cat' && g.cats[p] === null) {
      if (!t) return 'Введите категорию';
      g.cats[p] = t;
      if (g.cats[o] !== null) { g.phase = 'play'; g.turn = 0; g.step = 'item'; }
    }
    return;
  }
  if (g.phase !== 'play') return;
  const mine = p === g.turn;
  if (g.step === 'item' && mine && m.t === 'item') {
    if (!t) return 'Введите предмет';
    g.item = t; g.log.push({ k: 'item', by: p, txt: t }); g.step = 'judge';
  } else if (g.step === 'judge' && !mine && m.t === 'judge') {
    g.ans = !!m.v; g.log.push({ k: 'ans', by: p, v: g.ans }); g.step = 'decide';
  } else if (g.step === 'decide' && mine && m.t === 'skip') { g.turn = o; g.step = 'item'; g.item = g.ans = null; }
  else if (g.step === 'decide' && mine && m.t === 'try') g.step = 'guess';
  else if (g.step === 'guess' && mine && m.t === 'pguess') {
    if (!t) return 'Введите догадку';
    g.guess = t; g.log.push({ k: 'guess', by: p, txt: t }); g.step = 'verify';
  } else if (g.step === 'verify' && !mine && m.t === 'verify') {
    g.log.push({ k: 'ver', by: p, v: !!m.v });
    if (m.v) { g.winner = g.turn; g.phase = 'done'; }
    else { g.turn = p; g.step = 'item'; g.item = g.ans = g.guess = null; }
  }
}

// ---------- Портреты ----------
const STYLES = ['киберпанк', 'аниме', 'пиксель-арт', 'комикс', 'стимпанк', 'мультфильм 90-х', 'фэнтези', 'ретро 80-х', 'поп-арт', 'ужастик', 'супергерой', 'викинг', 'космонавт', 'пират', 'самурай', 'вестерн'];
const TOPICS = ['бурундук', 'Президент', 'робот-повар', 'дракон', 'космический кот', 'ёжик в тумане', 'бабушка-супергерой', 'король пиццы', 'вампир-вегетарианец', 'сонный волшебник', 'ниндзя-официант', 'пингвин-директор'];
function movePt(g, p, m) {
  if (g.phase === 'mode' && m.t === 'pmode' && (m.mode === 'each' || m.mode === 'topic')) {
    const L = m.mode === 'each' ? STYLES : TOPICS;
    g.mode = m.mode; g.theme = L[(Math.random() * L.length) | 0]; g.phase = 'draw';
  } else if (g.phase === 'draw' && m.t === 'pimg' && g.imgs[p] === null) {
    if (typeof m.img !== 'string' || !m.img.startsWith('data:image/jpeg;base64,') || m.img.length > 1.5e6) return 'Рисунок не принят (слишком большой)';
    g.imgs[p] = m.img;
    if (g.imgs[1 - p] !== null) { g.phase = 'done'; g.winner = -1; }
  }
}

function move(room, p, m) {
  const g = room.g, k = room.kind;
  if (!g || g.winner !== null) return;
  if (k === 'durak') return moveDurak(room, p, m);
  if (k === 'wd') return moveWd(g, p, m);
  if (k === 'pk') return movePk(g, p, m);
  if (k === 'pt') return movePt(g, p, m);
  if (k === 'ttt' && m.t === 'cell') {
    if (g.turn !== p || g.b[m.i] !== -1) return;
    g.b[m.i] = p;
    const l = L3.find(l => l.every(i => g.b[i] === p));
    if (l) { g.winner = p; g.line = l; } else if (g.b.every(x => x >= 0)) g.winner = -1; else g.turn = 1 - p;
  } else if (k === 'c4' && m.t === 'col') {
    if (g.turn !== p || !Number.isInteger(m.c) || m.c < 0 || m.c > 6) return;
    let r = 5; while (r >= 0 && g.b[r * 7 + m.c] !== -1) r--;
    if (r < 0) return;
    const i = r * 7 + m.c; g.b[i] = p;
    const l = line4(g.b, i, p);
    if (l) { g.winner = p; g.line = l; } else if (g.b.every(x => x >= 0)) g.winner = -1; else g.turn = 1 - p;
  } else if (k === 'rps' && m.t === 'rps') {
    if (g.picks[p] !== null || ![0, 1, 2].includes(m.v)) return;
    g.picks[p] = m.v;
    if (g.picks[0] !== null && g.picks[1] !== null) {
      const [a, b] = g.picks, w = a === b ? -1 : (a - b + 3) % 3 === 1 ? 0 : 1;
      g.last = { p: [a, b], w };
      if (w >= 0 && ++g.wins[w] >= 3) g.winner = w;
      g.picks = [null, null];
    }
  }
}

// ---------- комнаты ----------
const clean = s => String(s || '').replace(/[<>&"'`]/g, '').trim().slice(0, 16);
const start = (room, k) => { room.kind = k; room.g = newGame(k); room.gid++; };

const gv = (room, p) => {
  const g = room.g;
  if (!g) return null;
  if (room.kind === 'durak') return {
    hand: g.hands[p], opp: g.hands[1 - p].length, deck: g.deck.length, trump: g.trump,
    tc: g.deck[0] || null, table: g.table, att: g.att, taking: g.taking, winner: g.winner,
  };
  if (room.kind === 'pt') return { phase: g.phase, mode: g.mode, theme: g.theme, done: g.imgs.map(x => x !== null), imgs: g.phase === 'done' ? g.imgs : null, winner: g.winner };
  if (room.kind === 'wd') return {
    phase: g.phase, setter: g.setter, pat: g.word ? g.word.replace(/\S/g, '•') : null, guesses: g.guesses,
    word: (g.winner !== null || p === g.setter) ? g.word : null, winner: g.winner,
  };
  if (room.kind === 'pk') return {
    phase: g.phase, ready: g.cats.map(c => c !== null), mine: g.cats[p], cats: g.winner !== null ? g.cats : null,
    log: g.log, turn: g.turn, step: g.step, item: g.item, ans: g.ans, guess: g.guess, winner: g.winner,
  };
  if (room.kind === 'rps') return { mine: g.picks[p], opp: g.picks[1 - p] !== null, last: g.last, wins: g.wins, winner: g.winner };
  return { b: g.b, turn: g.turn, winner: g.winner, line: g.line };
};
const view = (room, p) => ({
  t: 'state', me: p, code: room.code, peers: room.ids.map(Boolean), on: room.ws.map(Boolean),
  names: room.names, score: room.score, kind: room.kind, gid: room.gid, g: gv(room, p),
});
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
      else {
        room = { code: genCode(), ids: [null, null], names: ['', ''], ws: [null, null], kind: null, g: null, score: [0, 0], gid: 0, chat: [], last: Date.now() };
        rooms.set(room.code, room);
      }
      if (!room) return err(ws, 'Комната не найдена');
      const id = String(m.token || '');
      seat = room.ids.indexOf(id);
      if (seat < 0) seat = room.ids.indexOf(null);
      if (seat < 0) { room = null; return err(ws, 'В комнате уже двое игроков'); }
      room.ids[seat] = id;
      room.names[seat] = clean(m.name) || 'Игрок ' + (seat + 1);
      if (room.ws[seat] && room.ws[seat] !== ws) room.ws[seat].close();
      room.ws[seat] = ws;
      push(room);
      return ws.send(JSON.stringify({ t: 'chatlog', log: room.chat }));
    }
    if (!room) return;
    room.last = Date.now();
    if (m.t === 'chat') {
      const text = txt(m.text, 300);
      if (!text) return;
      const msg = { from: seat, name: room.names[seat], text, ts: Date.now() };
      room.chat.push(msg); if (room.chat.length > 100) room.chat.shift();
      return room.ws.forEach(w => w && w.readyState === 1 && w.send(JSON.stringify({ t: 'chat', m: msg })));
    }
    const fin = !!room.g && room.g.winner !== null;
    if (m.t === 'pick') {
      if (KINDS.includes(m.k) && room.ids[0] && room.ids[1] && (!room.g || fin)) start(room, m.k);
    } else if (m.t === 'menu') { room.kind = null; room.g = null; }
    else if (m.t === 'again') { if (fin) start(room, room.kind); }
    else if (room.g) {
      const was = room.g.winner;
      const e = move(room, seat, m);
      if (e) err(ws, e);
      if (was === null && room.g.winner !== null && room.g.winner >= 0) room.score[room.g.winner]++;
    }
    push(room);
  });
  ws.on('close', () => { if (room && room.ws[seat] === ws) { room.ws[seat] = null; push(room); } });
});

setInterval(() => {
  for (const [c, r] of rooms) if (Date.now() - r.last > 3600e3) rooms.delete(c);
}, 600e3);

srv.listen(process.env.PORT || 3000, () => console.log('Игры: http://localhost:' + (process.env.PORT || 3000)));
