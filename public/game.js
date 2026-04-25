// ════════════════════════════════════════════════════════════════════════════
//  MAZE RUNNERS  –  Three.js FPS client
// ════════════════════════════════════════════════════════════════════════════
import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

// ─── Config ──────────────────────────────────────────────────────────────────
const CELL      = 4;       // world units per maze cell
const WALL_H    = 3.2;     // wall height
const WALL_T    = 0.3;     // wall thickness
const EYE_H     = 1.7;     // camera (eye) height
const P_RADIUS  = 0.38;    // player collision radius
const BOB_AMP   = 0.04;    // head-bob amplitude

const CHAR_META = {
  scout:     { name:'Scout',     color:0xE8855A, colorHex:'#E8855A', maxHp:100, speed:6.5, ability:'sprint',  abilityDur:3000,  abilityCd:15000 },
  tank:      { name:'Tank',      color:0x4A90D9, colorHex:'#4A90D9', maxHp:150, speed:4.0, ability:'shield',  abilityDur:2000,  abilityCd:20000 },
  trickster: { name:'Trickster', color:0x9B59B6, colorHex:'#9B59B6', maxHp:100, speed:5.0, ability:'cloak',   abilityDur:3000,  abilityCd:18000 },
};

// ─── State ────────────────────────────────────────────────────────────────────
const socket = window.io();

// Room / player meta
let myId        = '';
let myChar      = '';
let roomCode    = '';
let isHost      = false;

// Three.js core
let scene, camera, renderer, controls, clock;
let wallBoxes   = [];   // { minX, maxX, minZ, maxZ }

// Scene objects
let exitMarker  = null;
let exitLight   = null;
let exitPos     = { x: 0, z: 0 };
let exitOpen    = false;
let gunMesh     = null;
let shieldBubble = null;

// Remote players  { id → { mesh, nameSprite, char, cloaked } }
const others    = {};

// Items / traps on ground
let groundItems = [];   // { id, type, x, z, mesh }
let groundTraps = [];   // { id, placedBy, x, z, mesh }

// Player stats (synced from server)
let myHp        = 100;
let myMaxHp     = 100;
let myAmmo      = 0;
let myHasTrap   = false;

// Ability state
let abilityActive    = false;
let abilityEndTime   = 0;
let abilityCdEnd     = 0;

// Input
const keys   = {};
let   shootCdEnd = 0;

// Misc
let mazeData       = null;  // { cells, width, height }
let exitCountdown  = null;  // setInterval handle
let lastSentTime   = 0;
let bobT           = 0;

// DOM handles (grabbed after DOMContentLoaded)
let minimapCanvas, minimapCtx;
let abilityCanvas, abilityCtx;

// ════════════════════════════════════════════════════════════════════════════
//  INIT
// ════════════════════════════════════════════════════════════════════════════
function init() {
  minimapCanvas = document.getElementById('minimap');
  minimapCtx    = minimapCanvas.getContext('2d');
  abilityCanvas = document.getElementById('ability-canvas');
  abilityCtx    = abilityCanvas.getContext('2d');

  // Three.js scene
  scene    = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0a18);
  scene.fog = new THREE.FogExp2(0x0a0a18, 0.045);

  camera   = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.05, 80);
  scene.add(camera); // needed so gun mesh (child of camera) renders

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
  document.getElementById('game-canvas').appendChild(renderer.domElement);

  // PointerLockControls (handles mouse-look)
  controls = new PointerLockControls(camera, renderer.domElement);
  controls.addEventListener('lock',   () => document.getElementById('lock-overlay').style.display = 'none');
  controls.addEventListener('unlock', () => {
    if (document.getElementById('screen-game').classList.contains('active')) {
      document.getElementById('lock-overlay').style.display = 'flex';
    }
  });

  clock = new THREE.Clock();

  // Resize
  window.addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  // Key input
  window.addEventListener('keydown', e => {
    keys[e.code] = true;
    if (e.code === 'KeyE') handleInteract();
    if (e.code === 'KeyF') handleAbility();
  });
  window.addEventListener('keyup', e => { keys[e.code] = false; });

  // Shoot on click
  window.addEventListener('mousedown', e => {
    if (e.button === 0 && controls.isLocked) tryShoot();
  });

  // Click on canvas = request pointer lock
  document.getElementById('game-canvas').addEventListener('click', () => {
    if (document.getElementById('screen-game').classList.contains('active')) {
      controls.lock();
    }
  });

  setupSocket();
  setupMenuUI();
  animate();
}

