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

const KINDS = ['durak', 'chess', 'ttt', 'c4', 'rps', 'wd', 'pk', 'pt', 'memo'];
const BOT_KINDS = ['durak', 'chess', 'ttt', 'c4', 'rps'];
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

function getActiveSeats(room) {
  const seats = [];
  for (let i = 0; i < room.ids.length; i++) {
    if (room.ids[i]) seats.push(i);
  }
  return seats;
}

function nextActiveSeat(room, currentSeat) {
  const n = room.ids.length;
  for (let step = 1; step <= n; step++) {
    const s = (currentSeat + step) % n;
    if (room.ids[s]) return s;
  }
  return currentSeat;
}

function nextDurakPlayer(room, currentSeat) {
  const g = room.g;
  const n = room.ids.length;
  for (let step = 1; step <= n; step++) {
    const s = (currentSeat + step) % n;
    if (room.ids[s] && (g.deck.length > 0 || (g.hands[s] && g.hands[s].length > 0))) {
      return s;
    }
  }
  return currentSeat;
}

function compactSeats(room) {
  if (!room || room.g) return;
  const active = [];
  for (let i = 0; i < room.ids.length; i++) {
    if (room.ids[i]) {
      active.push({
        id: room.ids[i],
        name: room.names[i],
        ws: room.ws[i],
        score: (room.score && room.score[i]) || 0
      });
    }
  }
  for (let i = 0; i < 4; i++) {
    if (i < active.length) {
      room.ids[i] = active[i].id;
      room.names[i] = active[i].name;
      room.ws[i] = active[i].ws;
      room.score[i] = active[i].score;
      if (active[i].ws) active[i].ws.seat = i;
    } else {
      room.ids[i] = null;
      room.names[i] = '';
      room.ws[i] = null;
      if (room.score) room.score[i] = 0;
    }
  }
}

// ---------- Дурак (2–4 игрока) ----------
function newDurak(room) {
  const activeSeats = room ? getActiveSeats(room) : [0, 1];
  const deck = [];
  for (let s = 0; s < 4; s++) {
    for (let r = 6; r <= 14; r++) deck.push({ r, s });
  }
  shuffle(deck);
  const trump = deck[0].s;
  const hands = Array.from({ length: 4 }, () => []);
  for (let i = 0; i < 6; i++) {
    for (const p of activeSeats) {
      if (deck.length > 0) hands[p].push(deck.pop());
    }
  }
  let att = activeSeats[0], minTr = 99;
  for (const p of activeSeats) {
    for (const c of hands[p]) {
      if (c.s === trump && c.r < minTr) {
        minTr = c.r;
        att = p;
      }
    }
  }
  const def = nextActiveSeat(room || { ids: [1, 1, 0, 0] }, att);
  return {
    deck,
    trump,
    hands,
    table: [],
    att,
    def,
    taking: false,
    winners: [],
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
    if (!hand) return 'Ошибка игрока';
    const idx = hand.findIndex(c => c.r === m.r && c.s === m.s);
    if (idx < 0) return 'Карты нет в руке';
    const card = hand[idx];

    if (p === g.def) {
      if (g.taking) return 'Вы уже берете карты';
      const target = g.table.find(x => !x.d);
      if (!target) return 'Нечего отбивать';
      if (!beats(target.a, card)) return 'Карта не бьет';
      hand.splice(idx, 1);
      target.d = card;
    } else {
      if (g.table.length >= 6) return 'Максимум 6 карт на столе';
      const defHand = g.hands[g.def];
      const defHandLen = defHand ? defHand.length : 0;
      const undefended = g.table.filter(x => !x.d).length;
      if (undefended >= defHandLen && !g.taking) return 'У защитника недостаточно карт';

      if (g.table.length === 0) {
        if (p !== g.att) return 'Первым ходит атакующий';
        hand.splice(idx, 1);
        g.table.push({ a: card, d: null });
      } else {
        const canToss = g.table.some(x => x.a.r === card.r || (x.d && x.d.r === card.r));
        if (!canToss) return 'Нельзя подкинуть эту карту';
        hand.splice(idx, 1);
        g.table.push({ a: card, d: null });
      }
    }
  } else if (m.t === 'take' && p === g.def) {
    if (!g.table.length || g.taking) return;
    g.taking = true;
  } else if (m.t === 'done' && p !== g.def) {
    if (!g.table.length) return;
    const oldAtt = g.att;
    const oldDef = g.def;
    const wasTaking = g.taking;

    if (wasTaking) {
      for (const pair of g.table) {
        g.hands[oldDef].push(pair.a);
        if (pair.d) g.hands[oldDef].push(pair.d);
      }
      g.table = [];
      g.taking = false;
    } else {
      if (g.table.some(x => !x.d)) return 'Сначала отбейте все карты';
      g.table = [];
    }

    const drawOrder = [];
    let cur = oldAtt;
    for (let step = 0; step < room.ids.length; step++) {
      if (room.ids[cur] && cur !== oldDef) drawOrder.push(cur);
      cur = (cur + 1) % room.ids.length;
    }
    if (room.ids[oldDef]) drawOrder.push(oldDef);

    for (const pl of drawOrder) {
      while (g.hands[pl] && g.hands[pl].length < 6 && g.deck.length > 0) {
        g.hands[pl].push(g.deck.pop());
      }
    }

    if (wasTaking) {
      const nextAtt = nextDurakPlayer(room, oldDef);
      g.att = nextAtt;
      g.def = nextDurakPlayer(room, nextAtt);
    } else {
      const defHasCards = (g.hands[oldDef] && g.hands[oldDef].length > 0) || g.deck.length > 0;
      const nextAtt = defHasCards ? oldDef : nextDurakPlayer(room, oldDef);
      g.att = nextAtt;
      g.def = nextDurakPlayer(room, nextAtt);
    }
  }

  // Check winners ONLY when table is cleared and deck is empty
  if (g.deck.length === 0 && g.table.length === 0) {
    for (let i = 0; i < room.ids.length; i++) {
      if (room.ids[i] && g.hands[i] && g.hands[i].length === 0 && !g.winners.includes(i)) {
        g.winners.push(i);
      }
    }
    const withCards = room.ids.map((id, idx) => id && g.hands[idx] && g.hands[idx].length > 0 ? idx : null).filter(x => x !== null);
    if (withCards.length <= 1) {
      if (withCards.length === 0) g.winner = -1;
      else g.winner = g.winners.length ? g.winners[0] : withCards[0];
    }
  }
}

