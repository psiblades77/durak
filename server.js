const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.ico': 'image/x-icon'
};

const srv = http.createServer((req, res) => {
  // Security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end('Method Not Allowed');
  }

  const pubDir = path.resolve(__dirname, 'public');
  let safeRel = 'index.html';

  try {
    const rawPath = req.url.split('?')[0];
    const decoded = decodeURIComponent(rawPath);
    const normalized = path.normalize(decoded).replace(/^([/\\]|\.\.[/\\])+/, '');
    if (normalized && normalized !== '.') safeRel = normalized;
  } catch (_) {
    res.writeHead(400);
    return res.end('Bad Request');
  }

  let filePath = path.resolve(pubDir, safeRel);
  if (!filePath.startsWith(pubDir + path.sep) && filePath !== pubDir) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      filePath = path.join(pubDir, 'index.html');
    }
    fs.readFile(filePath, (e, d) => {
      if (e) {
        res.writeHead(500);
        return res.end('Error loading asset');
      }
      const ext = path.extname(filePath);
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400'
      });
      res.end(d);
    });
  });
});

// WebSocket Server with strict payload size limit (2 MB) to prevent OOM attacks
const wss = new WebSocketServer({ server: srv, maxPayload: 2 * 1024 * 1024 });
const rooms = new Map();
const mmQueue = []; // Matchmaking queue: [{ ws, token, name, time }]

const KINDS = ['durak', 'ttt', 'c4', 'rps', 'wd', 'pk', 'pt', 'memo', 'dots'];
const BOT_KINDS = ['durak', 'ttt', 'c4', 'rps'];
const L3 = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];

