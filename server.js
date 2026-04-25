const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ─── Constants ───────────────────────────────────────────────────────────────
const CELL         = 4;     // world-units per maze cell
const MAZE_W       = 15;
const MAZE_H       = 15;
const EXIT_CX      = MAZE_W - 1;          // right column
const EXIT_CY      = Math.floor(MAZE_H / 2); // middle row
const EXIT_OPEN_MS = 45_000;              // exit unlocks after 45 s

const CHAR_CFG = {
  scout:     { maxHp: 100 },
  tank:      { maxHp: 150 },
  trickster: { maxHp: 100 },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function randomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join('');
  } while (rooms[code]);
  return code;
}

// ─── Maze generation (recursive back-tracker) ────────────────────────────────
function generateMaze(W, H) {
  const cells   = Array.from({ length: H }, () =>
    Array.from({ length: W }, () => ({ n: true, e: true, s: true, w: true }))
  );
  const visited = Array.from({ length: H }, () => new Array(W).fill(false));

  function carve(x, y) {
    visited[y][x] = true;
    for (const [dx, dy, d1, d2] of shuffle([
      [0, -1, 'n', 's'],
      [1,  0, 'e', 'w'],
      [0,  1, 's', 'n'],
      [-1, 0, 'w', 'e'],
    ])) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && nx < W && ny >= 0 && ny < H && !visited[ny][nx]) {
        cells[y][x][d1] = false;
        cells[ny][nx][d2] = false;
        carve(nx, ny);
      }
    }
  }
  carve(0, 0);
  return cells;
}

// ─── Item spawning ────────────────────────────────────────────────────────────
function spawnItems(W, H) {
  const reserved = new Set([
    '0,0', `${W-1},0`, `0,${H-1}`, `${W-1},${H-1}`, `${EXIT_CX},${EXIT_CY}`,
  ]);
  const avail = [];
  for (let y = 1; y < H - 1; y++)
    for (let x = 1; x < W - 1; x++)
      if (!reserved.has(`${x},${y}`)) avail.push({ x, y });
  shuffle(avail);

  const types = [
    ...Array(5).fill('gun'),
    ...Array(5).fill('trap_kit'),
    ...Array(4).fill('health'),
  ];
  return types.map((type, i) => ({
    id: i + 1,
    type,
    x: avail[i].x * CELL + CELL / 2,
    z: avail[i].y * CELL + CELL / 2,
  }));
}

// ─── Spawn points (4 corners) ─────────────────────────────────────────────────
function getSpawns() {
  return [
    { x: CELL * 0.5,          z: CELL * 0.5 },
    { x: CELL * (MAZE_W-0.5), z: CELL * 0.5 },
    { x: CELL * 0.5,          z: CELL * (MAZE_H-0.5) },
    { x: CELL * (MAZE_W-0.5), z: CELL * (MAZE_H-0.5) },
  ];
}

function makePlayer(id, name) {
  return {
    id, name, character: null,
    x: 0, y: 1.7, z: 0, rotY: 0,
    hp: 100, maxHp: 100,
    ammo: 0, hasTrapKit: false,
    alive: true, kills: 0,
    shieldActive: false, cloakActive: false,
  };
}

function serializeRoom(room) {
  return {
    host:    room.host,
    phase:   room.phase,
    players: Object.values(room.players).map(p => ({
      id: p.id, name: p.name, character: p.character,
    })),
  };
}

// ─── Rooms store ─────────────────────────────────────────────────────────────
const rooms = {};