// ---------- Шахматы ----------
function newChess() {
  const b = Array(64).fill(null);
  const back = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];
  for (let c = 0; c < 8; c++) {
    b[0 * 8 + c] = { t: back[c], c: 1 };
    b[1 * 8 + c] = { t: 'p', c: 1 };
    b[6 * 8 + c] = { t: 'p', c: 0 };
    b[7 * 8 + c] = { t: back[c], c: 0 };
  }
  return {
    b,
    turn: 0,
    castling: { wK: true, wQ: true, bK: true, bQ: true },
    ep: null,
    captured: { 0: [], 1: [] },
    last: null,
    inCheck: false,
    winner: null
  };
}

function getChessMoves(b, color, ep, castling) {
  const moves = [];
  const opp = 1 - color;
  for (let i = 0; i < 64; i++) {
    const p = b[i];
    if (!p || p.c !== color) continue;
    const r = (i / 8) | 0, c = i % 8;

    if (p.t === 'p') {
      const dir = color === 0 ? -1 : 1;
      const startRow = color === 0 ? 6 : 1;
      const r1 = r + dir;
      if (r1 >= 0 && r1 < 8 && !b[r1 * 8 + c]) {
        moves.push({ from: i, to: r1 * 8 + c });
        const r2 = r + dir * 2;
        if (r === startRow && !b[r2 * 8 + c]) {
          moves.push({ from: i, to: r2 * 8 + c });
        }
      }
      for (const dc of [-1, 1]) {
        const c1 = c + dc;
        if (r1 >= 0 && r1 < 8 && c1 >= 0 && c1 < 8) {
          const targetSq = r1 * 8 + c1;
          const target = b[targetSq];
          if (target && target.c === opp) {
            moves.push({ from: i, to: targetSq });
          } else if (targetSq === ep) {
            moves.push({ from: i, to: targetSq, ep: true });
          }
        }
      }
    } else if (p.t === 'n') {
      const jumps = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
      for (const [dr, dc] of jumps) {
        const rr = r + dr, cc = c + dc;
        if (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) {
          const sq = rr * 8 + cc, target = b[sq];
          if (!target || target.c === opp) moves.push({ from: i, to: sq });
        }
      }
    } else if (p.t === 'b' || p.t === 'r' || p.t === 'q') {
      const dirs = [];
      if (p.t === 'b' || p.t === 'q') dirs.push([-1,-1],[-1,1],[1,-1],[1,1]);
      if (p.t === 'r' || p.t === 'q') dirs.push([-1,0],[1,0],[0,-1],[0,1]);
      for (const [dr, dc] of dirs) {
        let rr = r + dr, cc = c + dc;
        while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) {
          const sq = rr * 8 + cc, target = b[sq];
          if (!target) {
            moves.push({ from: i, to: sq });
          } else {
            if (target.c === opp) moves.push({ from: i, to: sq });
            break;
          }
          rr += dr;
          cc += dc;
        }
      }
    } else if (p.t === 'k') {
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          const rr = r + dr, cc = c + dc;
          if (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) {
            const sq = rr * 8 + cc, target = b[sq];
            if (!target || target.c === opp) moves.push({ from: i, to: sq });
          }
        }
      }
      if (color === 0) {
        if (castling.wK && i === 60 && !b[61] && !b[62] && b[63] && b[63].t === 'r' && b[63].c === 0) {
          if (!isSquareAttacked(b, 60, opp) && !isSquareAttacked(b, 61, opp) && !isSquareAttacked(b, 62, opp)) {
            moves.push({ from: 60, to: 62, castling: 'K' });
          }
        }
        if (castling.wQ && i === 60 && !b[59] && !b[58] && !b[57] && b[56] && b[56].t === 'r' && b[56].c === 0) {
          if (!isSquareAttacked(b, 60, opp) && !isSquareAttacked(b, 59, opp) && !isSquareAttacked(b, 58, opp)) {
            moves.push({ from: 60, to: 58, castling: 'Q' });
          }
        }
      } else {
        if (castling.bK && i === 4 && !b[5] && !b[6] && b[7] && b[7].t === 'r' && b[7].c === 1) {
          if (!isSquareAttacked(b, 4, opp) && !isSquareAttacked(b, 5, opp) && !isSquareAttacked(b, 6, opp)) {
            moves.push({ from: 4, to: 6, castling: 'K' });
          }
        }
        if (castling.bQ && i === 4 && !b[3] && !b[2] && !b[1] && b[0] && b[0].t === 'r' && b[0].c === 1) {
          if (!isSquareAttacked(b, 4, opp) && !isSquareAttacked(b, 3, opp) && !isSquareAttacked(b, 2, opp)) {
            moves.push({ from: 4, to: 2, castling: 'Q' });
          }
        }
      }
    }
  }
  return moves;
}