// ════════════════════════════════════════════════════════════════════════════
//  SOCKET SETUP
// ════════════════════════════════════════════════════════════════════════════
function setupSocket() {

  socket.on('room_created', ({ code, playerId }) => {
    myId = playerId; roomCode = code; isHost = true;
    document.getElementById('lobby-code').textContent = code;
    showScreen('lobby');
  });

  socket.on('room_joined', ({ code, playerId }) => {
    myId = playerId; roomCode = code; isHost = false;
    document.getElementById('lobby-code').textContent = code;
    showScreen('lobby');
  });

  socket.on('room_state', (state) => {
    updateLobbyUI(state);
  });

  socket.on('join_error', msg => {
    showError('menu-error', msg);
    showError('lobby-error', msg);
  });

  socket.on('game_start', (data) => {
    startGame(data);
  });

  // ── In-game events ──────────────────────────────────────────────────────

  socket.on('player_moved', ({ id, x, y, z, rotY }) => {
    const o = others[id];
    if (!o) return;
    o.mesh.position.set(x, 0, z);
    o.mesh.rotation.y = rotY;
  });

  socket.on('player_hit', ({ id, hp }) => {
    if (id === myId) { myHp = hp; updateHUD(); flashDamage(); }
    else if (others[id]) others[id].hp = hp;
  });

  socket.on('player_killed', ({ id, killerId }) => {
    const killerName = id === myId ? 'You' : (others[id]?.name || id.slice(0,4));
    const victimName = id === myId ? 'You' : (others[id]?.name || id.slice(0,4));
    addKillfeed(killerName, victimName, id === myId);

    if (id === myId) {
      myHp = 0; updateHUD();
      document.getElementById('death-overlay').classList.remove('hidden');
      if (controls.isLocked) controls.unlock();
    } else {
      if (others[id]) {
        scene.remove(others[id].mesh);
        delete others[id];
      }
    }
  });

  socket.on('shot_fired', ({ id, from, dir }) => {
    showBulletTracer(new THREE.Vector3(from.x, from.y, from.z),
                     new THREE.Vector3(dir.x,  dir.y,  dir.z));
  });

  socket.on('shot_blocked', ({ id }) => {
    if (id === myId) flashShield();
  });

  socket.on('trap_placed', trap => {
    addTrapMesh(trap);
  });

  socket.on('trap_triggered', ({ trapId, id, hp, blocked }) => {
    removeTrap(trapId);
    if (id === myId) {
      if (!blocked) { myHp = hp; updateHUD(); flashDamage(); }
      else           flashShield();
    }
  });

  socket.on('item_picked', ({ itemId }) => {
    removeItem(itemId);
  });

  socket.on('inventory_update', ({ hp, ammo, hasTrapKit }) => {
    if (hp        !== undefined) myHp      = hp;
    if (ammo      !== undefined) myAmmo    = ammo;
    if (hasTrapKit !== undefined) myHasTrap = hasTrapKit;
    updateHUD();
  });

  socket.on('ammo_update', ({ ammo }) => {
    myAmmo = ammo; updateHUD();
  });

  socket.on('ability_started', ({ id, ability }) => {
    const o = others[id]; if (!o) return;
    if (ability === 'cloak') {
      o.cloaked = true;
      o.mesh.traverse(c => { if (c.isMesh) { c.material.transparent = true; c.material.opacity = 0.12; } });
    }
    if (ability === 'shield') {
      addShieldBubbleTo(o.mesh);
    }
  });

  socket.on('ability_ended', ({ id, ability }) => {
    const o = others[id]; if (!o) return;
    if (ability === 'cloak') {
      o.cloaked = false;
      o.mesh.traverse(c => { if (c.isMesh) { c.material.transparent = false; c.material.opacity = 1; } });
    }
    if (ability === 'shield') {
      removeShieldBubbleFrom(o.mesh);
    }
  });

  socket.on('exit_open', () => {
    exitOpen = true;
    clearInterval(exitCountdown);
    document.getElementById('hud-timer').classList.add('hidden');
    if (exitMarker) {
      exitMarker.material.color.set(0x00ff88);
      exitMarker.material.emissive.set(0x00ff44);
      exitMarker.material.emissiveIntensity = 1;
    }
    if (exitLight) { exitLight.color.set(0x00ff88); exitLight.intensity = 1.5; }
    showMessage('🚪 The exit is now OPEN!');
  });

  socket.on('player_left', ({ id }) => {
    if (others[id]) { scene.remove(others[id].mesh); delete others[id]; }
  });

  socket.on('game_over', (data) => {
    endGame(data);
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  MENU UI
// ════════════════════════════════════════════════════════════════════════════
function setupMenuUI() {
  // Create
  document.getElementById('btn-create').addEventListener('click', () => {
    const name = getInputName(); if (!name) return;
    socket.emit('create_room', { name });
  });

  // Join
  document.getElementById('btn-join').addEventListener('click', () => {
    const name = getInputName(); if (!name) return;
    const code = document.getElementById('input-code').value.trim();
    if (code.length !== 4) { showError('menu-error', 'Enter a 4-letter code'); return; }
    socket.emit('join_room', { code, name });
  });
  document.getElementById('input-code').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-join').click();
  });

  // Copy code
  document.getElementById('btn-copy-code').addEventListener('click', () => {
    navigator.clipboard.writeText(roomCode).catch(() => {});
    document.getElementById('btn-copy-code').textContent = '✓';
    setTimeout(() => document.getElementById('btn-copy-code').textContent = '⎘', 1500);
  });

  // Start game
  document.getElementById('btn-start').addEventListener('click', () => {
    socket.emit('start_game');
  });

  // Character cards
  document.querySelectorAll('.char-card').forEach(card => {
    card.addEventListener('click', () => {
      if (card.classList.contains('taken-card')) return;
      const char = card.dataset.char;
      socket.emit('select_character', { character: char });
      document.querySelectorAll('.char-card').forEach(c => c.classList.remove('selected-card'));
      card.classList.add('selected-card');
      myChar = char;
    });
  });

  // Play again
  document.getElementById('btn-again').addEventListener('click', () => {
    location.reload();
  });
}

function getInputName() {
  const v = document.getElementById('input-name').value.trim();
  if (!v) { showError('menu-error', 'Please enter your name'); return null; }
  return v;
}

function updateLobbyUI(state) {
  const ul      = document.getElementById('player-list');
  const startBtn = document.getElementById('btn-start');
  const hint     = document.getElementById('lobby-hint');
  ul.innerHTML  = '';

  state.players.forEach(p => {
    const li = document.createElement('li');
    if (p.id === myId) li.classList.add('is-me');
    const crown = p.id === state.host ? '<span class="host-crown">👑</span>' : '';
    const meta  = p.character ? CHAR_META[p.character] : null;
    const charStr = meta
      ? `<span class="p-char" style="color:${meta.colorHex}">${meta.name}</span>`
      : `<span class="p-char">Picking…</span>`;
    li.innerHTML = `<span>${crown}${p.name}${p.id === myId ? ' (you)' : ''}</span>${charStr}`;
    ul.appendChild(li);
  });

  // Lock taken characters
  const takenChars = state.players.filter(p => p.id !== myId && p.character).map(p => p.character);
  document.querySelectorAll('.char-card').forEach(card => {
    const ch = card.dataset.char;
    const taken = takenChars.includes(ch);
    card.classList.toggle('taken-card', taken);
    card.querySelector('.char-taken').classList.toggle('hidden', !taken);
  });

  // Show start button for host
  const allReady = state.players.length >= 2 && state.players.every(p => p.character);
  if (isHost) {
    startBtn.classList.toggle('hidden', false);
    startBtn.disabled = !allReady;
    startBtn.style.opacity = allReady ? '1' : '.4';
    hint.textContent = allReady ? 'Ready to start!' : 'Waiting for all players to pick a character…';
  } else {
    startBtn.classList.add('hidden');
    hint.textContent = 'Waiting for host to start…';
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  GAME START  –  build the 3D world
// ════════════════════════════════════════════════════════════════════════════
function startGame({ maze, players, items, width, height, exitCX, exitCY }) {
  mazeData = { cells: maze, width, height };

  // Reset state
  wallBoxes  = [];
  groundItems = [];
  groundTraps = [];
  Object.keys(others).forEach(id => { scene.remove(others[id].mesh); delete others[id]; });
  while (scene.children.length) scene.remove(scene.children[0]);
  scene.add(camera);

  exitOpen  = false;
  abilityActive  = false;
  abilityEndTime = 0;
  abilityCdEnd   = 0;

  buildLights();
  buildMaze(maze, width, height, exitCX, exitCY);

  // Spawn items
  items.forEach(item => addItemMesh(item));

  // Spawn remote players + position my camera
  const me = players.find(p => p.id === myId);
  myChar   = me.character;
  const meta = CHAR_META[myChar];
  myHp     = meta.maxHp;
  myMaxHp  = meta.maxHp;
  myAmmo   = 0;
  myHasTrap = false;
  camera.position.set(me.x, EYE_H, me.z);

  players.forEach(p => {
    if (p.id !== myId) addOtherPlayer(p);
  });

  // Gun mesh (child of camera, always visible bottom-right)
  const gunGeo = new THREE.BoxGeometry(0.07, 0.07, 0.28);
  const gunMat = new THREE.MeshLambertMaterial({ color: 0x444455 });
  gunMesh = new THREE.Mesh(gunGeo, gunMat);
  gunMesh.position.set(0.22, -0.16, -0.38);
  gunMesh.visible = false;
  camera.add(gunMesh);

  // Exit countdown
  let secsLeft = 45;
  document.getElementById('timer-val').textContent = secsLeft;
  document.getElementById('hud-timer').classList.remove('hidden');
  exitCountdown = setInterval(() => {
    secsLeft--;
    document.getElementById('timer-val').textContent = Math.max(0, secsLeft);
    if (secsLeft <= 0) clearInterval(exitCountdown);
  }, 1000);

  showScreen('game');
  updateHUD();
  document.getElementById('death-overlay').classList.add('hidden');
  controls.lock();
}

// ─── Lights ──────────────────────────────────────────────────────────────────
function buildLights() {
  scene.add(new THREE.AmbientLight(0x9090b8, 0.6));
  const dir = new THREE.DirectionalLight(0xffffff, 0.5);
  dir.position.set(10, 20, 10);
  dir.castShadow = true;
  dir.shadow.mapSize.set(1024, 1024);
  scene.add(dir);
}

// ─── Maze geometry ───────────────────────────────────────────────────────────
function buildMaze(cells, W, H, exitCX, exitCY) {
  const wallMat  = new THREE.MeshLambertMaterial({ color: 0x3a3a60 });
  const floorMat = new THREE.MeshLambertMaterial({ color: 0x252535 });
  const ceilMat  = new THREE.MeshLambertMaterial({ color: 0x1a1a2a });

  // Floor & ceiling
  const floorGeo = new THREE.PlaneGeometry(W * CELL, H * CELL);
  const floor    = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(W * CELL / 2, 0, H * CELL / 2);
  floor.receiveShadow = true;
  scene.add(floor);

  const ceilGeo = new THREE.PlaneGeometry(W * CELL, H * CELL);
  const ceil    = new THREE.Mesh(ceilGeo, ceilMat);
  ceil.rotation.x = Math.PI / 2;
  ceil.position.set(W * CELL / 2, WALL_H, H * CELL / 2);
  scene.add(ceil);

  // Helper – add a wall segment and register its AABB
  function addWall(x, z, sizeX, sizeZ) {
    const geo  = new THREE.BoxGeometry(sizeX, WALL_H, sizeZ);
    const mesh = new THREE.Mesh(geo, wallMat);
    mesh.position.set(x + sizeX / 2, WALL_H / 2, z + sizeZ / 2);
    mesh.castShadow    = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    wallBoxes.push({ minX: x, maxX: x + sizeX, minZ: z, maxZ: z + sizeZ });
  }

  for (let cy = 0; cy < H; cy++) {
    for (let cx = 0; cx < W; cx++) {
      const cell = cells[cy][cx];
      const wx   = cx * CELL;
      const wz   = cy * CELL;

      // North wall
      if (cell.n) addWall(wx, wz, CELL, WALL_T);
      // West wall
      if (cell.w) addWall(wx, wz, WALL_T, CELL);
      // South border (only for last row)
      if (cy === H - 1 && cell.s) addWall(wx, wz + CELL, CELL, WALL_T);
      // East border (only for last column)
      if (cx === W - 1 && cell.e) addWall(wx + CELL, wz, WALL_T, CELL);
    }
  }

  // Exit marker
  exitPos.x = exitCX * CELL + CELL / 2;
  exitPos.z = exitCY * CELL + CELL / 2;

  const ringGeo  = new THREE.TorusGeometry(1.1, 0.18, 8, 32);
  const ringMat  = new THREE.MeshBasicMaterial({ color: 0x444466, emissive: 0x0, emissiveIntensity: 0 });
  exitMarker     = new THREE.Mesh(ringGeo, ringMat);
  exitMarker.rotation.x = Math.PI / 2;
  exitMarker.position.set(exitPos.x, 0.06, exitPos.z);
  scene.add(exitMarker);

  // Exit glow light (dim until open)
  exitLight = new THREE.PointLight(0x334466, 0.3, 8);
  exitLight.position.set(exitPos.x, 1.5, exitPos.z);
  scene.add(exitLight);

  // Ceiling lights scattered in maze
  for (let i = 0; i < 12; i++) {
    const lx = (Math.floor(Math.random() * W) + 0.5) * CELL;
    const lz = (Math.floor(Math.random() * H) + 0.5) * CELL;
    const pl = new THREE.PointLight(0x8080cc, 0.3, 10);
    pl.position.set(lx, WALL_H - 0.2, lz);
    scene.add(pl);
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  OTHER PLAYERS
// ════════════════════════════════════════════════════════════════════════════
function addOtherPlayer(p) {
  const meta   = CHAR_META[p.character];
  const group  = new THREE.Group();

  // Body
  const bodyGeo = new THREE.CapsuleGeometry(0.35, 0.8, 4, 8);
  const bodyMat = new THREE.MeshLambertMaterial({ color: meta.color });
  const body    = new THREE.Mesh(bodyGeo, bodyMat);
  body.position.y = 0.9;
  group.add(body);

  // Head
  const headGeo = new THREE.SphereGeometry(0.28, 8, 8);
  const headMat = new THREE.MeshLambertMaterial({ color: meta.color });
  const head    = new THREE.Mesh(headGeo, headMat);
  head.position.y = 1.65;
  group.add(head);

  // Name label (sprite)
  const sprite   = makeNameSprite(p.name, meta.colorHex);
  sprite.position.y = 2.1;
  group.add(sprite);

  group.position.set(p.x, 0, p.z);
  scene.add(group);

  others[p.id] = { mesh: group, name: p.name, char: p.character, hp: p.hp, cloaked: false };
}

function makeNameSprite(name, colorHex) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 48;
  const ctx = c.getContext('2d');
  ctx.fillStyle = colorHex;
  ctx.font = 'bold 28px sans-serif';
  ctx.textAlign = 'center';
  ctx.shadowColor = '#000'; ctx.shadowBlur = 6;
  ctx.fillText(name, 128, 32);
  const tex = new THREE.CanvasTexture(c);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sp  = new THREE.Sprite(mat);
  sp.scale.set(1.8, 0.35, 1);
  return sp;
}

function addShieldBubbleTo(mesh) {
  const geo = new THREE.SphereGeometry(0.9, 12, 12);
  const mat = new THREE.MeshBasicMaterial({ color: 0x4a90d9, transparent: true, opacity: 0.28, side: THREE.BackSide });
  const bubble = new THREE.Mesh(geo, mat);
  bubble.position.y = 1;
  bubble.name = '__shield__';
  mesh.add(bubble);
}

function removeShieldBubbleFrom(mesh) {
  const b = mesh.getObjectByName('__shield__');
  if (b) mesh.remove(b);
}

// ════════════════════════════════════════════════════════════════════════════
//  ITEMS
// ════════════════════════════════════════════════════════════════════════════
const ITEM_COLORS = { gun: 0xffcc00, trap_kit: 0xff6633, health: 0x55ff88 };

function addItemMesh(item) {
  const geo  = new THREE.BoxGeometry(0.35, 0.35, 0.35);
  const mat  = new THREE.MeshLambertMaterial({ color: ITEM_COLORS[item.type] ?? 0xffffff, emissive: ITEM_COLORS[item.type] ?? 0x0, emissiveIntensity: 0.4 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(item.x, 0.4, item.z);
  scene.add(mesh);
  groundItems.push({ id: item.id, type: item.type, x: item.x, z: item.z, mesh });
}

function removeItem(id) {
  const idx = groundItems.findIndex(i => i.id === id);
  if (idx === -1) return;
  scene.remove(groundItems[idx].mesh);
  groundItems.splice(idx, 1);
}

// ════════════════════════════════════════════════════════════════════════════
//  TRAPS
// ════════════════════════════════════════════════════════════════════════════
function addTrapMesh(trap) {
  const geo  = new THREE.CylinderGeometry(0.45, 0.45, 0.06, 16);
  const mat  = new THREE.MeshLambertMaterial({
    color:    trap.placedBy === myId ? 0xff6600 : 0xaa2200,
    emissive: 0x440000, emissiveIntensity: 0.5,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(trap.x, 0.03, trap.z);
  scene.add(mesh);
  groundTraps.push({ ...trap, mesh });
}

function removeTrap(id) {
  const idx = groundTraps.findIndex(t => t.id === id);
  if (idx === -1) return;
  scene.remove(groundTraps[idx].mesh);
  groundTraps.splice(idx, 1);
}

// ════════════════════════════════════════════════════════════════════════════
//  INTERACTION (E key)
// ════════════════════════════════════════════════════════════════════════════
function handleInteract() {
  if (!controls.isLocked) return;
  const px = camera.position.x, pz = camera.position.z;

  // Pick up nearest item
  for (const item of groundItems) {
    const d = Math.hypot(px - item.x, pz - item.z);
    if (d < 1.8) { socket.emit('pick_item', { itemId: item.id }); return; }
  }

  // Place trap
  if (myHasTrap) {
    socket.emit('place_trap', { x: px, z: pz });
  }
}

function checkPickupPrompt() {
  const px = camera.position.x, pz = camera.position.z;
  const near = groundItems.some(i => Math.hypot(px - i.x, pz - i.z) < 1.8)
            || (myHasTrap);
  const el = document.getElementById('pickup-prompt');
  if (near) {
    el.classList.remove('hidden');
    el.textContent = myHasTrap && !groundItems.some(i => Math.hypot(px - i.x, pz - i.z) < 1.8)
      ? 'Press E to place trap'
      : 'Press E to pick up';
  } else {
    el.classList.add('hidden');
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  SHOOTING
// ════════════════════════════════════════════════════════════════════════════
function tryShoot() {
  if (myAmmo <= 0 || Date.now() < shootCdEnd) return;
  shootCdEnd = Date.now() + 400;

  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);

  // Collect all other-player meshes
  const meshList = [];
  const meshToId = new Map();
  for (const [id, o] of Object.entries(others)) {
    o.mesh.traverse(c => { if (c.isMesh) { meshList.push(c); meshToId.set(c, id); } });
  }

  const hits   = raycaster.intersectObjects(meshList, false);
  let   hitId  = null;
  if (hits.length > 0) {
    hitId = meshToId.get(hits[0].object) ?? null;
  }

  const dir  = new THREE.Vector3();
  camera.getWorldDirection(dir);
  const from = camera.position.clone();

  socket.emit('shoot', {
    from:  { x: from.x, y: from.y, z: from.z },
    dir:   { x: dir.x,  y: dir.y,  z: dir.z  },
    hitId,
  });

  showBulletTracer(from, dir);
  animateGunRecoil();
}

function showBulletTracer(from, dir) {
  const mat = new THREE.LineBasicMaterial({ color: 0xffee88, transparent: true, opacity: 0.9 });
  const end = from.clone().addScaledVector(dir, 25);
  const geo = new THREE.BufferGeometry().setFromPoints([from, end]);
  const line = new THREE.Line(geo, mat);
  scene.add(line);
  setTimeout(() => { scene.remove(line); geo.dispose(); mat.dispose(); }, 80);
}

function animateGunRecoil() {
  if (!gunMesh) return;
  gunMesh.position.z = -0.3;
  setTimeout(() => { if (gunMesh) gunMesh.position.z = -0.38; }, 80);
}

// ════════════════════════════════════════════════════════════════════════════
//  ABILITY (F key)
// ════════════════════════════════════════════════════════════════════════════
function handleAbility() {
  if (!controls.isLocked || abilityActive || Date.now() < abilityCdEnd) return;
  const meta = CHAR_META[myChar];
  if (!meta) return;

  abilityActive  = true;
  abilityEndTime = Date.now() + meta.abilityDur;
  abilityCdEnd   = Date.now() + meta.abilityCd;

  socket.emit('ability_start', { ability: meta.ability });

  if (myChar === 'tank') {
    // Show own shield bubble
    if (!shieldBubble) {
      const geo = new THREE.SphereGeometry(0.9, 12, 12);
      const mat = new THREE.MeshBasicMaterial({ color: 0x4a90d9, transparent: true, opacity: 0.3, side: THREE.BackSide });
      shieldBubble = new THREE.Mesh(geo, mat);
      shieldBubble.position.copy(camera.position);
      shieldBubble.position.y = EYE_H - 0.7;
      scene.add(shieldBubble);
    }
  }

  setTimeout(() => {
    abilityActive = false;
    socket.emit('ability_end', { ability: meta.ability });
    if (myChar === 'tank' && shieldBubble) {
      scene.remove(shieldBubble); shieldBubble = null;
    }
  }, meta.abilityDur);
}

// ════════════════════════════════════════════════════════════════════════════
//  MOVEMENT + COLLISION
// ════════════════════════════════════════════════════════════════════════════
function updateMovement(delta) {
  if (!controls.isLocked) return;

  const meta  = CHAR_META[myChar] ?? CHAR_META.scout;
  let   speed = meta.speed;
  if (myChar === 'scout' && abilityActive) speed *= 2.0;

  const dir   = new THREE.Vector3();
  camera.getWorldDirection(dir);
  dir.y = 0; dir.normalize();

  const right = new THREE.Vector3();
  right.crossVectors(dir, camera.up).normalize();

  const move = new THREE.Vector3();
  if (keys['KeyW'] || keys['ArrowUp'])    move.addScaledVector(dir,   speed * delta);
  if (keys['KeyS'] || keys['ArrowDown'])  move.addScaledVector(dir,  -speed * delta);
  if (keys['KeyA'] || keys['ArrowLeft'])  move.addScaledVector(right, -speed * delta);
  if (keys['KeyD'] || keys['ArrowRight']) move.addScaledVector(right,  speed * delta);

  const isMoving = move.lengthSq() > 0;

  // Separate-axis collision
  const posX = camera.position.clone(); posX.x += move.x;
  if (!collidesWithWalls(posX.x, posX.z)) camera.position.x = posX.x;

  const posZ = camera.position.clone(); posZ.z += move.z;
  if (!collidesWithWalls(posZ.x, posZ.z)) camera.position.z = posZ.z;

  camera.position.y = EYE_H;

  // Head-bob
  if (isMoving && controls.isLocked) {
    bobT += delta * speed * 2.5;
    camera.position.y = EYE_H + Math.sin(bobT) * BOB_AMP;
  }

  // Shield bubble follows player
  if (shieldBubble) {
    shieldBubble.position.copy(camera.position);
    shieldBubble.position.y = EYE_H - 0.7;
  }

  // Send position ~20×/s
  const now = Date.now();
  if (now - lastSentTime > 50) {
    lastSentTime = now;
    socket.emit('player_update', {
      x: camera.position.x,
      y: camera.position.y,
      z: camera.position.z,
      rotY: camera.rotation.y,
    });
  }
}

function collidesWithWalls(x, z) {
  for (const b of wallBoxes) {
    if (x + P_RADIUS > b.minX && x - P_RADIUS < b.maxX &&
        z + P_RADIUS > b.minZ && z - P_RADIUS < b.maxZ) return true;
  }
  return false;
}

// ─── Trap stepping ───────────────────────────────────────────────────────────
function checkTraps() {
  const px = camera.position.x, pz = camera.position.z;
  for (const trap of [...groundTraps]) {
    if (trap.placedBy === myId) continue;
    if (Math.hypot(px - trap.x, pz - trap.z) < 0.7) {
      socket.emit('step_trap', { trapId: trap.id });
      // optimistically remove
      removeTrap(trap.id);
    }
  }
}

// ─── Exit check ──────────────────────────────────────────────────────────────
function checkExit() {
  if (!exitOpen) return;
  const dx = camera.position.x - exitPos.x;
  const dz = camera.position.z - exitPos.z;
  if (Math.hypot(dx, dz) < 1.3) {
    socket.emit('reached_exit');
    exitOpen = false; // prevent double-fire
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  HUD
// ════════════════════════════════════════════════════════════════════════════
function updateHUD() {
  // Health bar
  const pct    = Math.max(0, myHp / myMaxHp);
  const hpBar  = document.getElementById('hp-bar');
  hpBar.style.width = `${pct * 100}%`;
  hpBar.classList.toggle('low', pct < 0.25);
  hpBar.classList.toggle('mid', pct >= 0.25 && pct < 0.5);
  document.getElementById('hp-num').textContent = Math.max(0, myHp);

  // Ammo
  document.getElementById('ammo-count').textContent = myAmmo;

  // Trap
  const trapEl = document.getElementById('inv-trap');
  trapEl.classList.toggle('inv-hidden', !myHasTrap);

  // Gun mesh visibility
  if (gunMesh) gunMesh.visible = myAmmo > 0;
}

function drawAbility(now) {
  const ctx  = abilityCtx;
  const S    = 64;
  ctx.clearRect(0, 0, S, S);

  const meta = CHAR_META[myChar];
  if (!meta) return;

  // Background circle
  ctx.beginPath(); ctx.arc(S/2, S/2, S/2-2, 0, Math.PI*2);
  ctx.fillStyle = '#11112288'; ctx.fill();

  if (abilityActive) {
    // Active – pulsing
    const progress = 1 - (abilityEndTime - now) / meta.abilityDur;
    ctx.beginPath(); ctx.arc(S/2, S/2, S/2-4, -Math.PI/2, -Math.PI/2 + Math.PI*2*(1-progress));
    ctx.strokeStyle = meta.colorHex; ctx.lineWidth = 5; ctx.stroke();
    ctx.fillStyle = meta.colorHex + '44';
    ctx.beginPath(); ctx.arc(S/2, S/2, S/2-2, 0, Math.PI*2); ctx.fill();
  } else if (now < abilityCdEnd) {
    // On cooldown – show fill draining
    const cdFrac = (abilityCdEnd - now) / meta.abilityCd;
    ctx.beginPath(); ctx.arc(S/2, S/2, S/2-4, -Math.PI/2, -Math.PI/2 + Math.PI*2*(1-cdFrac));
    ctx.strokeStyle = '#444466'; ctx.lineWidth = 5; ctx.stroke();
    ctx.fillStyle = '#ffffff22';
    ctx.beginPath(); ctx.arc(S/2, S/2, S/2-4, -Math.PI/2, -Math.PI/2 - Math.PI*2*cdFrac, true);
    ctx.lineTo(S/2, S/2); ctx.closePath();
    ctx.fillStyle = '#00000077'; ctx.fill();
  } else {
    // Ready
    ctx.beginPath(); ctx.arc(S/2, S/2, S/2-4, 0, Math.PI*2);
    ctx.strokeStyle = meta.colorHex; ctx.lineWidth = 4; ctx.stroke();
  }

  // Icon emoji
  const icons = { sprint: '⚡', shield: '🛡️', cloak: '👻' };
  ctx.font = '26px serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(icons[meta.ability] ?? 'F', S/2, S/2);

  // Key hint
  document.getElementById('ability-label').textContent =
    now < abilityCdEnd && !abilityActive
      ? `${Math.ceil((abilityCdEnd - now) / 1000)}s`
      : '[F]';
}

function drawMinimap() {
  if (!mazeData) return;
  const { cells, width, height } = mazeData;
  const S  = 150;
  const cs = S / Math.max(width, height);

  minimapCtx.fillStyle = '#00000099';
  minimapCtx.fillRect(0, 0, S, S);

  // Walls
  minimapCtx.strokeStyle = '#5555aa';
  minimapCtx.lineWidth   = 1;
  for (let cy = 0; cy < height; cy++) {
    for (let cx = 0; cx < width; cx++) {
      const cell = cells[cy][cx];
      const px = cx * cs, pz = cy * cs;
      if (cell.n) { minimapCtx.beginPath(); minimapCtx.moveTo(px, pz); minimapCtx.lineTo(px+cs, pz); minimapCtx.stroke(); }
      if (cell.w) { minimapCtx.beginPath(); minimapCtx.moveTo(px, pz); minimapCtx.lineTo(px, pz+cs); minimapCtx.stroke(); }
      if (cy === height-1 && cell.s) { minimapCtx.beginPath(); minimapCtx.moveTo(px, pz+cs); minimapCtx.lineTo(px+cs, pz+cs); minimapCtx.stroke(); }
      if (cx === width-1  && cell.e) { minimapCtx.beginPath(); minimapCtx.moveTo(px+cs, pz); minimapCtx.lineTo(px+cs, pz+cs); minimapCtx.stroke(); }
    }
  }

  // Exit
  const ex = (exitPos.x / CELL) * cs;
  const ez = (exitPos.z / CELL) * cs;
  minimapCtx.fillStyle = exitOpen ? '#00ff88' : '#334455';
  minimapCtx.fillRect(ex-3, ez-3, 6, 6);

  // Items
  minimapCtx.fillStyle = '#ffcc00';
  for (const item of groundItems) {
    minimapCtx.fillRect((item.x/CELL)*cs-1.5, (item.z/CELL)*cs-1.5, 3, 3);
  }

  // Traps (only show own)
  minimapCtx.fillStyle = '#ff6600';
  for (const t of groundTraps) {
    if (t.placedBy !== myId) continue;
    minimapCtx.fillRect((t.x/CELL)*cs-2, (t.z/CELL)*cs-2, 4, 4);
  }

  // Other players
  for (const [, o] of Object.entries(others)) {
    if (o.cloaked) continue;
    const meta = CHAR_META[o.char];
    minimapCtx.fillStyle = meta ? meta.colorHex : '#ffffff';
    minimapCtx.beginPath();
    minimapCtx.arc((o.mesh.position.x/CELL)*cs, (o.mesh.position.z/CELL)*cs, 3.5, 0, Math.PI*2);
    minimapCtx.fill();
  }

  // My position + direction arrow
  const mx = (camera.position.x/CELL)*cs;
  const mz = (camera.position.z/CELL)*cs;
  minimapCtx.fillStyle = '#ffffff';
  minimapCtx.beginPath(); minimapCtx.arc(mx, mz, 4, 0, Math.PI*2); minimapCtx.fill();

  const angle = camera.rotation.y;
  const al    = cs * 0.45;
  minimapCtx.strokeStyle = '#ffffff'; minimapCtx.lineWidth = 1.5;
  minimapCtx.beginPath();
  minimapCtx.moveTo(mx, mz);
  minimapCtx.lineTo(mx - Math.sin(angle)*al, mz - Math.cos(angle)*al);
  minimapCtx.stroke();
}

// ─── Visual feedback ─────────────────────────────────────────────────────────
function flashDamage() {
  const el = document.getElementById('damage-flash');
  el.style.background = '#ff000055';
  setTimeout(() => { el.style.background = '#ff000000'; }, 200);
}

function flashShield() {
  const el = document.getElementById('shield-flash');
  el.style.background = '#4a90d944';
  setTimeout(() => { el.style.background = '#4a90d900'; }, 300);
}

function showMessage(text, duration = 3000) {
  const el = document.getElementById('msg-flash');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(el._timeout);
  el._timeout = setTimeout(() => el.classList.add('hidden'), duration);
}

function addKillfeed(killerName, victimName, isMyDeath) {
  const kf   = document.getElementById('killfeed');
  const entry = document.createElement('div');
  entry.className = 'kf-entry';
  entry.innerHTML = isMyDeath
    ? `<span style="color:#ff6b6b">💀 You were eliminated</span>`
    : `<span>${killerName}</span> <span style="color:#ff6b6b">☠</span> <span>${victimName}</span>`;
  kf.prepend(entry);
  setTimeout(() => entry.remove(), 5000);
}

// ════════════════════════════════════════════════════════════════════════════
//  GAME OVER
// ════════════════════════════════════════════════════════════════════════════
function endGame({ winnerId, winnerName, reason, players }) {
  if (controls.isLocked) controls.unlock();
  clearInterval(exitCountdown);

  document.getElementById('go-winner').textContent =
    winnerId ? `🏆  ${winnerName} wins!` : '🤝  It\'s a draw!';

  const reasons = { exit: '🚪 Escaped through the exit', elimination: '⚔️  Last player standing', draw: 'Everyone perished…' };
  document.getElementById('go-reason').textContent = reasons[reason] ?? reason;

  const tbody = document.getElementById('go-tbody');
  tbody.innerHTML = '';
  players.forEach(p => {
    const tr = document.createElement('tr');
    if (p.name === winnerName) tr.classList.add('winner-row');
    const meta = CHAR_META[p.character];
    tr.innerHTML = `
      <td>${p.name}</td>
      <td style="color:${meta?.colorHex ?? '#fff'}">${meta?.name ?? '—'}</td>
      <td>${p.kills}</td>
      <td>${p.alive ? '✅ Alive' : '💀 Dead'}</td>`;
    tbody.appendChild(tr);
  });

  showScreen('gameover');
}

// ════════════════════════════════════════════════════════════════════════════
//  SCREEN MANAGEMENT
// ════════════════════════════════════════════════════════════════════════════
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const target = document.getElementById(`screen-${name}`);
  if (target) target.classList.add('active');
}

function showError(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

// ════════════════════════════════════════════════════════════════════════════
//  ANIMATION LOOP
// ════════════════════════════════════════════════════════════════════════════
function animate() {
  requestAnimationFrame(animate);

  const delta = Math.min(clock.getDelta(), 0.1);
  const now   = Date.now();

  if (document.getElementById('screen-game').classList.contains('active')) {
    updateMovement(delta);
    checkTraps();
    checkExit();
    checkPickupPrompt();

    // Animate exit ring
    if (exitMarker) {
      exitMarker.rotation.z += delta * (exitOpen ? 1.2 : 0.3);
    }

    // Animate item cubes
    for (const item of groundItems) {
      item.mesh.rotation.y += delta * 1.5;
      item.mesh.position.y  = 0.4 + Math.sin(now * 0.002 + item.id) * 0.07;
    }

    drawMinimap();
    drawAbility(now);
  }

  renderer.render(scene, camera);
}

// ════════════════════════════════════════════════════════════════════════════
//  BOOT
// ════════════════════════════════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', init);
