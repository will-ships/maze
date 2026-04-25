const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ── Constants ──────────────────────────────────────────────────────────────
const CELL             = 4;
const MAZE_W           = 15;
const MAZE_H           = 15;
const EXIT_CX          = MAZE_W - 1;   // bottom-right = furthest from spawn
const EXIT_CY          = MAZE_H - 1;
const EXIT_OPEN_MS     = 45_000;
const GRACE_MS         = 20_000;       // no-kill at game start
const RESPAWN_GRACE_MS = 10_000;       // no-kill after respawn
const RESPAWN_DELAY_MS = 3_000;        // wait before respawning
const MAX_LIVES        = 3;

// All players start clustered at top-left cell
const SPAWN_BASE    = { x: CELL * 0.5, z: CELL * 0.5 };
const SPAWN_OFFSETS = [
  { dx: 0,   dz: 0   },
  { dx: 0.7, dz: 0   },
  { dx: 0,   dz: 0.7 },
  { dx: 0.7, dz: 0.7 },
];

const CHAR_CFG = {
  scout:     { maxHp: 100 },
  tank:      { maxHp: 150 },
  trickster: { maxHp: 100 },
  phantom:   { maxHp: 90  },   // 4th character: walk through walls
};

// ── Helpers ────────────────────────────────────────────────────────────────
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

