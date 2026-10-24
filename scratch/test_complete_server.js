// Comprehensive simulation of server.js logic with all 9 fixes
const assert = require('assert');

// Test compactSeats
function testCompactSeats() {
  console.log("Testing compactSeats...");
  const ws0 = { seat: 0 };
  const ws2 = { seat: 2 };
  const room = {
    ids: ['token0', null, 'token2', null],
    names: ['P0', '', 'P2', ''],
    ws: [ws0, null, ws2, null],
    score: [5, 0, 7, 0],
    g: null
  };

  function compactSeats(r) {
    if (!r || r.g) return;
    const active = [];
    for (let i = 0; i < r.ids.length; i++) {
      if (r.ids[i]) {
        active.push({
          id: r.ids[i],
          name: r.names[i],
          ws: r.ws[i],
          score: r.score[i] || 0
        });
      }
    }
    for (let i = 0; i < 4; i++) {
      if (i < active.length) {
        r.ids[i] = active[i].id;
        r.names[i] = active[i].name;
        r.ws[i] = active[i].ws;
        r.score[i] = active[i].score;
        if (active[i].ws) active[i].ws.seat = i;
      } else {
        r.ids[i] = null;
        r.names[i] = '';
        r.ws[i] = null;
        r.score[i] = 0;
      }
    }
  }

  compactSeats(room);
  assert.strictEqual(room.ids[0], 'token0');
  assert.strictEqual(room.ids[1], 'token2');
  assert.strictEqual(room.ids[2], null);
  assert.strictEqual(ws2.seat, 1);
  assert.strictEqual(room.score[1], 7);
  console.log("  compactSeats passed!");
}

testCompactSeats();