function broadcastOnline() {
  const msg = JSON.stringify({ t: 'online', count: wss.clients.size });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------- Дурак ----------
function newDurak() {
  const deck = [];
  for (let s = 0; s < 4; s++) {
    for (let r = 6; r <= 14; r++) deck.push({ r, s });
  }
  shuffle(deck);
  const trump = deck[0].s;
  const hands = [[], []];
  for (let i = 0; i < 6; i++) {
    hands[0].push(deck.pop());
    hands[1].push(deck.pop());
  }
  let att = 0, minTr = 99;
  for (let p = 0; p < 2; p++) {
    for (const c of hands[p]) {
      if (c.s === trump && c.r < minTr) {
        minTr = c.r;
        att = p;
      }
    }
  }
  return {
    deck,
    trump,
    hands,
    table: [],
    att,
    taking: false,
    winner: null
  };
}

function moveDurak(room, p, m) {
  const g = room.g;
  if (!g || g.winner !== null) return;
  const tr = g.trump;
  const beats = (a, c) => (c.s === a.s && c.r > a.r) || (c.s === tr && a.s !== tr);

  if (m.t === 'card') {
    if (!Number.isInteger(m.r) || !Number.isInteger(m.s)) return 'Неверная карта';
    const hand = g.hands[p];
    const idx = hand.findIndex(c => c.r === m.r && c.s === m.s);
    if (idx < 0) return 'Карты нет в руке';
    const card = hand[idx];

    if (p === g.att) {
      if (g.table.length >= 6) return 'Максимум 6 карт на столе';
      const defHandLen = g.hands[1 - p].length;
      const undefended = g.table.filter(x => !x.d).length;
      if (undefended >= defHandLen && !g.taking) return 'У соперника недостаточно карт';

      if (g.table.length === 0) {
        hand.splice(idx, 1);
        g.table.push({ a: card, d: null });
      } else {
        const canToss = g.table.some(x => x.a.r === card.r || (x.d && x.d.r === card.r));
        if (!canToss) return 'Нельзя подкинуть эту карту';
        hand.splice(idx, 1);
        g.table.push({ a: card, d: null });
      }
    } else {
      if (g.taking) return 'Вы уже берете карты';
      const target = g.table.find(x => !x.d);
      if (!target) return 'Нечего отбивать';
      if (!beats(target.a, card)) return 'Карта не бьет';
      hand.splice(idx, 1);
      target.d = card;
    }
  } else if (m.t === 'take' && p !== g.att) {
    if (!g.table.length || g.taking) return;
    g.taking = true;
  } else if (m.t === 'done' && p === g.att) {
    if (!g.table.length) return;
    if (g.taking) {
      const def = 1 - g.att;
      for (const pair of g.table) {
        g.hands[def].push(pair.a);
        if (pair.d) g.hands[def].push(pair.d);
      }
      g.table = [];
      g.taking = false;
    } else {
      if (g.table.some(x => !x.d)) return 'Сначала отбейте все карты';
      g.table = [];
      g.att = 1 - g.att;
    }
    const order = [g.att === 0 ? 1 : 0, g.att === 0 ? 0 : 1];
    for (const pl of order) {
      while (g.hands[pl].length < 6 && g.deck.length > 0) {
        g.hands[pl].push(g.deck.pop());
      }
    }
  }

  if (g.deck.length === 0) {
    const p0Empty = g.hands[0].length === 0;
    const p1Empty = g.hands[1].length === 0;
    if (p0Empty && p1Empty) g.winner = -1;
    else if (p0Empty) g.winner = 0;
    else if (p1Empty) g.winner = 1;
  }
}

// ---------- 4 в ряд ----------
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
const txt = (s, n) => String(s || '').replace(/[\u0000-\u001F\u007F-\u009F]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);

function wdScore(word, guess) {
  const r = Array(word.length).fill(0), cnt = {};
  for (let i = 0; i < word.length; i++) {
    if (word[i] === ' ') r[i] = -1;
    else if (guess[i] === word[i]) r[i] = 2;
    else cnt[word[i]] = (cnt[word[i]] || 0) + 1;
  }
  for (let i = 0; i < word.length; i++) if (r[i] === 0 && cnt[guess[i]] > 0) { r[i] = 1; cnt[guess[i]]--; }
  return r;
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

// ---------- Портреты (Safe Base64 Validation) ----------
const STYLES = ['киберпанк', 'аниме', 'пиксель-арт', 'комикс', 'стимпанк', 'мультфильм 90-х', 'фэнтези', 'ретро 80-х', 'поп-арт', 'ужастик', 'супергерой', 'викинг', 'космонавт', 'пират', 'самурай', 'вестерн'];
const TOPICS = ['бурундук', 'Президент', 'робот-повар', 'дракон', 'космический кот', 'ёжик в тумане', 'бабушка-супергерой', 'король пиццы', 'вампир-вегетарианец', 'сонный волшебник', 'ниндзя-официант', 'пингвин-директор'];
const BASE64_JPEG_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/;

function movePt(g, p, m) {
  if (g.phase === 'mode' && m.t === 'pmode' && (m.mode === 'each' || m.mode === 'topic')) {
    const L = m.mode === 'each' ? STYLES : TOPICS;
    g.mode = m.mode; g.theme = L[(Math.random() * L.length) | 0]; g.phase = 'draw';
  } else if (g.phase === 'draw' && m.t === 'pimg' && g.imgs[p] === null) {
    if (typeof m.img !== 'string' || !BASE64_JPEG_RE.test(m.img) || m.img.length > 1.5e6) {
      return 'Рисунок не принят';
    }
    g.imgs[p] = m.img;
    if (g.imgs[1 - p] !== null) { g.phase = 'done'; g.winner = -1; }
  }
}

// ---------- Новый режим 1: Мемори ----------
const MEMO_ICONS = ['💎', '🚀', '🔥', '👑', '⚡', '🍀', '🍕', '🦄'];
function newMemo() {
  const cards = shuffle([...MEMO_ICONS, ...MEMO_ICONS]);
  return {
    cards,
    opened: [],
    matched: Array(16).fill(-1),
    scores: [0, 0],
    turn: 0,
    closing: false,
    winner: null
  };
}

function moveMemo(room, p, m) {
  const g = room.g;
  if (!g || g.winner !== null || g.closing) return;
  if (m.t === 'flip' && g.turn === p) {
    const i = m.i;
    if (!Number.isInteger(i) || i < 0 || i >= 16) return;
    if (g.matched[i] !== -1 || g.opened.includes(i) || g.opened.length >= 2) return;

    g.opened.push(i);
    if (g.opened.length === 2) {
      const [i1, i2] = g.opened;
      if (g.cards[i1] === g.cards[i2]) {
        g.matched[i1] = p;
        g.matched[i2] = p;
        g.scores[p]++;
        g.opened = [];
        if (g.matched.every(x => x >= 0)) {
          g.winner = g.scores[0] > g.scores[1] ? 0 : g.scores[1] > g.scores[0] ? 1 : -1;
        }
      } else {
        g.closing = true;
        push(room);
        setTimeout(() => {
          if (room.g === g) {
            g.opened = [];
            g.turn = 1 - p;
            g.closing = false;
            push(room);
            if (room.isBot && g.turn === 1) scheduleBotMove(room);
          }
        }, 1100);
        return;
      }
    }
  }
}

// ---------- Новый режим 2: Точки и линии ----------
function newDots() {
  return {
    lines: Array(24).fill(-1),
    boxes: Array(9).fill(-1),
    scores: [0, 0],
    turn: 0,
    winner: null
  };
}

function moveDots(room, p, m) {
  const g = room.g;
  if (!g || g.winner !== null) return;
  if (m.t === 'line' && g.turn === p) {
    const i = m.i;
    if (!Number.isInteger(i) || i < 0 || i >= 24) return;
    if (g.lines[i] !== -1) return;

    g.lines[i] = p;
    let completedBox = false;

    for (let br = 0; br < 3; br++) {
      for (let bc = 0; bc < 3; bc++) {
        const bi = br * 3 + bc;
        if (g.boxes[bi] !== -1) continue;
        const top = br * 3 + bc;
        const bottom = (br + 1) * 3 + bc;
        const left = 12 + br * 4 + bc;
        const right = 12 + br * 4 + (bc + 1);

        if (g.lines[top] >= 0 && g.lines[bottom] >= 0 && g.lines[left] >= 0 && g.lines[right] >= 0) {
          g.boxes[bi] = p;
          g.scores[p]++;
          completedBox = true;
        }
      }
    }

    if (completedBox) {
      if (g.boxes.every(x => x >= 0)) {
        g.winner = g.scores[0] > g.scores[1] ? 0 : g.scores[1] > g.scores[0] ? 1 : -1;
      }
    } else {
      g.turn = 1 - p;
    }
  }
}

// ---------- Инициализация игр ----------
function newGame(k) {
  if (k === 'durak') return newDurak();
  if (k === 'ttt') return { b: Array(9).fill(-1), turn: 0, winner: null, line: null };
  if (k === 'c4') return { b: Array(42).fill(-1), turn: 0, winner: null, line: null };
  if (k === 'rps') return { picks: [null, null], wins: [0, 0], last: null, winner: null };
  if (k === 'memo') return newMemo();
  if (k === 'dots') return newDots();
  if (k === 'pt') return { phase: 'mode', mode: null, theme: null, imgs: [null, null], winner: null };
  if (k === 'wd') return { phase: 'who', setter: null, word: null, guesses: [], winner: null };
  if (k === 'pk') return { phase: 'prep', cats: [null, null], log: [], turn: 0, step: 'item', item: null, ans: null, guess: null, winner: null };
  return null;
}

// ---------- Общий обработчик хода ----------
function move(room, p, m) {
  const g = room.g, k = room.kind;
  if (!g || g.winner !== null) return;
  if (k === 'durak') return moveDurak(room, p, m);
  if (k === 'memo') return moveMemo(room, p, m);
  if (k === 'dots') return moveDots(room, p, m);
  if (k === 'wd') return moveWd(g, p, m);
  if (k === 'pk') return movePk(g, p, m);
  if (k === 'pt') return movePt(g, p, m);

  if (k === 'ttt' && m.t === 'cell') {
    if (g.turn !== p || !Number.isInteger(m.i) || m.i < 0 || m.i > 8 || g.b[m.i] !== -1) return;
    g.b[m.i] = p;
    const l = L3.find(line => line.every(i => g.b[i] === p));
    if (l) { g.winner = p; g.line = l; }
    else if (g.b.every(x => x >= 0)) g.winner = -1;
    else g.turn = 1 - p;
  } else if (k === 'c4' && m.t === 'col') {
    if (g.turn !== p || !Number.isInteger(m.c) || m.c < 0 || m.c > 6) return;
    let r = 5; while (r >= 0 && g.b[r * 7 + m.c] !== -1) r--;
    if (r < 0) return;
    const i = r * 7 + m.c; g.b[i] = p;
    const l = line4(g.b, i, p);
    if (l) { g.winner = p; g.line = l; }
    else if (g.b.every(x => x >= 0)) g.winner = -1;
    else g.turn = 1 - p;
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

// ---------- Искусственный интеллект (AI) ----------
function scheduleBotMove(room, delay = 550) {
  if (!room.isBot || !room.g || room.g.winner !== null) return;
  setTimeout(() => {
    if (!room.isBot || !room.g || room.g.winner !== null) return;
    botStep(room);
  }, delay);
}

function botStep(room) {
  const g = room.g, k = room.kind;
  if (!g || g.winner !== null) return;

  if (k === 'durak') {
    const tr = g.trump;
    const beats = (a, c) => (c.s === a.s && c.r > a.r) || (c.s === tr && a.s !== tr);
    const hand = g.hands[1];

    if (g.att === 1) {
      if (g.table.length === 0) {
        const nonTr = hand.filter(c => c.s !== tr).sort((a, b) => a.r - b.r);
        const card = nonTr[0] || [...hand].sort((a, b) => a.r - b.r)[0];
        if (card) {
          move(room, 1, { t: 'card', r: card.r, s: card.s });
          push(room);
        }
      } else {
        const allBeaten = !g.table.some(x => !x.d);
        if (allBeaten || g.taking) {
          const matching = hand.filter(c => g.table.some(x => x.a.r === c.r || (x.d && x.d.r === c.r)));
          const lowToss = matching.filter(c => c.s !== tr).sort((a, b) => a.r - b.r)[0];
          if (lowToss && g.table.length < 6) {
            move(room, 1, { t: 'card', r: lowToss.r, s: lowToss.s });
            push(room);
            scheduleBotMove(room, 600);
          } else {
            move(room, 1, { t: 'done' });
            push(room);
            scheduleBotMove(room, 600);
          }
        }
      }
    } else {
      if (g.taking) return;
      const target = g.table.find(x => !x.d);
      if (target) {
        const legal = hand.filter(c => beats(target.a, c));
        legal.sort((a, b) => {
          if (a.s === tr && b.s !== tr) return 1;
          if (a.s !== tr && b.s === tr) return -1;
          return a.r - b.r;
        });
        if (legal.length > 0) {
          const card = legal[0];
          move(room, 1, { t: 'card', r: card.r, s: card.s });
          push(room);
          scheduleBotMove(room, 600);
        } else {
          move(room, 1, { t: 'take' });
          push(room);
        }
      }
    }
  } else if (k === 'ttt' && g.turn === 1) {
    for (let i = 0; i < 9; i++) {
      if (g.b[i] === -1) {
        g.b[i] = 1;
        const win = L3.some(line => line.every(idx => g.b[idx] === 1));
        g.b[i] = -1;
        if (win) { move(room, 1, { t: 'cell', i }); push(room); return; }
      }
    }
    for (let i = 0; i < 9; i++) {
      if (g.b[i] === -1) {
        g.b[i] = 0;
        const win = L3.some(line => line.every(idx => g.b[idx] === 0));
        g.b[i] = -1;
        if (win) { move(room, 1, { t: 'cell', i }); push(room); return; }
      }
    }
    if (g.b[4] === -1) { move(room, 1, { t: 'cell', i: 4 }); push(room); return; }
    const corners = [0, 2, 6, 8].filter(i => g.b[i] === -1);
    if (corners.length) {
      move(room, 1, { t: 'cell', i: corners[(Math.random() * corners.length) | 0] });
      push(room);
      return;
    }
    const empty = g.b.map((v, i) => v === -1 ? i : null).filter(x => x !== null);
    if (empty.length) {
      move(room, 1, { t: 'cell', i: empty[(Math.random() * empty.length) | 0] });
      push(room);
    }
  } else if (k === 'c4' && g.turn === 1) {
    const validCols = [];
    for (let c = 0; c < 7; c++) if (g.b[c] === -1) validCols.push(c);
    if (!validCols.length) return;

    for (const c of validCols) {
      let r = 5; while (r >= 0 && g.b[r * 7 + c] !== -1) r--;
      if (r >= 0) {
        g.b[r * 7 + c] = 1;
        const win = !!line4(g.b, r * 7 + c, 1);
        g.b[r * 7 + c] = -1;
        if (win) { move(room, 1, { t: 'col', c }); push(room); return; }
      }
    }
    for (const c of validCols) {
      let r = 5; while (r >= 0 && g.b[r * 7 + c] !== -1) r--;
      if (r >= 0) {
        g.b[r * 7 + c] = 0;
        const win = !!line4(g.b, r * 7 + c, 0);
        g.b[r * 7 + c] = -1;
        if (win) { move(room, 1, { t: 'col', c }); push(room); return; }
      }
    }
    const pref = [3, 2, 4, 1, 5, 0, 6].filter(c => validCols.includes(c));
    move(room, 1, { t: 'col', c: pref[0] });
    push(room);
  } else if (k === 'rps') {
    if (g.picks[1] === null) {
      const v = (Math.random() * 3) | 0;
      move(room, 1, { t: 'rps', v });
      push(room);
    }
  }
}

// ---------- Комнаты и Состояние ----------
const clean = s => String(s || '').replace(/[\u0000-\u001F\u007F-\u009F<>&"'`]/g, '').trim().slice(0, 16);

const start = (room, k) => {
  room.kind = k;
  room.g = newGame(k);
  room.gid++;
  if (room.isBot) scheduleBotMove(room, 600);
};

const gv = (room, p) => {
  const g = room.g;
  if (!g) return null;
  if (room.kind === 'durak') return {
    hand: g.hands[p], opp: g.hands[1 - p].length, deck: g.deck.length, trump: g.trump,
    tc: g.deck[0] || null, table: g.table, att: g.att, taking: g.taking, winner: g.winner,
  };
  if (room.kind === 'memo') return {
    cards: g.cards.map((val, idx) => (g.opened.includes(idx) || g.matched[idx] >= 0) ? val : null),
    opened: g.opened,
    matched: g.matched,
    scores: g.scores,
    turn: g.turn,
    winner: g.winner
  };
  if (room.kind === 'dots') return {
    lines: g.lines,
    boxes: g.boxes,
    scores: g.scores,
    turn: g.turn,
    winner: g.winner
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
  t: 'state',
  me: p,
  code: room.code,
  peers: room.ids.map(Boolean),
  on: room.ws.map((w, idx) => room.isBot && idx === 1 ? true : Boolean(w)),
  names: room.names,
  score: room.score,
  kind: room.kind,
  gid: room.gid,
  isBot: !!room.isBot,
  g: gv(room, p),
});

const push = room => {
  room.ws.forEach((w, p) => {
    if (w && w.readyState === 1) w.send(JSON.stringify(view(room, p)));
  });
};

const err = (ws, m) => ws && ws.readyState === 1 && ws.send(JSON.stringify({ t: 'err', m }));
const genCode = () => {
  let c;
  do { c = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[(Math.random() * 24) | 0]).join(''); } while (rooms.has(c));
  return c;
};

wss.on('connection', ws => {
  let room = null, seat = -1;
  let msgCount = 0;
  let lastRateReset = Date.now();

  broadcastOnline();

  ws.on('message', raw => {
    // Anti-flood rate limiting: max 40 messages per 2 seconds
    const now = Date.now();
    if (now - lastRateReset > 2000) {
      msgCount = 0;
      lastRateReset = now;
    }
    msgCount++;
    if (msgCount > 40) return; // Drop flooded packets

    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (!m || typeof m !== 'object') return;

    // 1. Одиночный режим против ИИ
    if (m.t === 'bot_room') {
      if (rooms.size > 2500) return err(ws, 'Сервер временно перегружен');
      const code = genCode();
      const pName = clean(m.name) || 'Игрок';
      room = {
        code,
        ids: [clean(m.token) || Math.random().toString(36).slice(2), 'bot_ai'],
        names: [pName, 'ИИ Бот 🤖'],
        ws: [ws, null],
        kind: null,
        g: null,
        score: [0, 0],
        gid: 0,
        chat: [],
        last: Date.now(),
        isBot: true
      };
      seat = 0;
      rooms.set(code, room);
      push(room);
      return ws.send(JSON.stringify({ t: 'chatlog', log: room.chat }));
    }

    // 2. Матчмейкинг
    if (m.t === 'mm_join') {
      const token = clean(m.token);
      const pName = clean(m.name) || 'Игрок';

      // Prune stale queue entries (> 45s) or dead connections
      const curTime = Date.now();
      while (mmQueue.length && (curTime - mmQueue[0].time > 45000 || mmQueue[0].ws.readyState !== 1)) {
        mmQueue.shift();
      }

      const existingIdx = mmQueue.findIndex(q => q.token === token || q.ws === ws);
      if (existingIdx >= 0) mmQueue.splice(existingIdx, 1);

      if (mmQueue.length > 0) {
        const opp = mmQueue.shift();
        const code = genCode();
        room = {
          code,
          ids: [opp.token, token],
          names: [opp.name, pName],
          ws: [opp.ws, ws],
          kind: null,
          g: null,
          score: [0, 0],
          gid: 0,
          chat: [],
          last: Date.now(),
          isBot: false
        };
        rooms.set(code, room);
        seat = 1;
        push(room);
        ws.send(JSON.stringify({ t: 'mm_matched', code }));
        if (opp.ws.readyState === 1) opp.ws.send(JSON.stringify({ t: 'mm_matched', code }));
        return;
      } else {
        if (mmQueue.length < 100) {
          mmQueue.push({ ws, token, name: pName, time: curTime });
        }
        return ws.send(JSON.stringify({ t: 'mm_waiting' }));
      }
    }

    if (m.t === 'mm_leave') {
      const token = clean(m.token);
      const idx = mmQueue.findIndex(q => q.token === token || q.ws === ws);
      if (idx >= 0) mmQueue.splice(idx, 1);
      return ws.send(JSON.stringify({ t: 'mm_cancelled' }));
    }

    // 3. Стандартный вход / создание комнаты
    if (m.t === 'join') {
      const code = m.code ? String(m.code).toUpperCase().slice(0, 8) : null;
      if (code) {
        room = rooms.get(code);
      } else {
        if (rooms.size > 2500) return err(ws, 'Сервер перегружен');
        room = { code: genCode(), ids: [null, null], names: ['', ''], ws: [null, null], kind: null, g: null, score: [0, 0], gid: 0, chat: [], last: Date.now(), isBot: false };
        rooms.set(room.code, room);
      }
      if (!room) return err(ws, 'Комната не найдена');
      const id = clean(m.token) || Math.random().toString(36).slice(2);
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
      if (KINDS.includes(m.k) && room.ids[0] && room.ids[1] && (!room.g || fin)) {
        if (room.isBot && !BOT_KINDS.includes(m.k)) {
          return err(ws, 'Этот режим доступен только для двоих игроков');
        }
        start(room, m.k);
      }
    } else if (m.t === 'menu') {
      room.kind = null;
      room.g = null;
    } else if (m.t === 'again') {
      if (fin) start(room, room.kind);
    } else if (room.g) {
      const was = room.g.winner;
      const e = move(room, seat, m);
      if (e) err(ws, e);
      if (was === null && room.g.winner !== null && room.g.winner >= 0) room.score[room.g.winner]++;
      if (room.isBot) scheduleBotMove(room, 500);
    }
    push(room);
  });

  ws.on('close', () => {
    const qIdx = mmQueue.findIndex(q => q.ws === ws);
    if (qIdx >= 0) mmQueue.splice(qIdx, 1);

    if (room && room.ws[seat] === ws) {
      room.ws[seat] = null;
      push(room);
    }
    broadcastOnline();
  });
});

// Periodic cleanup of idle rooms
setInterval(() => {
  const now = Date.now();
  for (const [c, r] of rooms) {
    if (now - r.last > 2700e3) rooms.delete(c); // 45 minutes idle cleanup
  }
}, 300e3);

srv.listen(process.env.PORT || 3000, () => console.log('Игры: http://localhost:' + (process.env.PORT || 3000)));