// ─── Socket logic ─────────────────────────────────────────────────────────────
io.on('connection', socket => {
  let myRoom = null;

  const room = () => rooms[myRoom];

  // ── Create ────────────────────────────────────────────────────────────────
  socket.on('create_room', ({ name }) => {
    const code = randomCode();
    rooms[code] = {
      host:    socket.id,
      players: {},
      maze:    generateMaze(MAZE_W, MAZE_H),
      items:   spawnItems(MAZE_W, MAZE_H),
      traps:   [],
      phase:   'lobby',
    };
    myRoom = code;
    socket.join(code);
    rooms[code].players[socket.id] = makePlayer(socket.id, name);
    socket.emit('room_created', { code, playerId: socket.id });
    socket.emit('room_state',   serializeRoom(rooms[code]));
  });

  // ── Join ──────────────────────────────────────────────────────────────────
  socket.on('join_room', ({ code, name }) => {
    const c = code.toUpperCase().trim();
    const r = rooms[c];
    if (!r)                                     return socket.emit('join_error', 'Room not found');
    if (r.phase !== 'lobby')                    return socket.emit('join_error', 'Game already started');
    if (Object.keys(r.players).length >= 4)     return socket.emit('join_error', 'Room is full (max 4)');

    myRoom = c;
    socket.join(c);
    r.players[socket.id] = makePlayer(socket.id, name);
    socket.emit('room_joined', { code: c, playerId: socket.id });
    io.to(c).emit('room_state', serializeRoom(r));
  });

  // ── Select character ──────────────────────────────────────────────────────
  socket.on('select_character', ({ character }) => {
    const r = room(); if (!r) return;
    const taken = Object.values(r.players).some(
      p => p.character === character && p.id !== socket.id
    );
    if (taken) return socket.emit('join_error', 'Character already taken');
    r.players[socket.id].character = character;
    io.to(myRoom).emit('room_state', serializeRoom(r));
  });

  // ── Start game ────────────────────────────────────────────────────────────
  socket.on('start_game', () => {
    const r = room();
    if (!r || r.host !== socket.id) return;
    const pList = Object.values(r.players);
    if (pList.length < 2)               return socket.emit('join_error', 'Need at least 2 players');
    if (pList.some(p => !p.character))  return socket.emit('join_error', 'All players must pick a character');

    const spawns = getSpawns();
    pList.forEach((p, i) => {
      const sp   = spawns[i % spawns.length];
      const cfg  = CHAR_CFG[p.character];
      p.x        = sp.x;   p.z = sp.z;   p.y = 1.7;
      p.hp       = cfg.maxHp;
      p.maxHp    = cfg.maxHp;
      p.ammo     = 0;
      p.hasTrapKit = false;
      p.alive    = true;
      p.kills    = 0;
      p.shieldActive = false;
      p.cloakActive  = false;
    });

    r.phase = 'playing';

    io.to(myRoom).emit('game_start', {
      maze:    r.maze,
      players: pList,
      items:   r.items,
      width:   MAZE_W, height: MAZE_H,
      exitCX:  EXIT_CX, exitCY: EXIT_CY,
    });

    // Open the exit after EXIT_OPEN_MS
    const roomCode = myRoom;
    setTimeout(() => {
      const rr = rooms[roomCode];
      if (rr && rr.phase === 'playing') {
        io.to(roomCode).emit('exit_open');
      }
    }, EXIT_OPEN_MS);
  });

  // ── Position update (20 Hz from client) ───────────────────────────────────
  socket.on('player_update', ({ x, y, z, rotY }) => {
    const r = room(); if (!r) return;
    const p = r.players[socket.id]; if (!p) return;
    p.x = x; p.y = y; p.z = z; p.rotY = rotY;
    socket.to(myRoom).emit('player_moved', { id: socket.id, x, y, z, rotY });
  });

  // ── Shoot ─────────────────────────────────────────────────────────────────
  socket.on('shoot', ({ from, dir, hitId }) => {
    const r = room(); if (!r || r.phase !== 'playing') return;
    const shooter = r.players[socket.id];
    if (!shooter || !shooter.alive || shooter.ammo <= 0) return;

    shooter.ammo--;
    socket.to(myRoom).emit('shot_fired', { id: socket.id, from, dir });
    socket.emit('ammo_update', { ammo: shooter.ammo });

    if (hitId) {
      const target = r.players[hitId];
      if (!target || !target.alive) return;
      if (target.shieldActive) {
        io.to(myRoom).emit('shot_blocked', { id: hitId });
        return;
      }
      target.hp -= 35;
      if (target.hp <= 0) {
        target.hp    = 0;
        target.alive = false;
        shooter.kills++;
        io.to(myRoom).emit('player_killed', { id: hitId, killerId: socket.id });
        checkWin(myRoom);
      } else {
        io.to(myRoom).emit('player_hit', { id: hitId, hp: target.hp });
      }
    }
  });

  // ── Place trap ────────────────────────────────────────────────────────────
  socket.on('place_trap', ({ x, z }) => {
    const r = room(); if (!r) return;
    const p = r.players[socket.id];
    if (!p || !p.hasTrapKit) return;
    p.hasTrapKit = false;
    const trap = { id: `t${Date.now()}${Math.random()}`, x, z, placedBy: socket.id };
    r.traps.push(trap);
    io.to(myRoom).emit('trap_placed', trap);
    socket.emit('inventory_update', { ammo: p.ammo, hasTrapKit: false });
  });

  // ── Step on trap ──────────────────────────────────────────────────────────
  socket.on('step_trap', ({ trapId }) => {
    const r = room(); if (!r) return;
    const trap = r.traps.find(t => t.id === trapId);
    if (!trap || trap.placedBy === socket.id) return;
    const p = r.players[socket.id];
    if (!p || !p.alive) return;
    if (p.shieldActive) { io.to(myRoom).emit('trap_triggered', { trapId, id: socket.id, hp: p.hp, blocked: true }); return; }

    r.traps = r.traps.filter(t => t.id !== trapId);
    p.hp -= 40;
    const hp = Math.max(0, p.hp);
    io.to(myRoom).emit('trap_triggered', { trapId, id: socket.id, hp });
    if (p.hp <= 0) {
      p.hp = 0; p.alive = false;
      io.to(myRoom).emit('player_killed', { id: socket.id, killerId: trap.placedBy });
      checkWin(myRoom);
    }
  });

  // ── Pick up item ──────────────────────────────────────────────────────────
  socket.on('pick_item', ({ itemId }) => {
    const r = room(); if (!r) return;
    const idx = r.items.findIndex(i => i.id === itemId);
    if (idx === -1) return;
    const item = r.items.splice(idx, 1)[0];
    const p = r.players[socket.id]; if (!p) return;

    if      (item.type === 'gun')      p.ammo = Math.min(p.ammo + 3, 9);
    else if (item.type === 'trap_kit') p.hasTrapKit = true;
    else if (item.type === 'health')   p.hp = Math.min(p.maxHp, p.hp + 50);

    io.to(myRoom).emit('item_picked', { itemId, playerId: socket.id });
    socket.emit('inventory_update', { hp: p.hp, ammo: p.ammo, hasTrapKit: p.hasTrapKit });
  });

  // ── Ability start / end ───────────────────────────────────────────────────
  socket.on('ability_start', ({ ability }) => {
    const r = room(); if (!r) return;
    const p = r.players[socket.id]; if (!p) return;
    if (ability === 'shield') p.shieldActive = true;
    if (ability === 'cloak')  p.cloakActive  = true;
    io.to(myRoom).emit('ability_started', { id: socket.id, ability });
  });

  socket.on('ability_end', ({ ability }) => {
    const r = room(); if (!r) return;
    const p = r.players[socket.id]; if (!p) return;
    if (ability === 'shield') p.shieldActive = false;
    if (ability === 'cloak')  p.cloakActive  = false;
    io.to(myRoom).emit('ability_ended', { id: socket.id, ability });
  });

  // ── Reached the exit ──────────────────────────────────────────────────────
  socket.on('reached_exit', () => {
    const r = room(); if (!r || r.phase !== 'playing') return;
    r.phase = 'ended';
    const w = r.players[socket.id];
    io.to(myRoom).emit('game_over', {
      winnerId:   socket.id,
      winnerName: w ? w.name : '???',
      reason:     'exit',
      players:    Object.values(r.players).map(p => ({
        name: p.name, kills: p.kills, alive: p.alive, character: p.character,
      })),
    });
  });

  // ── Disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const r = room(); if (!r) return;
    delete r.players[socket.id];
    const remaining = Object.keys(r.players);
    if (remaining.length === 0) {
      delete rooms[myRoom];
    } else {
      if (r.host === socket.id) r.host = remaining[0];
      io.to(myRoom).emit('player_left', { id: socket.id });
      if (r.phase === 'playing') checkWin(myRoom);
    }
  });
});

// ─── Win condition ─────────────────────────────────────────────────────────
function checkWin(code) {
  const r = rooms[code]; if (!r || r.phase !== 'playing') return;
  const alive = Object.values(r.players).filter(p => p.alive);
  if (alive.length > 1) return;
  r.phase = 'ended';
  io.to(code).emit('game_over', {
    winnerId:   alive.length === 1 ? alive[0].id   : null,
    winnerName: alive.length === 1 ? alive[0].name : null,
    reason:     alive.length === 1 ? 'elimination' : 'draw',
    players:    Object.values(r.players).map(p => ({
      name: p.name, kills: p.kills, alive: p.alive, character: p.character,
    })),
  });
}

// ─── Start ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`🎮  Maze Game → http://localhost:${PORT}`)
);
