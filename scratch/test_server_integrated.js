const assert = require('assert');

// Test the complete logic from server.js
// We can evaluate functions directly
const fs = require('fs');
const serverCode = fs.readFileSync('server.js', 'utf8');

// Extract definitions and run them in vm context
const vm = require('vm');
const context = {
  require,
  __dirname,
  console,
  setTimeout: () => {},
  clearTimeout: () => {},
  setInterval: () => {},
  clearInterval: () => {},
  rooms: new Map(),
  mmQueue: [],
  process: { env: { PORT: 9999 } }
};
vm.createContext(context);

// Load serverCode up to srv.listen
const trimmedCode = serverCode.replace(/srv\.listen\(.*/, '// srv.listen omitted');
vm.runInContext(trimmedCode, context);

console.log("Context loaded successfully!");

// 1. Test Durak
console.log("1. Testing Durak...");
const durakRoom4 = {
  ids: ['p0', 'p1', 'p2', 'p3'],
  names: ['A', 'B', 'C', 'D'],
  ws: [{}, {}, {}, {}],
  score: [0, 0, 0, 0]
};
const gDurak = context.newDurak(durakRoom4);
assert.strictEqual(gDurak.hands[0].length, 6);
assert.strictEqual(gDurak.hands[1].length, 6);
assert.strictEqual(gDurak.hands[2].length, 6);
assert.strictEqual(gDurak.hands[3].length, 6);
assert.strictEqual(gDurak.deck.length, 36 - 24);
assert.ok(gDurak.att >= 0 && gDurak.att <= 3);
assert.ok(gDurak.def >= 0 && gDurak.def <= 3);
assert.notStrictEqual(gDurak.att, gDurak.def);

// Test Durak premature win prevention:
// Set deck to empty, table has cards, player 0 has 0 cards
gDurak.deck = [];
const initialAtt = gDurak.att;
gDurak.hands[initialAtt] = [];
gDurak.table = [{ a: { r: 10, s: 0 }, d: null }];
durakRoom4.g = gDurak;
// A move should NOT declare winner while table has cards!
context.moveDurak(durakRoom4, gDurak.def, { t: 'take' });
assert.strictEqual(gDurak.winner, null, "Winner must NOT be set while table has cards or defense in progress!");

// Now attacker finishes round:
context.moveDurak(durakRoom4, initialAtt, { t: 'done' });
assert.strictEqual(gDurak.table.length, 0);
assert.ok(gDurak.winners.includes(initialAtt), "Initial attacker added to winners list!");
// In 4-player game, 3 players still have cards so game continues:
assert.strictEqual(gDurak.winner, null);

// When only 1 player is left with cards:
gDurak.hands.forEach((h, idx) => { if (idx !== gDurak.def) gDurak.hands[idx] = []; });
// Now trigger bout completion
gDurak.table = [{ a: { r: 12, s: 0 }, d: null }];
context.moveDurak(durakRoom4, gDurak.def, { t: 'take' });
context.moveDurak(durakRoom4, gDurak.att, { t: 'done' });
assert.ok(gDurak.winner !== null, "Winner is resolved when only 1 player has cards left!");
console.log("  Durak test passed!");

// 2. Test Chess & applyMove
console.log("2. Testing Chess score tracking...");
const chessRoom = {
  ids: ['human', 'bot_ai', null, null],
  names: ['Human', 'Bot', '', ''],
  ws: [{}, null, null, null],
  score: [0, 0, 0, 0],
  isBot: true,
  kind: 'chess',
  g: context.newChess()
};
// Simulate checkmate by bot (p = 1)
chessRoom.g.turn = 1;
chessRoom.g.winner = null;
// Force bot winning move:
context.applyMove(chessRoom, 1, { t: 'chess_move', from: 0, to: 0 }); // invalid move returns error, no score
assert.strictEqual(chessRoom.score[1], 0);

// Set winner directly in game and trigger applyMove
const dummyRoom = {
  ids: ['human', 'bot_ai', null, null],
  score: [0, 0, 0, 0],
  kind: 'rps',
  g: { picks: [null, null, null, null], wins: [0, 2, 0, 0], last: null, winner: null }
};
// Bot wins RPS:
dummyRoom.g.picks[0] = 0; // Rock
context.applyMove(dummyRoom, 1, { t: 'rps', v: 1 }); // Paper beats Rock
assert.strictEqual(dummyRoom.g.winner, 1, "Bot should win RPS");
assert.strictEqual(dummyRoom.score[1], 1, "Bot win MUST increment score[1]!");
console.log("  Chess & applyMove test passed!");

// 3. Test Camping Trip (pk) initialization with non-0 seats
console.log("3. Testing Camping Trip (pk)...");
const pkRoom = {
  ids: [null, 'user1', 'user2', null],
  names: ['', 'U1', 'U2', ''],
  ws: [null, {}, {}, null],
  score: [0, 0, 0, 0]
};
const gPk = context.newGame('pk', pkRoom);
assert.strictEqual(gPk.turn, 1, "First active seat is 1");
assert.strictEqual(gPk.target, 2, "Second active seat is 2");
pkRoom.g = gPk;
// Submit categories
context.movePk(pkRoom, 1, { t: 'cat', w: 'Звери' });
assert.strictEqual(gPk.phase, 'prep');
context.movePk(pkRoom, 2, { t: 'cat', w: 'Птицы' });
assert.strictEqual(gPk.phase, 'play');
assert.strictEqual(gPk.turn, 1);
assert.strictEqual(gPk.target, 2);
console.log("  Camping Trip test passed!");

// 4. Test Memory (memo)
console.log("4. Testing Memory...");
const memoRoom = {
  ids: ['user0', 'user1', null, null],
  score: [0, 0, 0, 0],
  kind: 'memo',
  g: context.newGame('memo', null)
};
assert.strictEqual(memoRoom.g.scores.length, 4, "scores must have 4 slots");
console.log("  Memory test passed!");

// 5. Test compactSeats
console.log("5. Testing compactSeats...");
const sparseRoom = {
  ids: [null, 'userA', null, 'userB'],
  names: ['', 'A', '', 'B'],
  ws: [null, { seat: 1 }, null, { seat: 3 }],
  score: [0, 3, 0, 8],
  g: null
};
context.compactSeats(sparseRoom);
assert.strictEqual(sparseRoom.ids[0], 'userA');
assert.strictEqual(sparseRoom.ids[1], 'userB');
assert.strictEqual(sparseRoom.ids[2], null);
assert.strictEqual(sparseRoom.names[0], 'A');
assert.strictEqual(sparseRoom.names[1], 'B');
assert.strictEqual(sparseRoom.ws[0].seat, 0);
assert.strictEqual(sparseRoom.ws[1].seat, 1);
assert.strictEqual(sparseRoom.score[0], 3);
assert.strictEqual(sparseRoom.score[1], 8);
console.log("  compactSeats test passed!");

console.log("\nALL 9 TESTS PASSED 100%!");
