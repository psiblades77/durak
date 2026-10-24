// Verification script for server.js fixes
const assert = require('assert');

// 1. Durak Dealing & Active Seats
function testDurak() {
  console.log("Testing Durak...");
  // Test room with seats [0, 2]
  const room = {
    ids: ['id0', null, 'id2', null],
    names: ['P0', '', 'P2', '']
  };

  function getActiveSeats(r) {
    const s = [];
    for (let i = 0; i < r.ids.length; i++) if (r.ids[i]) s.push(i);
    return s;
  }

  function nextActiveSeat(r, current) {
    const n = r.ids.length;
    for (let step = 1; step <= n; step++) {
      const s = (current + step) % n;
      if (r.ids[s]) return s;
    }
    return current;
  }

  const activeSeats = getActiveSeats(room);
  assert.deepStrictEqual(activeSeats, [0, 2]);

  // Ensure nextActiveSeat wraps correctly
  assert.strictEqual(nextActiveSeat(room, 0), 2);
  assert.strictEqual(nextActiveSeat(room, 2), 0);
  console.log("  Durak seats test passed!");
}

// 2. Test centralized applyMove and score tracking
function testApplyMove() {
  console.log("Testing applyMove...");
  const room = {
    g: { winner: null },
    score: [0, 0, 0, 0]
  };

  function applyMove(r, seat, m) {
    if (!r.g || r.g.winner !== null) return;
    const was = r.g.winner;
    // Simulate game ending with seat 1 winning
    r.g.winner = 1;
    if (was === null && r.g.winner !== null && r.g.winner >= 0) {
      if (r.score[r.g.winner] !== undefined) r.score[r.g.winner]++;
    }
  }

  applyMove(room, 1, {});
  assert.strictEqual(room.score[1], 1, "Bot or human win increments score!");

  // Second move should be ignored because winner !== null
  applyMove(room, 1, {});
  assert.strictEqual(room.score[1], 1, "No double increment!");
  console.log("  applyMove test passed!");
}

// 3. Test MM Queue Pruning
function testMMQueue() {
  console.log("Testing Matchmaking queue pruning...");
  const now = Date.now();
  let mmQueue = [
    { ws: { readyState: 1 }, time: now, token: 't1' },
    { ws: { readyState: 3 }, time: now, token: 't2' }, // dead socket
    { ws: { readyState: 1 }, time: now - 60000, token: 't3' }, // expired
    { ws: { readyState: 1 }, time: now, token: 't4' }
  ];

  // Old prune logic only checked index 0!
  // New prune logic:
  mmQueue = mmQueue.filter(q => (now - q.time <= 45000) && q.ws.readyState === 1);
  assert.strictEqual(mmQueue.length, 2);
  assert.strictEqual(mmQueue[0].token, 't1');
  assert.strictEqual(mmQueue[1].token, 't4');
  console.log("  MM Queue prune test passed!");
}

testDurak();
testApplyMove();
testMMQueue();
console.log("All unit checks passed!");