// ── Maze generation (recursive back-tracker) ──────────────────────────────
function generateMaze(W, H) {
  const cells   = Array.from({ length: H }, () =>
    Array.from({ length: W }, () => ({ n: true, e: true, s: true, w: true }))
  );
  const visited = Array.from({ length: H }, () => new Array(W).fill(false));

  function carve(x, y) {
    visited[y][x] = true;
    for (const [dx, dy, d1, d2] of shuffle([
      [0, -1, 'n', 's'], [1, 0, 'e', 'w'], [0, 1, 's', 'n'], [-1, 0, 'w', 'e'],
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

// ── Corridor detection (cells with exactly 2 openings) ────────────────────
function findCorridorCells(cells, W, H) {
  const corridors = [];
  for (let y = 2; y < H - 2; y++) {
    for (let x = 2; x < W - 2; x++) {
      const c = cells[y][x];
      const openings = [!c.n, !c.e, !c.s, !c.w].filter(Boolean).length;
      if (openings === 2) corridors.push({ x, y });
    }
  }
  return corridors;
}

// ── Item spawning ─────────────────────────────────────────────────────────
function spawnItems(W, H) {
  const reserved = new Set(['0,0', `${W-1},0`, `0,${H-1}`, `${W-1},${H-1}`, `${EXIT_CX},${EXIT_CY}`]);
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
    id: i + 1, type,
    x: avail[i].x * CELL + CELL / 2,
    z: avail[i].y * CELL + CELL / 2,
  }));
}

// ── Difficulty-based env traps ─────────────────────────────────────────────
function spawnEnvTraps(difficulty, cells, W, H) {
  if (difficulty === 'easy') return [];

  const corridors = findCorridorCells(cells, W, H);
  shuffle(corridors);

  const reserved = new Set(['0,0', `${W-1},0`, `0,${H-1}`, `${W-1},${H-1}`, `${EXIT_CX},${EXIT_CY}`]);
  const avail = corridors.filter(c => !reserved.has(`${c.x},${c.y}`));

  const traps = [];
  let id = 0;

  if (difficulty === 'middle') {
    // 8 visible claymore traps (laser beam shown)
    for (let i = 0; i < 8 && i < avail.length; i++) {
      traps.push({
        id: `env_${id++}`,
        x: avail[i].x * CELL + CELL / 2,
        z: avail[i].y * CELL + CELL / 2,
        placedBy: 'env',
        visible: true,
        laserDir: Math.random() * Math.PI * 2,
      });
    }
  } else if (difficulty === 'hard') {
    // 5 visible + 6 invisible (corridor-placed → unavoidable)
    for (let i = 0; i < 5 && i < avail.length; i++) {
      traps.push({
        id: `env_${id++}`,
        x: avail[i].x * CELL + CELL / 2,
        z: avail[i].y * CELL + CELL / 2,
        placedBy: 'env',
        visible: true,
        laserDir: Math.random() * Math.PI * 2,
      });
    }
    for (let i = 5; i < 11 && i < avail.length; i++) {
      traps.push({
        id: `env_${id++}`,
        x: avail[i].x * CELL + CELL / 2,
        z: avail[i].y * CELL + CELL / 2,
        placedBy: 'env',
        visible: false,
      });
    }
  }
  return traps;
}

function makePlayer(id, name) {
  return {
    id, name, character: null,
    x: SPAWN_BASE.x, y: 1.7, z: SPAWN_BASE.z, rotY: 0,
    hp: 100, maxHp: 100,
    ammo: 0, hasTrapKit: false,
    alive: true, lives: MAX_LIVES,
    kills: 0, deaths: 0,
    shieldActive: false, cloakActive: false,
    noKillUntil: 0,
  };
}

function serializeRoom(room) {
  return {
    host:       room.host,
    phase:      room.phase,
    difficulty: room.difficulty,
    players:    Object.values(room.players).map(p => ({
      id: p.id, name: p.name, character: p.character,
    })),
  };
}

// ── Rooms store ────────────────────────────────────────────────────────────
const rooms = {};

// ── Socket logic ───────────────────────────────────────────────────────────
io.on('connection', socket => {
  let myRoom = null;
  const room = () => rooms[myRoom];

  // Create ─────────────────────────────────────────────────────────────────
  socket.on('create_room', ({ name }) => {
    const code = randomCode();
    rooms[code] = {
      host: socket.id,
      players: {},
      maze:   generateMaze(MAZE_W, MAZE_H),
      items:  spawnItems(MAZE_W, MAZE_H),
      traps:  [],
      phase:  'lobby',
      difficulty: 'easy',
      globalNoKillUntil: 0,
    };
    myRoom = code;
    socket.join(code);
    rooms[code].players[socket.id] = makePlayer(socket.id, name);
    socket.emit('room_created', { code, playerId: socket.id });
    socket.emit('room_state',   serializeRoom(rooms[code]));
  });

  // Join ───────────────────────────────────────────────────────────────────
  socket.on('join_room', ({ code, name }) => {
    const c = code.toUpperCase().trim();
    const r = rooms[c];
    if (!r)                                  return socket.emit('join_error', 'Room not found');
    if (r.phase !== 'lobby')                 return socket.emit('join_error', 'Game already started');
    if (Object.keys(r.players).length >= 4)  return socket.emit('join_error', 'Room is full (max 4)');
    myRoom = c;
    socket.join(c);
    r.players[socket.id] = makePlayer(socket.id, name);
    socket.emit('room_joined', { code: c, playerId: socket.id });
    io.to(c).emit('room_state', serializeRoom(r));
  });

  // Select character ────────────────────────────────────────────────────────
  socket.on('select_character', ({ character }) => {
    const r = room(); if (!r) return;
    const taken = Object.values(r.players).some(p => p.character === character && p.id !== socket.id);
    if (taken) return socket.emit('join_error', 'Character already taken');
    r.players[socket.id].character = character;
    io.to(myRoom).emit('room_state', serializeRoom(r));
  });

  // Select difficulty (host only) ───────────────────────────────────────────
  socket.on('select_difficulty', ({ difficulty }) => {
    const r = room();
    if (!r || r.host !== socket.id) return;
    if (!['easy', 'middle', 'hard'].includes(difficulty)) return;
    r.difficulty = difficulty;
    io.to(myRoom).emit('room_state', serializeRoom(r));
  });

  // Start game ──────────────────────────────────────────────────────────────
  socket.on('start_game', () => {
    const r = room();
    if (!r || r.host !== socket.id) return;
    const pList = Object.values(r.players);
    if (pList.length < 2)              return socket.emit('join_error', 'Need at least 2 players');
    if (pList.some(p => !p.character)) return socket.emit('join_error', 'All players must pick a character');

    // Assign spawn positions (all clustered at top-left)
    pList.forEach((p, i) => {
      const off = SPAWN_OFFSETS[i % SPAWN_OFFSETS.length];
      p.x   = SPAWN_BASE.x + off.dx;
      p.z   = SPAWN_BASE.z + off.dz;
      p.y   = 1.7;
      p.hp  = CHAR_CFG[p.character].maxHp;
      p.maxHp = p.hp;
      p.ammo = 0; p.hasTrapKit = false;
      p.alive = true; p.lives = MAX_LIVES;
      p.kills = 0; p.deaths = 0;
      p.shieldActive = false; p.cloakActive = false;
      p.noKillUntil = 0;
    });

    // Environment traps based on difficulty
    r.traps = spawnEnvTraps(r.difficulty, r.maze, MAZE_W, MAZE_H);
    r.phase = 'playing';

    const noKillUntil = Date.now() + GRACE_MS;
    r.globalNoKillUntil = noKillUntil;

    io.to(myRoom).emit('game_start', {
      maze:       r.maze,
      players:    pList,
      items:      r.items,
      traps:      r.traps,
      width:      MAZE_W, height: MAZE_H,
      exitCX:     EXIT_CX, exitCY: EXIT_CY,
      difficulty: r.difficulty,
      noKillUntil,
    });

    const roomCode = myRoom;

    // Open exit after EXIT_OPEN_MS
    setTimeout(() => {
      const rr = rooms[roomCode];
      if (rr && rr.phase === 'playing') io.to(roomCode).emit('exit_open');
    }, EXIT_OPEN_MS);
  });

  // Position update ─────────────────────────────────────────────────────────
  socket.on('player_update', ({ x, y, z, rotY }) => {
    const r = room(); if (!r) return;
    const p = r.players[socket.id]; if (!p) return;
    p.x = x; p.y = y; p.z = z; p.rotY = rotY;
    socket.to(myRoom).emit('player_moved', { id: socket.id, x, y, z, rotY });
  });

  // Shoot ───────────────────────────────────────────────────────────────────
  socket.on('shoot', ({ from, dir, hitId }) => {
    const r = room(); if (!r || r.phase !== 'playing') return;
    const shooter = r.players[socket.id];
    if (!shooter || !shooter.alive || shooter.ammo <= 0) return;

    shooter.ammo--;
    socket.to(myRoom).emit('shot_fired', { id: socket.id, from, dir });
    socket.emit('ammo_update', { ammo: shooter.ammo });

    if (!hitId) return;
    const target = r.players[hitId];
    if (!target || !target.alive) return;
    if (target.shieldActive) { io.to(myRoom).emit('shot_blocked', { id: hitId }); return; }

    // Grace period checks
    const now = Date.now();
    if (now < r.globalNoKillUntil || now < (target.noKillUntil || 0)) {
      io.to(myRoom).emit('shot_blocked', { id: hitId });
      return;
    }

    target.hp -= 35;
    if (target.hp <= 0) {
      target.hp = 0; target.alive = false; target.lives--;
      shooter.kills++;
      io.to(myRoom).emit('player_killed', {
        id: hitId, killerId: socket.id,
        livesLeft: target.lives,
      });

      if (target.lives > 0) {
        scheduleRespawn(myRoom, hitId);
      } else {
        io.to(myRoom).emit('player_eliminated', { id: hitId });
        checkWin(myRoom);
      }
    } else {
      io.to(myRoom).emit('player_hit', { id: hitId, hp: target.hp });
    }
  });

  // Place trap ──────────────────────────────────────────────────────────────
  socket.on('place_trap', ({ x, z }) => {
    const r = room(); if (!r) return;
    const p = r.players[socket.id];
    if (!p || !p.hasTrapKit) return;
    p.hasTrapKit = false;
    const trap = { id: `t${Date.now()}${Math.random()}`, x, z, placedBy: socket.id, visible: false };
    r.traps.push(trap);
    io.to(myRoom).emit('trap_placed', trap);
    socket.emit('inventory_update', { ammo: p.ammo, hasTrapKit: false });
  });

  // Step on trap ────────────────────────────────────────────────────────────
  socket.on('step_trap', ({ trapId }) => {
    const r = room(); if (!r) return;
    const trap = r.traps.find(t => t.id === trapId);
    if (!trap || trap.placedBy === socket.id) return;
    const p = r.players[socket.id];
    if (!p || !p.alive) return;

    const now = Date.now();
    if (now < r.globalNoKillUntil || now < (p.noKillUntil || 0)) return;
    if (p.shieldActive) {
      io.to(myRoom).emit('trap_triggered', { trapId, id: socket.id, hp: p.hp, blocked: true });
      return;
    }

    r.traps = r.traps.filter(t => t.id !== trapId);
    p.hp -= 40;
    const hp = Math.max(0, p.hp);
    io.to(myRoom).emit('trap_triggered', { trapId, id: socket.id, hp });

    if (p.hp <= 0) {
      p.hp = 0; p.alive = false; p.lives--;
      io.to(myRoom).emit('player_killed', {
        id: socket.id, killerId: trap.placedBy, livesLeft: p.lives,
      });
      if (p.lives > 0) {
        scheduleRespawn(myRoom, socket.id);
      } else {
        io.to(myRoom).emit('player_eliminated', { id: socket.id });
        checkWin(myRoom);
      }
    }
  });

  // Defuse trap (visible env traps only) ────────────────────────────────────
  socket.on('defuse_trap', ({ trapId }) => {
    const r = room(); if (!r) return;
    const trap = r.traps.find(t => t.id === trapId);
    if (!trap || !trap.visible) return;  // can only defuse visible traps
    r.traps = r.traps.filter(t => t.id !== trapId);
    io.to(myRoom).emit('trap_defused', { trapId, defuserId: socket.id });
  });

  // Pick up item ─────────────────────────────────────────────────────────────
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

  // Ability start / end ──────────────────────────────────────────────────────
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

  // Reached exit ─────────────────────────────────────────────────────────────
  socket.on('reached_exit', () => {
    const r = room(); if (!r || r.phase !== 'playing') return;
    r.phase = 'ended';
    const w = r.players[socket.id];
    io.to(myRoom).emit('game_over', {
      winnerId:   socket.id,
      winnerName: w ? w.name : '???',
      reason:     'exit',
      players:    Object.values(r.players).map(p => ({
        name: p.name, kills: p.kills, deaths: p.deaths, lives: p.lives, character: p.character,
      })),
    });
  });

  // Disconnect ───────────────────────────────────────────────────────────────
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

// ── Respawn helper ─────────────────────────────────────────────────────────
function scheduleRespawn(code, playerId) {
  setTimeout(() => {
    const r = rooms[code]; if (!r || r.phase !== 'playing') return;
    const p = r.players[playerId]; if (!p || p.lives <= 0) return;

    p.hp    = CHAR_CFG[p.character].maxHp;
    p.alive = true;
    p.deaths++;
    p.x     = SPAWN_BASE.x;
    p.z     = SPAWN_BASE.z;
    p.y     = 1.7;
    p.noKillUntil = Date.now() + RESPAWN_GRACE_MS;

    io.to(code).emit('player_respawn', {
      id:          playerId,
      x: p.x, z: p.z, y: p.y,
      hp:          p.hp,
      lives:       p.lives,
      noKillUntil: p.noKillUntil,
    });
  }, RESPAWN_DELAY_MS);
}

// ── Win condition ──────────────────────────────────────────────────────────
function checkWin(code) {
  const r = rooms[code]; if (!r || r.phase !== 'playing') return;
  const withLives = Object.values(r.players).filter(p => p.lives > 0);
  if (withLives.length > 1) return;
  r.phase = 'ended';
  const winner = withLives[0] || null;
  io.to(code).emit('game_over', {
    winnerId:   winner?.id   ?? null,
    winnerName: winner?.name ?? null,
    reason:     withLives.length === 1 ? 'last_standing' : 'draw',
    players:    Object.values(r.players).map(p => ({
      name: p.name, kills: p.kills, deaths: p.deaths, lives: p.lives, character: p.character,
    })),
  });
}

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`🎮  Maze Runners → http://localhost:${PORT}`)
);