function isSquareAttacked(b, sq, byColor) {
  const r = (sq / 8) | 0, c = sq % 8;
  const pDir = byColor === 0 ? 1 : -1;
  const pr = r + pDir;
  for (const pc of [c - 1, c + 1]) {
    if (pr >= 0 && pr < 8 && pc >= 0 && pc < 8) {
      const p = b[pr * 8 + pc];
      if (p && p.c === byColor && p.t === 'p') return true;
    }
  }
  for (const [dr, dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
    const rr = r + dr, cc = c + dc;
    if (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) {
      const p = b[rr * 8 + cc];
      if (p && p.c === byColor && p.t === 'n') return true;
    }
  }
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const rr = r + dr, cc = c + dc;
      if (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) {
        const p = b[rr * 8 + cc];
        if (p && p.c === byColor && p.t === 'k') return true;
      }
    }
  }
  for (const [dr, dc] of [[-1,-1],[-1,1],[1,-1],[1,1]]) {
    let rr = r + dr, cc = c + dc;
    while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) {
      const p = b[rr * 8 + cc];
      if (p) {
        if (p.c === byColor && (p.t === 'b' || p.t === 'q')) return true;
        break;
      }
      rr += dr; cc += dc;
    }
  }
  for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
    let rr = r + dr, cc = c + dc;
    while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) {
      const p = b[rr * 8 + cc];
      if (p) {
        if (p.c === byColor && (p.t === 'r' || p.t === 'q')) return true;
        break;
      }
      rr += dr; cc += dc;
    }
  }
  return false;
}

function applyChessMove(b, m) {
  const nextB = b.slice();
  const p = { ...nextB[m.from] };
  nextB[m.from] = null;
  if (m.ep) {
    const dir = p.c === 0 ? 1 : -1;
    nextB[m.to + dir * 8] = null;
  }
  if (m.castling === 'K') {
    if (p.c === 0) { nextB[61] = nextB[63]; nextB[63] = null; }
    else { nextB[5] = nextB[7]; nextB[7] = null; }
  } else if (m.castling === 'Q') {
    if (p.c === 0) { nextB[59] = nextB[56]; nextB[56] = null; }
    else { nextB[3] = nextB[0]; nextB[0] = null; }
  }
  const destR = (m.to / 8) | 0;
  if (p.t === 'p' && (destR === 0 || destR === 7)) {
    p.t = 'q';
  }
  nextB[m.to] = p;
  return nextB;
}

function getLegalChessMoves(g, color) {
  const pseudo = getChessMoves(g.b, color, g.ep, g.castling);
  const opp = 1 - color;
  const legal = [];
  for (const m of pseudo) {
    const nextB = applyChessMove(g.b, m);
    let kingSq = -1;
    for (let i = 0; i < 64; i++) {
      if (nextB[i] && nextB[i].c === color && nextB[i].t === 'k') {
        kingSq = i;
        break;
      }
    }
    if (kingSq !== -1 && !isSquareAttacked(nextB, kingSq, opp)) {
      legal.push(m);
    }
  }
  return legal;
}

function moveChess(room, p, m) {
  const g = room.g;
  if (!g || g.winner !== null || g.turn !== p) return;
  if (!Number.isInteger(m.from) || !Number.isInteger(m.to) || m.from < 0 || m.from >= 64 || m.to < 0 || m.to >= 64) return;

  const legal = getLegalChessMoves(g, p);
  const found = legal.find(x => x.from === m.from && x.to === m.to);
  if (!found) return 'Недопустимый ход';

  const destPiece = g.b[found.to];
  if (destPiece) {
    g.captured[p].push(destPiece.t);
  } else if (found.ep) {
    g.captured[p].push('p');
  }

  if (found.from === 60) { g.castling.wK = false; g.castling.wQ = false; }
  if (found.from === 4) { g.castling.bK = false; g.castling.bQ = false; }
  if (found.from === 63 || found.to === 63) g.castling.wK = false;
  if (found.from === 56 || found.to === 56) g.castling.wQ = false;
  if (found.from === 7 || found.to === 7) g.castling.bK = false;
  if (found.from === 0 || found.to === 0) g.castling.bQ = false;

  const movingPiece = g.b[found.from];
  if (movingPiece.t === 'p' && Math.abs(found.to - found.from) === 16) {
    g.ep = (found.from + found.to) / 2;
  } else {
    g.ep = null;
  }

  g.b = applyChessMove(g.b, found);
  g.last = { from: found.from, to: found.to };
  g.turn = 1 - p;

  let oppKing = -1;
  for (let i = 0; i < 64; i++) {
    if (g.b[i] && g.b[i].c === g.turn && g.b[i].t === 'k') { oppKing = i; break; }
  }
  g.inCheck = oppKing !== -1 && isSquareAttacked(g.b, oppKing, p);

  const oppLegal = getLegalChessMoves(g, g.turn);
  if (oppLegal.length === 0) {
    if (g.inCheck) g.winner = p;
    else g.winner = -1;
  }
}

function botChess(room) {
  const g = room.g;
  if (!g || g.winner !== null || g.turn !== 1) return;
  const legal = getLegalChessMoves(g, 1);
  if (!legal.length) return;

  const vals = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };
  let bestScore = -Infinity;
  let bestMoves = [];

  for (const m of legal) {
    let score = 0;
    const movingPiece = g.b[m.from];
    const target = g.b[m.to];

    if (target) {
      score += (vals[target.t] || 0) * 10 - (vals[movingPiece.t] || 0);
    } else if (m.ep) {
      score += 900;
    }

    const r = (m.to / 8) | 0, c = m.to % 8;
    const centerDist = Math.abs(r - 3.5) + Math.abs(c - 3.5);
    score += (7 - centerDist) * 4;

    if (movingPiece.t === 'p') score += r * 5;

    const nextB = applyChessMove(g.b, m);
    let wKing = -1;
    for (let i = 0; i < 64; i++) {
      if (nextB[i] && nextB[i].c === 0 && nextB[i].t === 'k') { wKing = i; break; }
    }
    if (wKing !== -1 && isSquareAttacked(nextB, wKing, 1)) {
      score += 45;
    }

    if (isSquareAttacked(nextB, m.to, 0)) {
      score -= (vals[movingPiece.t] || 0) * 1.5;
    }

    score += Math.random() * 8;

    if (score > bestScore) {
      bestScore = score;
      bestMoves = [m];
    } else if (Math.abs(score - bestScore) < 0.1) {
      bestMoves.push(m);
    }
  }

  const chosen = bestMoves[(Math.random() * bestMoves.length) | 0] || legal[0];
  applyMove(room, 1, { t: 'chess_move', from: chosen.from, to: chosen.to });
  push(room);
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

function moveWd(room, p, m) {
  const g = room.g;
  if (!g || g.winner !== null) return;
  const opp = nextActiveSeat(room, p);
  if (g.phase === 'who' && m.t === 'wsetter') { g.setter = m.who === 'me' ? p : opp; g.phase = 'set'; }
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

// ---------- «Я иду в поход…» (2–4 игрока) ----------
function movePk(room, p, m) {
  const g = room.g;
  if (!g || g.winner !== null) return;
  const activeCount = room.ids.filter(Boolean).length;
  const t = txt(m.w, 40);

  if (m.t === 'giveup' && g.phase === 'play') {
    g.phase = 'done';
    g.winner = -1;
    return;
  }

  if (g.phase === 'prep') {
    if (m.t === 'cat' && g.cats[p] === null) {
      if (!t) return 'Введите категорию';
      g.cats[p] = t;
      const allReady = room.ids.every((id, idx) => !id || g.cats[idx] !== null);
      if (allReady) {
        g.phase = 'play';
        const active = getActiveSeats(room);
        const first = active[0] ?? 0;
        g.turn = first;
        g.target = nextActiveSeat(room, first);
        g.step = 'item';
      }
    }
    return;
  }

  if (g.phase !== 'play') return;
  const mine = p === g.turn;

  if (g.step === 'item' && mine && m.t === 'item') {
    if (!t) return 'Введите предмет';
    let target;
    if (activeCount > 2) {
      if (Number.isInteger(m.target) && room.ids[m.target] && m.target !== p) {
        target = m.target;
      } else {
        target = nextActiveSeat(room, p);
      }
    } else {
      target = nextActiveSeat(room, p);
    }
    g.target = target;
    g.item = t;
    g.log.push({ k: 'item', by: p, target, txt: t });
    g.step = 'judge';
  } else if (g.step === 'judge' && p === g.target && m.t === 'judge') {
    g.ans = !!m.v;
    g.log.push({ k: 'ans', by: p, target: g.target, v: g.ans });
    g.step = 'decide';
  } else if (g.step === 'decide' && mine && m.t === 'skip') {
    g.turn = nextActiveSeat(room, p);
    g.target = nextActiveSeat(room, g.turn);
    g.step = 'item';
    g.item = g.ans = null;
  } else if (g.step === 'decide' && mine && m.t === 'try') {
    g.step = 'guess';
  } else if (g.step === 'guess' && mine && m.t === 'pguess') {
    if (!t) return 'Введите догадку';
    g.guess = t;
    g.log.push({ k: 'guess', by: p, target: g.target, txt: t });
    g.step = 'verify';
  } else if (g.step === 'verify' && p === g.target && m.t === 'verify') {
    g.log.push({ k: 'ver', by: p, target: g.target, v: !!m.v });
    if (m.v) {
      g.winner = g.turn;
      g.phase = 'done';
    } else {
      g.turn = nextActiveSeat(room, g.turn);
      g.target = nextActiveSeat(room, g.turn);
      g.step = 'item';
      g.item = g.ans = g.guess = null;
    }
  }
}

// ---------- Портреты (Safe Base64 Validation) ----------
const STYLES = ['киберпанк', 'аниме', 'пиксель-арт', 'комикс', 'стимпанк', 'мультфильм 90-х', 'фэнтези', 'ретро 80-х', 'поп-арт', 'ужастик', 'супергерой', 'викинг', 'космонавт', 'пират', 'самурай', 'вестерн'];
const TOPICS = ['бурундук', 'Президент', 'робот-повар', 'дракон', 'космический кот', 'ёжик в тумане', 'бабушка-супергерой', 'король пиццы', 'вампир-вегетарианец', 'сонный волшебник', 'ниндзя-официант', 'пингвин-директор'];
const BASE64_JPEG_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/;

function movePt(room, p, m) {
  const g = room.g;
  if (!g || g.winner !== null) return;
  if (g.phase === 'mode' && m.t === 'pmode' && (m.mode === 'each' || m.mode === 'topic')) {
    const L = m.mode === 'each' ? STYLES : TOPICS;
    g.mode = m.mode; g.theme = L[(Math.random() * L.length) | 0]; g.phase = 'draw';
  } else if (g.phase === 'draw' && m.t === 'pimg' && g.imgs[p] === null) {
    if (typeof m.img !== 'string' || !BASE64_JPEG_RE.test(m.img) || m.img.length > 1.5e6) {
      return 'Рисунок не принят';
    }
    g.imgs[p] = m.img;
    const allDone = room.ids.every((id, idx) => !id || g.imgs[idx] !== null);
    if (allDone) { g.phase = 'done'; g.winner = -1; }
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
    scores: [0, 0, 0, 0],
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
        g.scores[p] = (g.scores[p] || 0) + 1;
        g.opened = [];
        if (g.matched.every(x => x >= 0)) {
          const active = getActiveSeats(room);
          let best = -1, maxScore = -1, isDraw = false;
          for (const s of active) {
            const sc = g.scores[s] || 0;
            if (sc > maxScore) { maxScore = sc; best = s; isDraw = false; }
            else if (sc === maxScore) { isDraw = true; }
          }
          g.winner = isDraw ? -1 : best;
        }
      } else {
        g.closing = true;
        push(room);
        setTimeout(() => {
          if (room.g === g) {
            g.opened = [];
            g.turn = nextActiveSeat(room, p);
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

// ---------- Инициализация игр ----------
function newGame(k, room) {
  if (k === 'durak') return newDurak(room);
  if (k === 'chess') return newChess();
  if (k === 'ttt') return { b: Array(9).fill(-1), turn: 0, winner: null, line: null };
  if (k === 'c4') return { b: Array(42).fill(-1), turn: 0, winner: null, line: null };
  if (k === 'rps') return { picks: [null, null, null, null], wins: [0, 0, 0, 0], last: null, winner: null };
  if (k === 'memo') return newMemo();
  if (k === 'pt') return { phase: 'mode', mode: null, theme: null, imgs: [null, null, null, null], winner: null };
  if (k === 'wd') return { phase: 'who', setter: null, word: null, guesses: [], winner: null };
  if (k === 'pk') {
    const active = getActiveSeats(room || { ids: [1, 1, 0, 0] });
    const first = active[0] ?? 0;
    const second = nextActiveSeat(room || { ids: [1, 1, 0, 0] }, first);
    return { phase: 'prep', cats: [null, null, null, null], log: [], turn: first, target: second, step: 'item', item: null, ans: null, guess: null, winner: null };
  }
  return null;
}

// ---------- Общий обработчик хода ----------
function move(room, p, m) {
  const g = room.g, k = room.kind;
  if (!g || g.winner !== null) return;
  if (k === 'durak') return moveDurak(room, p, m);
  if (k === 'chess') return moveChess(room, p, m);
  if (k === 'memo') return moveMemo(room, p, m);
  if (k === 'wd') return moveWd(room, p, m);
  if (k === 'pk') return movePk(room, p, m);
  if (k === 'pt') return movePt(room, p, m);

  if (k === 'ttt' && m.t === 'cell') {
    if (g.turn !== p || !Number.isInteger(m.i) || m.i < 0 || m.i > 8 || g.b[m.i] !== -1) return;
    g.b[m.i] = p;
    const l = L3.find(line => line.every(i => g.b[i] === p));
    if (l) { g.winner = p; g.line = l; }
    else if (g.b.every(x => x >= 0)) g.winner = -1;
    else g.turn = nextActiveSeat(room, p);
  } else if (k === 'c4' && m.t === 'col') {
    if (g.turn !== p || !Number.isInteger(m.c) || m.c < 0 || m.c > 6) return;
    let r = 5; while (r >= 0 && g.b[r * 7 + m.c] !== -1) r--;
    if (r < 0) return;
    const i = r * 7 + m.c; g.b[i] = p;
    const l = line4(g.b, i, p);
    if (l) { g.winner = p; g.line = l; }
    else if (g.b.every(x => x >= 0)) g.winner = -1;
    else g.turn = nextActiveSeat(room, p);
  } else if (k === 'rps' && m.t === 'rps') {
    if (g.picks[p] !== null || ![0, 1, 2].includes(m.v)) return;
    g.picks[p] = m.v;
    const opp = nextActiveSeat(room, p);
    if (g.picks[p] !== null && g.picks[opp] !== null) {
      const a = g.picks[p], b = g.picks[opp];
      const w = a === b ? -1 : (a - b + 3) % 3 === 1 ? p : opp;
      g.last = { p: [g.picks[0], g.picks[1]], w };
      if (w >= 0 && ++g.wins[w] >= 3) g.winner = w;
      g.picks = [null, null, null, null];
    }
  }
}

function applyMove(room, seat, m) {
  if (!room || !room.g || room.g.winner !== null) return;
  const was = room.g.winner;
  const e = move(room, seat, m);
  if (!e && was === null && room.g.winner !== null && room.g.winner >= 0) {
    if (room.score && room.score[room.g.winner] !== undefined) {
      room.score[room.g.winner]++;
    }
  }
  return e;
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

  if (k === 'chess') {
    return botChess(room);
  } else if (k === 'durak') {
    const tr = g.trump;
    const beats = (a, c) => (c.s === a.s && c.r > a.r) || (c.s === tr && a.s !== tr);
    const hand = g.hands[1];
    if (!hand || !hand.length) return;

    if (g.att === 1) {
      if (g.table.length === 0) {
        const nonTr = hand.filter(c => c.s !== tr).sort((a, b) => a.r - b.r);
        const card = nonTr[0] || [...hand].sort((a, b) => a.r - b.r)[0];
        if (card) {
          applyMove(room, 1, { t: 'card', r: card.r, s: card.s });
          push(room);
        }
      } else {
        const allBeaten = !g.table.some(x => !x.d);
        if (allBeaten || g.taking) {
          const matching = hand.filter(c => g.table.some(x => x.a.r === c.r || (x.d && x.d.r === c.r)));
          const lowToss = matching.filter(c => c.s !== tr).sort((a, b) => a.r - b.r)[0];
          const defHand = g.hands[g.def];
          const defHandLen = defHand ? defHand.length : 0;
          const undefended = g.table.filter(x => !x.d).length;
          const canTossMore = g.taking || undefended < defHandLen;
          if (lowToss && g.table.length < 6 && canTossMore) {
            applyMove(room, 1, { t: 'card', r: lowToss.r, s: lowToss.s });
            push(room);
            scheduleBotMove(room, 600);
          } else {
            applyMove(room, 1, { t: 'done' });
            push(room);
            scheduleBotMove(room, 600);
          }
        }
      }
    } else if (g.def === 1) {
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
          applyMove(room, 1, { t: 'card', r: card.r, s: card.s });
          push(room);
          scheduleBotMove(room, 600);
        } else {
          applyMove(room, 1, { t: 'take' });
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
        if (win) { applyMove(room, 1, { t: 'cell', i }); push(room); return; }
      }
    }
    for (let i = 0; i < 9; i++) {
      if (g.b[i] === -1) {
        g.b[i] = 0;
        const win = L3.some(line => line.every(idx => g.b[idx] === 0));
        g.b[i] = -1;
        if (win) { applyMove(room, 1, { t: 'cell', i }); push(room); return; }
      }
    }
    if (g.b[4] === -1) { applyMove(room, 1, { t: 'cell', i: 4 }); push(room); return; }
    const corners = [0, 2, 6, 8].filter(i => g.b[i] === -1);
    if (corners.length) {
      applyMove(room, 1, { t: 'cell', i: corners[(Math.random() * corners.length) | 0] });
      push(room);
      return;
    }
    const empty = g.b.map((v, i) => v === -1 ? i : null).filter(x => x !== null);
    if (empty.length) {
      applyMove(room, 1, { t: 'cell', i: empty[(Math.random() * empty.length) | 0] });
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
        if (win) { applyMove(room, 1, { t: 'col', c }); push(room); return; }
      }
    }
    for (const c of validCols) {
      let r = 5; while (r >= 0 && g.b[r * 7 + c] !== -1) r--;
      if (r >= 0) {
        g.b[r * 7 + c] = 0;
        const win = !!line4(g.b, r * 7 + c, 0);
        g.b[r * 7 + c] = -1;
        if (win) { applyMove(room, 1, { t: 'col', c }); push(room); return; }
      }
    }
    const pref = [3, 2, 4, 1, 5, 0, 6].filter(c => validCols.includes(c));
    applyMove(room, 1, { t: 'col', c: pref[0] });
    push(room);
  } else if (k === 'rps') {
    if (g.picks[1] === null) {
      const v = (Math.random() * 3) | 0;
      applyMove(room, 1, { t: 'rps', v });
      push(room);
    }
  }
}

// ---------- Комнаты и Состояние ----------
const clean = s => String(s || '').replace(/[\u0000-\u001F\u007F-\u009F<>&"'`]/g, '').trim().slice(0, 16);

const start = (room, k) => {
  room.kind = k;
  room.g = newGame(k, room);
  room.gid++;
  if (room.isBot) scheduleBotMove(room, 600);
};

const gv = (room, p) => {
  const g = room.g;
  if (!g) return null;
  if (room.kind === 'durak') {
    const opps = [];
    for (let i = 0; i < room.ids.length; i++) {
      if (i !== p && room.ids[i]) {
        opps.push({
          seat: i,
          name: room.names[i],
          count: g.hands[i] ? g.hands[i].length : 0,
          done: g.winners ? g.winners.includes(i) : false
        });
      }
    }
    return {
      hand: g.hands[p] || [],
      opps,
      opp: opps[0] ? opps[0].count : 0,
      deck: g.deck.length,
      trump: g.trump,
      tc: g.deck[0] || null,
      table: g.table,
      att: g.att,
      def: g.def,
      taking: g.taking,
      winner: g.winner,
      winners: g.winners || []
    };
  }
  if (room.kind === 'chess') {
    return {
      b: g.b,
      turn: g.turn,
      inCheck: g.inCheck,
      last: g.last,
      captured: g.captured,
      winner: g.winner,
      legalMoves: (g.turn === p && g.winner === null) ? getLegalChessMoves(g, p).map(m => ({ from: m.from, to: m.to })) : []
    };
  }
  if (room.kind === 'memo') return {
    cards: g.cards.map((val, idx) => (g.opened.includes(idx) || g.matched[idx] >= 0) ? val : null),
    opened: g.opened,
    matched: g.matched,
    scores: g.scores,
    turn: g.turn,
    winner: g.winner
  };
  if (room.kind === 'pt') return { phase: g.phase, mode: g.mode, theme: g.theme, done: g.imgs.map(x => x !== null), imgs: g.phase === 'done' ? g.imgs : null, winner: g.winner };
  if (room.kind === 'wd') return {
    phase: g.phase, setter: g.setter, pat: g.word ? g.word.replace(/\S/g, '•') : null, guesses: g.guesses,
    word: (g.winner !== null || p === g.setter) ? g.word : null, winner: g.winner,
  };
  if (room.kind === 'pk') {
    const peers = room.ids.map(Boolean);
    return {
      phase: g.phase,
      ready: g.cats.map((c, idx) => peers[idx] ? c !== null : null),
      mine: g.cats[p],
      cats: g.winner !== null ? g.cats : null,
      log: g.log,
      turn: g.turn,
      target: g.target,
      step: g.step,
      item: g.item,
      ans: g.ans,
      guess: g.guess,
      winner: g.winner,
      peers
    };
  }
  if (room.kind === 'rps') return { mine: g.picks[p], opp: g.picks[nextActiveSeat(room, p)] !== null, last: g.last, wins: g.wins, winner: g.winner };
  return { b: g.b, turn: g.turn, winner: g.winner, line: g.line };
};

const view = (room, p) => ({
  t: 'state',
  me: p,
  code: room.code,
  peers: room.ids.map(Boolean),
  on: room.ws.map((w, idx) => room.isBot && idx === 1 ? true : Boolean(w && w.readyState === 1)),
  names: room.names,
  score: room.score,
  kind: room.kind,
  gid: room.gid,
  isBot: !!room.isBot,
  inMenu: !!room.inMenu,
  g: gv(room, p),
});

const push = room => {
  if (!room || !room.ws) return;
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
  ws.room = null;
  ws.seat = -1;
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
      const room = {
        code,
        ids: [clean(m.token) || Math.random().toString(36).slice(2), 'bot_ai', null, null],
        names: [pName, 'ИИ Бот 🤖', '', ''],
        ws: [ws, null, null, null],
        kind: null,
        g: null,
        score: [0, 0, 0, 0],
        gid: 0,
        chat: [],
        last: Date.now(),
        isBot: true,
        inMenu: true
      };
      ws.room = room;
      ws.seat = 0;
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
      for (let i = mmQueue.length - 1; i >= 0; i--) {
        if (curTime - mmQueue[i].time > 45000 || mmQueue[i].ws.readyState !== 1) {
          mmQueue.splice(i, 1);
        }
      }

      const existingIdx = mmQueue.findIndex(q => q.token === token || q.ws === ws);
      if (existingIdx >= 0) mmQueue.splice(existingIdx, 1);

      if (mmQueue.length > 0) {
        const opp = mmQueue.shift();
        const code = genCode();
        const room = {
          code,
          ids: [opp.token, token, null, null],
          names: [opp.name, pName, '', ''],
          ws: [opp.ws, ws, null, null],
          kind: null,
          g: null,
          score: [0, 0, 0, 0],
          gid: 0,
          chat: [],
          last: Date.now(),
          isBot: false,
          inMenu: true
        };
        rooms.set(code, room);
        opp.ws.room = room;
        opp.ws.seat = 0;
        ws.room = room;
        ws.seat = 1;
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
      let room;
      if (code) {
        room = rooms.get(code);
      } else {
        if (rooms.size > 2500) return err(ws, 'Сервер перегружен');
        room = { code: genCode(), ids: [null, null, null, null], names: ['', '', '', ''], ws: [null, null, null, null], kind: null, g: null, score: [0, 0, 0, 0], gid: 0, chat: [], last: Date.now(), isBot: false, inMenu: false };
        rooms.set(room.code, room);
      }
      if (!room) return err(ws, 'Комната не найдена');
      let id = clean(m.token) || Math.random().toString(36).slice(2);
      let seat = room.ids.indexOf(id);

      // Handle duplicate token (e.g. testing in multiple tabs)
      if (seat >= 0 && room.ws[seat] && room.ws[seat] !== ws && room.ws[seat].readyState === 1) {
        const openSeat = room.ids.indexOf(null);
        if (openSeat >= 0) {
          seat = openSeat;
          id = Math.random().toString(36).slice(2) + Date.now().toString(36);
        }
      } else if (seat < 0) {
        seat = room.ids.indexOf(null);
      }

      if (seat < 0 || seat >= 4) {
        return err(ws, 'В комнате уже максимум 4 игрока');
      }

      room.ids[seat] = id;
      room.names[seat] = clean(m.name) || 'Игрок ' + (seat + 1);
      if (room.ws[seat] && room.ws[seat] !== ws) room.ws[seat].close();
      room.ws[seat] = ws;
      ws.room = room;
      ws.seat = seat;
      push(room);
      return ws.send(JSON.stringify({ t: 'chatlog', log: room.chat }));
    }

    // 4. Открыть меню выбора игры (Хост комнаты)
    if (m.t === 'open_menu') {
      const curRoom = ws.room;
      if (curRoom && curRoom.ids.filter(Boolean).length >= 2) {
        curRoom.inMenu = true;
        push(curRoom);
      }
      return;
    }

    // 5. Выход из комнаты / лобби в главное меню
    if (m.t === 'leave') {
      const curRoom = ws.room;
      const curSeat = ws.seat !== undefined ? ws.seat : -1;
      if (curRoom && curSeat >= 0) {
        curRoom.ids[curSeat] = null;
        curRoom.names[curSeat] = '';
        curRoom.ws[curSeat] = null;
        ws.room = null;
        ws.seat = -1;
        ws.send(JSON.stringify({ t: 'left' }));
        const activeRemaining = curRoom.ids.filter(Boolean).length;
        if (curRoom.isBot || activeRemaining === 0) {
          rooms.delete(curRoom.code);
        } else {
          curRoom.g = null;
          curRoom.kind = null;
          compactSeats(curRoom);
          if (activeRemaining < 2) curRoom.inMenu = false;
          push(curRoom);
        }
      } else {
        ws.send(JSON.stringify({ t: 'left' }));
      }
      return;
    }

    const room = ws.room;
    const seat = ws.seat !== undefined ? ws.seat : -1;
    if (!room || seat < 0) return;
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
      const activePeers = room.ids.filter(Boolean).length;
      if (activePeers < 2) return err(ws, 'Нужно как минимум 2 игрока');
      if (['durak', 'pk'].includes(m.k)) {
        if (!room.g || fin) start(room, m.k);
      } else if (KINDS.includes(m.k)) {
        if (activePeers > 2) {
          return err(ws, 'Этот режим доступен только для 2 игроков');
        }
        if (room.isBot && !BOT_KINDS.includes(m.k)) {
          return err(ws, 'Этот режим доступен только для двоих игроков');
        }
        if (!room.g || fin) start(room, m.k);
      }
    } else if (m.t === 'menu') {
      room.kind = null;
      room.g = null;
      room.inMenu = true;
      compactSeats(room);
    } else if (m.t === 'again') {
      if (fin) start(room, room.kind);
    } else if (room.g) {
      const e = applyMove(room, seat, m);
      if (e) err(ws, e);
      if (!e && room.isBot && room.g && room.g.winner === null) {
        scheduleBotMove(room, 500);
      }
    }
    push(room);
  });

  ws.on('close', () => {
    for (let i = mmQueue.length - 1; i >= 0; i--) {
      if (mmQueue[i].ws === ws) mmQueue.splice(i, 1);
    }

    const curRoom = ws.room;
    const curSeat = ws.seat;
    if (curRoom && curSeat >= 0 && curRoom.ws[curSeat] === ws) {
      curRoom.ws[curSeat] = null;
      if (curRoom.isBot) {
        rooms.delete(curRoom.code);
      } else {
        compactSeats(curRoom);
        push(curRoom);
      }
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
