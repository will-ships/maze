// ════════════════════════════════════════════════════════════════════════════
//  MAZE RUNNERS — Three.js FPS client  v2
// ════════════════════════════════════════════════════════════════════════════
import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

// ── Config ────────────────────────────────────────────────────────────────
const CELL      = 4;
const WALL_H    = 3.2;
const WALL_T    = 0.3;
const EYE_H     = 1.7;
const P_RADIUS  = 0.38;
const BOB_AMP   = 0.04;
const MAX_LIVES = 3;

const CHAR_META = {
  scout:     { name:'Scout',     color:0xE8855A, hex:'#E8855A', maxHp:100, speed:6.5, ability:'sprint',  abilityDur:3000,  abilityCd:15000 },
  tank:      { name:'Tank',      color:0x4A90D9, hex:'#4A90D9', maxHp:150, speed:4.0, ability:'shield',  abilityDur:2000,  abilityCd:20000 },
  trickster: { name:'Trickster', color:0x9B59B6, hex:'#9B59B6', maxHp:100, speed:5.0, ability:'cloak',   abilityDur:3000,  abilityCd:18000 },
  phantom:   { name:'Phantom',   color:0x00E5CC, hex:'#00E5CC', maxHp:90,  speed:5.2, ability:'phase',   abilityDur:2500,  abilityCd:22000 },
};

const ITEM_COLORS = { gun:0xffcc00, trap_kit:0xff6633, health:0x55ff88 };

// ── Socket & state ────────────────────────────────────────────────────────
const socket = window.io();
let myId = '', myChar = '', roomCode = '', isHost = false;

// Three.js
let scene, camera, renderer, controls, clock;
let wallBoxes = [];   // {minX,maxX,minZ,maxZ}

// Scene objects
let exitMarker = null, exitLight = null;
let exitPos    = { x:0, z:0 };
let exitOpen   = false;
let gunMesh    = null, shieldBubble = null;

// Remote players { id → {mesh, name, char, cloaked, shieldBubble} }
const others = {};

// Ground objects
let groundItems = []; // {id,type,x,z,mesh}
let groundTraps = []; // {id,placedBy,x,z,visible,laserDir?,mesh,laserMesh?}

// Player stats
let myHp=100, myMaxHp=100, myAmmo=0, myHasTrap=false, myLives=MAX_LIVES;

// Ability
let abilityActive=false, abilityEndTime=0, abilityCdEnd=0;
let phaseActive=false;

// Grace period
let gracePeriodEnd = 0;
let graceInterval  = null;
let myGraceEnd     = 0;   // per-player respawn grace

// Bullets flying through the scene
const activeBullets = [];

// Input
const keys = {};
let shootCdEnd = 0, lastSent = 0, bobT = 0;

// Minimap / ability canvas
let minimapCanvas, minimapCtx, abilityCanvas, abilityCtx;
let mazeData = null;

// ════════════════════════════════════════════════════════════════════════════
//  INIT
// ════════════════════════════════════════════════════════════════════════════
function init() {
  minimapCanvas = document.getElementById('minimap');
  minimapCtx    = minimapCanvas.getContext('2d');
  abilityCanvas = document.getElementById('ability-canvas');
  abilityCtx    = abilityCanvas.getContext('2d');

  scene    = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0a18);
  scene.fog = new THREE.FogExp2(0x0a0a18, 0.042);

  camera   = new THREE.PerspectiveCamera(75, innerWidth/innerHeight, 0.05, 80);
  scene.add(camera);

  renderer = new THREE.WebGLRenderer({ antialias:true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
  document.getElementById('game-canvas').appendChild(renderer.domElement);

  controls = new PointerLockControls(camera, renderer.domElement);
  controls.addEventListener('lock',   () => { document.getElementById('lock-overlay').style.display='none'; });
  controls.addEventListener('unlock', () => {
    if (document.getElementById('screen-game').classList.contains('active'))
      document.getElementById('lock-overlay').style.display='flex';
  });

  clock = new THREE.Clock();

  window.addEventListener('resize', () => {
    camera.aspect = innerWidth/innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  window.addEventListener('keydown', e => {
    keys[e.code] = true;
    if (e.code === 'KeyE') handleInteract();
    if (e.code === 'KeyF') handleAbility();
  });
  window.addEventListener('keyup', e => { keys[e.code]=false; });

  window.addEventListener('mousedown', e => {
    if (e.button===0 && controls.isLocked) tryShoot();
  });

  document.getElementById('game-canvas').addEventListener('click', () => {
    if (document.getElementById('screen-game').classList.contains('active'))
      controls.lock();
  });

  setupSocket();
  setupMenuUI();
  animate();
}

// ════════════════════════════════════════════════════════════════════════════
//  PROCEDURAL BRICK TEXTURE
// ════════════════════════════════════════════════════════════════════════════
function createWallTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const ctx = c.getContext('2d');

  // Mortar background
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, 128, 128);

  const bW = 32, bH = 14;
  for (let row = 0; row < Math.ceil(128/bH); row++) {
    const offset = (row % 2) ? bW/2 : 0;
    for (let col = -1; col < Math.ceil(128/bW)+1; col++) {
      const x = col*bW + offset, y = row*bH;
      const shade = 38 + Math.floor(Math.random()*18);
      ctx.fillStyle = `rgb(${shade+8},${shade},${shade+18})`;
      ctx.fillRect(x+1, y+1, bW-2, bH-2);
      // subtle highlight top edge
      ctx.fillStyle = `rgba(255,255,255,0.04)`;
      ctx.fillRect(x+1, y+1, bW-2, 2);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// ════════════════════════════════════════════════════════════════════════════
//  SOCKET SETUP
// ════════════════════════════════════════════════════════════════════════════
function setupSocket() {

  socket.on('room_created', ({ code, playerId }) => {
    myId=playerId; roomCode=code; isHost=true;
    document.getElementById('lobby-code').textContent = code;
    showScreen('lobby');
  });

  socket.on('room_joined', ({ code, playerId }) => {
    myId=playerId; roomCode=code; isHost=false;
    document.getElementById('lobby-code').textContent = code;
    showScreen('lobby');
  });

  socket.on('room_state', state => updateLobbyUI(state));
  socket.on('join_error', msg => { showError('menu-error',msg); showError('lobby-error',msg); });

  socket.on('game_start', data => startGame(data));

  // ── In-game ──────────────────────────────────────────────────────────────

  socket.on('player_moved', ({ id, x, y, z, rotY }) => {
    const o = others[id]; if (!o) return;
    o.mesh.position.set(x, 0, z);
    o.mesh.rotation.y = rotY;
  });

  socket.on('player_hit', ({ id, hp }) => {
    if (id===myId) { myHp=hp; updateHUD(); flashDamage(); }
    else if (others[id]) others[id].hp = hp;
  });

  socket.on('player_killed', ({ id, killerId, livesLeft }) => {
    if (id===myId) {
      myLives = livesLeft;
      myHp    = 0;
      updateHUD();
      showDeathOverlay(livesLeft);
    } else {
      if (others[id]) { scene.remove(others[id].mesh); delete others[id]; }
    }
    const killerName = killerId===myId ? 'You' : (others[killerId]?.name ?? killerId.slice(0,4));
    const victimName = id===myId       ? 'You' : (others[id]?.name      ?? id.slice(0,4));
    addKillfeed(killerName, victimName, id===myId);
  });

  socket.on('player_respawn', ({ id, x, y, z, hp, lives, noKillUntil }) => {
    if (id===myId) {
      myHp    = hp;
      myLives = lives;
      myGraceEnd = noKillUntil;
      camera.position.set(x, EYE_H, z);
      document.getElementById('death-overlay').classList.add('hidden');
      updateHUD();
      showMessage('✅ Respawned! 10-second protection active.');
      startPlayerGrace(noKillUntil);
      if (!controls.isLocked) controls.lock();
    } else {
      // Re-add remote player mesh if it was removed
      // (server sends full player data on respawn — use placeholder)
      if (!others[id]) {
        // We don't have char info here; skip (mesh will reappear on next player_moved)
      } else {
        others[id].mesh.position.set(x, 0, z);
      }
    }
  });

  socket.on('player_eliminated', ({ id }) => {
    if (id===myId) {
      document.getElementById('death-title').textContent = '💀 ELIMINATED';
      document.getElementById('death-sub').textContent   = 'No lives remaining — spectating';
      document.getElementById('respawn-count').style.display = 'none';
      document.getElementById('death-overlay').classList.remove('hidden');
    } else {
      if (others[id]) { scene.remove(others[id].mesh); delete others[id]; }
    }
    addKillfeed('', others[id]?.name ?? (id===myId?'You':id.slice(0,4)), id===myId, true);
  });

  socket.on('shot_fired', ({ id, from, dir }) => {
    spawnBullet(new THREE.Vector3(from.x,from.y,from.z),
                new THREE.Vector3(dir.x, dir.y, dir.z), false);
  });

  socket.on('shot_blocked', ({ id }) => {
    if (id===myId) flashShield();
  });

  socket.on('trap_placed',   trap => addTrapMesh(trap));
  socket.on('trap_defused',  ({ trapId }) => { removeTrap(trapId); showMessage('💣 Trap defused!'); });

  socket.on('trap_triggered', ({ trapId, id, hp, blocked }) => {
    removeTrap(trapId);
    if (id===myId) {
      if (!blocked) { myHp=hp; updateHUD(); flashDamage(); }
      else           flashShield();
    }
  });

  socket.on('item_picked', ({ itemId }) => removeItem(itemId));

  socket.on('inventory_update', ({ hp, ammo, hasTrapKit }) => {
    if (hp!==undefined)       myHp     =hp;
    if (ammo!==undefined)     myAmmo   =ammo;
    if (hasTrapKit!==undefined) myHasTrap=hasTrapKit;
    updateHUD();
  });

  socket.on('ammo_update', ({ ammo }) => { myAmmo=ammo; updateHUD(); });

  socket.on('ability_started', ({ id, ability }) => {
    const o=others[id]; if(!o) return;
    if (ability==='cloak') {
      o.cloaked=true;
      o.mesh.traverse(c=>{ if(c.isMesh){ c.material.transparent=true; c.material.opacity=0.12; } });
    }
    if (ability==='shield') addShieldBubbleTo(o.mesh);
    if (ability==='phase') {
      o.mesh.traverse(c=>{ if(c.isMesh){ c.material.transparent=true; c.material.opacity=0.45;
        c.material.color.set(0x00E5CC); } });
    }
  });

  socket.on('ability_ended', ({ id, ability }) => {
    const o=others[id]; if(!o) return;
    if (ability==='cloak') {
      o.cloaked=false;
      o.mesh.traverse(c=>{ if(c.isMesh){ c.material.transparent=false; c.material.opacity=1; } });
    }
    if (ability==='shield') removeShieldBubbleFrom(o.mesh);
    if (ability==='phase') {
      const meta = CHAR_META[o.char];
      o.mesh.traverse(c=>{ if(c.isMesh){ c.material.transparent=false; c.material.opacity=1;
        c.material.color.set(meta.color); } });
    }
  });

  socket.on('exit_open', () => {
    exitOpen=true;
    clearInterval(graceInterval);
    document.getElementById('hud-timer').classList.add('hidden');
    if (exitMarker) {
      exitMarker.material.color.set(0x00ff88);
      exitMarker.material.emissive?.set(0x00ff44);
    }
    if (exitLight) { exitLight.color.set(0x00ff88); exitLight.intensity=1.5; }
    showMessage('🚪 EXIT IS OPEN — Reach the bottom-right corner!');
  });

  socket.on('player_left', ({ id }) => {
    if (others[id]) { scene.remove(others[id].mesh); delete others[id]; }
  });

  socket.on('game_over', data => endGame(data));
}

// ════════════════════════════════════════════════════════════════════════════
//  MENU UI
// ════════════════════════════════════════════════════════════════════════════
function setupMenuUI() {
  document.getElementById('btn-create').addEventListener('click', () => {
    const name = getInputName(); if(!name) return;
    socket.emit('create_room', { name });
  });

  document.getElementById('btn-join').addEventListener('click', () => {
    const name = getInputName(); if(!name) return;
    const code = document.getElementById('input-code').value.trim();
    if (code.length!==4) { showError('menu-error','Enter a 4-letter code'); return; }
    socket.emit('join_room', { code, name });
  });

  document.getElementById('input-code').addEventListener('keydown', e => {
    if (e.key==='Enter') document.getElementById('btn-join').click();
  });

  document.getElementById('btn-copy-code').addEventListener('click', () => {
    navigator.clipboard.writeText(roomCode).catch(()=>{});
    document.getElementById('btn-copy-code').textContent='✓';
    setTimeout(()=>document.getElementById('btn-copy-code').textContent='⎘', 1500);
  });

  document.getElementById('btn-start').addEventListener('click', () => socket.emit('start_game'));

  // Character cards
  document.querySelectorAll('.char-card').forEach(card => {
    card.addEventListener('click', () => {
      if (card.classList.contains('taken-card')) return;
      const char = card.dataset.char;
      socket.emit('select_character', { character: char });
      document.querySelectorAll('.char-card').forEach(c=>c.classList.remove('selected-card'));
      card.classList.add('selected-card');
      myChar = char;
    });
  });

  // Difficulty buttons (host only)
  const DIFF_DESC = {
    easy:   'No pre-set traps',
    middle: 'Visible claymore traps — press E to defuse',
    hard:   'Visible + hidden corridor traps',
  };
  document.querySelectorAll('.diff-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!isHost) return;
      const diff = btn.dataset.diff;
      socket.emit('select_difficulty', { difficulty: diff });
    });
  });

  document.getElementById('btn-again').addEventListener('click', () => location.reload());
}

function getInputName() {
  const v = document.getElementById('input-name').value.trim();
  if (!v) { showError('menu-error','Please enter your name'); return null; }
  return v;
}

const DIFF_DESC = {
  easy:   'No pre-set traps',
  middle: 'Visible claymore traps — press E to defuse',
  hard:   'Visible + hidden corridor traps',
};

function updateLobbyUI(state) {
  const ul       = document.getElementById('player-list');
  const startBtn = document.getElementById('btn-start');
  const hint     = document.getElementById('lobby-hint');
  ul.innerHTML   = '';

  state.players.forEach(p => {
    const li   = document.createElement('li');
    if (p.id===myId) li.classList.add('is-me');
    const crown = p.id===state.host ? '<span class="host-crown">👑</span>' : '';
    const meta  = p.character ? CHAR_META[p.character] : null;
    const charStr = meta
      ? `<span class="p-char" style="color:${meta.hex}">${meta.name}</span>`
      : `<span class="p-char">Picking…</span>`;
    li.innerHTML = `<span>${crown}${p.name}${p.id===myId?' (you)':''}</span>${charStr}`;
    ul.appendChild(li);
  });

  // Taken characters
  const taken = state.players.filter(p=>p.id!==myId && p.character).map(p=>p.character);
  document.querySelectorAll('.char-card').forEach(card => {
    const t = taken.includes(card.dataset.char);
    card.classList.toggle('taken-card', t);
    card.querySelector('.char-taken').classList.toggle('hidden', !t);
  });

  // Difficulty UI
  const diff = state.difficulty || 'easy';
  document.querySelectorAll('.diff-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.diff===diff);
    if (!isHost) b.disabled = true;
  });
  document.getElementById('diff-desc').textContent = DIFF_DESC[diff];

  // Host start button
  const allReady = state.players.length>=1 && state.players.every(p=>p.character);
  if (isHost) {
    startBtn.classList.remove('hidden');
    startBtn.disabled = !allReady;
    hint.textContent  = allReady ? 'Ready to start!' : 'All players must pick a character…';
  } else {
    startBtn.classList.add('hidden');
    hint.textContent  = 'Waiting for host to start…';
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  GAME START
// ════════════════════════════════════════════════════════════════════════════
function startGame({ maze, players, items, traps, width, height, exitCX, exitCY, noKillUntil }) {
  mazeData = { cells:maze, width, height };

  // Reset
  wallBoxes=[]; groundItems=[]; groundTraps=[];
  activeBullets.length = 0;
  Object.keys(others).forEach(id=>{ scene.remove(others[id].mesh); delete others[id]; });
  while(scene.children.length) scene.remove(scene.children[0]);
  scene.add(camera);
  exitOpen=false; abilityActive=false; abilityEndTime=0; abilityCdEnd=0; phaseActive=false;

  buildLights();
  buildMaze(maze, width, height, exitCX, exitCY);
  items.forEach(i=>addItemMesh(i));
  traps.forEach(t=>addTrapMesh(t));   // env traps (difficulty-based)

  const me   = players.find(p=>p.id===myId);
  myChar     = me.character;
  myHp       = CHAR_META[myChar].maxHp;
  myMaxHp    = myHp;
  myAmmo     = 0; myHasTrap=false; myLives=MAX_LIVES;
  camera.position.set(me.x, EYE_H, me.z);

  players.forEach(p=>{ if(p.id!==myId) addOtherPlayer(p); });

  // Gun
  const gunGeo = new THREE.BoxGeometry(0.07,0.07,0.28);
  const gunMat2= new THREE.MeshLambertMaterial({color:0x444455});
  gunMesh      = new THREE.Mesh(gunGeo, gunMat2);
  gunMesh.position.set(0.22,-0.16,-0.38);
  gunMesh.visible = false;
  camera.add(gunMesh);

  // Exit timer countdown
  let secsLeft = 45;
  document.getElementById('timer-val').textContent = secsLeft;
  const timerEl = document.getElementById('hud-timer');
  timerEl.classList.remove('hidden');
  graceInterval = setInterval(()=>{
    secsLeft--;
    document.getElementById('timer-val').textContent = Math.max(0,secsLeft);
    if(secsLeft<=0) clearInterval(graceInterval);
  }, 1000);

  // Grace period (20 s no-kill)
  gracePeriodEnd = noKillUntil;
  startGraceBanner(noKillUntil);

  showScreen('game');
  updateHUD();
  document.getElementById('death-overlay').classList.add('hidden');
  controls.lock();
}

// ─── Lights ──────────────────────────────────────────────────────────────────
function buildLights() {
  scene.add(new THREE.AmbientLight(0x9090b8, 0.55));
  const dir = new THREE.DirectionalLight(0xffffff, 0.45);
  dir.position.set(10,20,10);
  dir.castShadow=true;
  dir.shadow.mapSize.set(1024,1024);
  scene.add(dir);
}

// ─── Maze geometry ────────────────────────────────────────────────────────────
function buildMaze(cells, W, H, exitCX, exitCY) {
  const wallTex  = createWallTexture();

  // Horizontal walls (x-wide, z-thin) — brick rows horizontal
  const wallMatH = new THREE.MeshLambertMaterial({ map: wallTex.clone() });
  wallMatH.map.repeat.set(CELL/2, WALL_H/2);

  // Vertical walls (x-thin, z-wide) — same texture rotated
  const wallMatV = new THREE.MeshLambertMaterial({ map: wallTex.clone() });
  wallMatV.map.repeat.set(CELL/2, WALL_H/2);

  const floorMat = new THREE.MeshLambertMaterial({ color:0x252535 });
  const ceilMat  = new THREE.MeshLambertMaterial({ color:0x14142a });

  // Floor
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W*CELL, H*CELL), floorMat);
  floor.rotation.x=-Math.PI/2; floor.position.set(W*CELL/2, 0, H*CELL/2);
  floor.receiveShadow=true; scene.add(floor);

  // Ceiling
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(W*CELL, H*CELL), ceilMat);
  ceil.rotation.x=Math.PI/2; ceil.position.set(W*CELL/2, WALL_H, H*CELL/2);
  scene.add(ceil);

  function addWall(x, z, sizeX, sizeZ, mat) {
    const geo  = new THREE.BoxGeometry(sizeX, WALL_H, sizeZ);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x+sizeX/2, WALL_H/2, z+sizeZ/2);
    mesh.castShadow=true; mesh.receiveShadow=true;
    scene.add(mesh);
    wallBoxes.push({ minX:x, maxX:x+sizeX, minZ:z, maxZ:z+sizeZ });
  }

  for (let cy=0; cy<H; cy++) {
    for (let cx=0; cx<W; cx++) {
      const cell=cells[cy][cx], wx=cx*CELL, wz=cy*CELL;
      if (cell.n) addWall(wx, wz, CELL,   WALL_T, wallMatH);
      if (cell.w) addWall(wx, wz, WALL_T, CELL,   wallMatV);
      if (cy===H-1 && cell.s) addWall(wx, wz+CELL, CELL,   WALL_T, wallMatH);
      if (cx===W-1 && cell.e) addWall(wx+CELL, wz, WALL_T, CELL,   wallMatV);
    }
  }

  // Exit marker (bottom-right = furthest from spawn)
  exitPos.x = exitCX*CELL + CELL/2;
  exitPos.z = exitCY*CELL + CELL/2;

  const ringGeo = new THREE.TorusGeometry(1.1, 0.18, 8, 32);
  const ringMat = new THREE.MeshBasicMaterial({ color:0x334455 });
  exitMarker    = new THREE.Mesh(ringGeo, ringMat);
  exitMarker.rotation.x=Math.PI/2;
  exitMarker.position.set(exitPos.x, 0.06, exitPos.z);
  scene.add(exitMarker);

  exitLight = new THREE.PointLight(0x334466, 0.3, 8);
  exitLight.position.set(exitPos.x, 1.5, exitPos.z);
  scene.add(exitLight);

  // Ambient ceiling lights
  for (let i=0; i<12; i++) {
    const lx=(Math.floor(Math.random()*W)+0.5)*CELL;
    const lz=(Math.floor(Math.random()*H)+0.5)*CELL;
    const pl=new THREE.PointLight(0x8080cc, 0.25, 10);
    pl.position.set(lx, WALL_H-0.2, lz);
    scene.add(pl);
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  OTHER PLAYERS
// ════════════════════════════════════════════════════════════════════════════
function addOtherPlayer(p) {
  const meta  = CHAR_META[p.character];
  const group = new THREE.Group();

  const isPhantom = p.character==='phantom';
  const opacity   = isPhantom ? 0.75 : 1;

  const bodyGeo = new THREE.CapsuleGeometry(0.35, 0.8, 4, 8);
  const bodyMat = new THREE.MeshLambertMaterial({ color:meta.color, transparent:isPhantom, opacity });
  group.add(Object.assign(new THREE.Mesh(bodyGeo, bodyMat), { position:{ y:0.9 } }));

  const headGeo = new THREE.SphereGeometry(0.28, 8, 8);
  const headMat = new THREE.MeshLambertMaterial({ color:meta.color, transparent:isPhantom, opacity });
  const head    = new THREE.Mesh(headGeo, headMat);
  head.position.y = 1.65;
  group.add(head);

  const sprite = makeNameSprite(p.name, meta.hex);
  sprite.position.y = 2.15;
  group.add(sprite);

  group.position.set(p.x, 0, p.z);
  scene.add(group);

  others[p.id] = { mesh:group, name:p.name, char:p.character, hp:p.hp, cloaked:false };
}

function makeNameSprite(name, colorHex) {
  const c=document.createElement('canvas'); c.width=256; c.height=48;
  const ctx=c.getContext('2d');
  ctx.fillStyle=colorHex; ctx.font='bold 28px sans-serif'; ctx.textAlign='center';
  ctx.shadowColor='#000'; ctx.shadowBlur=6;
  ctx.fillText(name, 128, 34);
  const tex=new THREE.CanvasTexture(c);
  const mat=new THREE.SpriteMaterial({map:tex,transparent:true,depthTest:false});
  const sp=new THREE.Sprite(mat); sp.scale.set(1.8,0.35,1);
  return sp;
}

function addShieldBubbleTo(mesh) {
  const geo=new THREE.SphereGeometry(0.9,12,12);
  const mat=new THREE.MeshBasicMaterial({color:0x4a90d9,transparent:true,opacity:0.28,side:THREE.BackSide});
  const b=new THREE.Mesh(geo,mat); b.position.y=1; b.name='__shield__';
  mesh.add(b);
}
function removeShieldBubbleFrom(mesh) {
  const b=mesh.getObjectByName('__shield__'); if(b) mesh.remove(b);
}

// ════════════════════════════════════════════════════════════════════════════
//  ITEMS & TRAPS
// ════════════════════════════════════════════════════════════════════════════
function addItemMesh(item) {
  const col  = ITEM_COLORS[item.type] ?? 0xffffff;
  const geo  = new THREE.BoxGeometry(0.35,0.35,0.35);
  const mat  = new THREE.MeshLambertMaterial({ color:col, emissive:col, emissiveIntensity:0.35 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(item.x, 0.4, item.z);
  scene.add(mesh);
  groundItems.push({ id:item.id, type:item.type, x:item.x, z:item.z, mesh });
}

function removeItem(id) {
  const idx=groundItems.findIndex(i=>i.id===id); if(idx===-1) return;
  scene.remove(groundItems[idx].mesh);
  groundItems.splice(idx,1);
}

function addTrapMesh(trap) {
  const isEnv  = trap.placedBy==='env';
  const isMine = trap.placedBy===myId;
  const col    = isMine ? 0xff6600 : isEnv ? 0xcc1111 : 0xaa2200;

  const geo  = new THREE.CylinderGeometry(0.45,0.45,0.07,16);
  const mat  = new THREE.MeshLambertMaterial({ color:col, emissive:0x330000, emissiveIntensity:0.6 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(trap.x, 0.035, trap.z);
  scene.add(mesh);

  // Claymore laser beam for visible env traps
  let laserMesh = null;
  if (trap.visible && trap.laserDir !== undefined) {
    const len = 3.2;
    const dx  = Math.cos(trap.laserDir)*len;
    const dz  = Math.sin(trap.laserDir)*len;
    const pts = [
      new THREE.Vector3(trap.x,         0.16, trap.z),
      new THREE.Vector3(trap.x+dx,      0.16, trap.z+dz),
    ];
    const lGeo = new THREE.BufferGeometry().setFromPoints(pts);
    const lMat = new THREE.LineBasicMaterial({ color:0xff0000, transparent:true, opacity:0.9 });
    laserMesh  = new THREE.Line(lGeo, lMat);
    scene.add(laserMesh);
  }

  groundTraps.push({ ...trap, mesh, laserMesh });
}

function removeTrap(id) {
  const idx=groundTraps.findIndex(t=>t.id===id); if(idx===-1) return;
  const t=groundTraps[idx];
  scene.remove(t.mesh);
  if (t.laserMesh) scene.remove(t.laserMesh);
  groundTraps.splice(idx,1);
}

// ════════════════════════════════════════════════════════════════════════════
//  BULLETS — visible projectiles
// ════════════════════════════════════════════════════════════════════════════
function spawnBullet(from, dir, isMine=true) {
  const geo  = new THREE.SphereGeometry(0.06, 6, 6);
  const mat  = new THREE.MeshBasicMaterial({ color: isMine ? 0xffee44 : 0xff8833 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(from);

  // Small point light on bullet for glow effect
  const pl = new THREE.PointLight(isMine ? 0xffee44 : 0xff8833, 1.2, 3);
  mesh.add(pl);

  scene.add(mesh);
  activeBullets.push({ mesh, dir: dir.clone().normalize(), dist: 0 });
}

function updateBullets(delta) {
  const SPEED = 38;
  const MAX   = 28;
  for (let i=activeBullets.length-1; i>=0; i--) {
    const b=activeBullets[i];
    const step = SPEED*delta;
    b.mesh.position.addScaledVector(b.dir, step);
    b.dist += step;
    if (b.dist > MAX) {
      scene.remove(b.mesh);
      activeBullets.splice(i,1);
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  INTERACTION (E)
// ════════════════════════════════════════════════════════════════════════════
function handleInteract() {
  if (!controls.isLocked) return;
  const px=camera.position.x, pz=camera.position.z;

  // 1. Defuse visible env trap
  for (const trap of groundTraps) {
    if (!trap.visible || trap.placedBy!=='env') continue;
    if (Math.hypot(px-trap.x, pz-trap.z)<1.8) {
      socket.emit('defuse_trap', { trapId:trap.id });
      return;
    }
  }

  // 2. Pick up item
  for (const item of groundItems) {
    if (Math.hypot(px-item.x, pz-item.z)<1.8) {
      socket.emit('pick_item', { itemId:item.id });
      return;
    }
  }

  // 3. Place trap
  if (myHasTrap) {
    socket.emit('place_trap', { x:px, z:pz });
  }
}

function checkPickupPrompt() {
  const px=camera.position.x, pz=camera.position.z;
  let msg = null;

  for (const trap of groundTraps) {
    if (!trap.visible || trap.placedBy!=='env') continue;
    if (Math.hypot(px-trap.x, pz-trap.z)<1.8) { msg='Press E to defuse'; break; }
  }

  if (!msg) {
    for (const item of groundItems) {
      if (Math.hypot(px-item.x, pz-item.z)<1.8) { msg='Press E to pick up'; break; }
    }
  }
  if (!msg && myHasTrap) msg='Press E to place trap';

  const el=document.getElementById('pickup-prompt');
  if (msg) { el.classList.remove('hidden'); el.textContent=msg; }
  else       el.classList.add('hidden');
}

// ════════════════════════════════════════════════════════════════════════════
//  SHOOTING
// ════════════════════════════════════════════════════════════════════════════
function tryShoot() {
  if (myAmmo<=0 || Date.now()<shootCdEnd) return;
  shootCdEnd = Date.now()+400;

  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(0,0), camera);

  const meshList=[], meshToId=new Map();
  for (const [id,o] of Object.entries(others)) {
    o.mesh.traverse(c=>{ if(c.isMesh){ meshList.push(c); meshToId.set(c,id); } });
  }

  const hits   = raycaster.intersectObjects(meshList, false);
  const hitId  = hits.length>0 ? (meshToId.get(hits[0].object)??null) : null;

  const dir  = new THREE.Vector3();
  camera.getWorldDirection(dir);
  const from = camera.position.clone();

  socket.emit('shoot', {
    from:  { x:from.x, y:from.y, z:from.z },
    dir:   { x:dir.x,  y:dir.y,  z:dir.z  },
    hitId,
  });

  // Spawn visible bullet from this client
  spawnBullet(from.clone().addScaledVector(dir, 0.5), dir, true);
  animateGunRecoil();
}

function animateGunRecoil() {
  if (!gunMesh) return;
  gunMesh.position.z = -0.3;
  setTimeout(()=>{ if(gunMesh) gunMesh.position.z=-0.38; }, 85);
}

// ════════════════════════════════════════════════════════════════════════════
//  ABILITY (F)
// ════════════════════════════════════════════════════════════════════════════
function handleAbility() {
  if (!controls.isLocked || abilityActive || Date.now()<abilityCdEnd) return;
  const meta=CHAR_META[myChar]; if(!meta) return;

  abilityActive  = true;
  abilityEndTime = Date.now()+meta.abilityDur;
  abilityCdEnd   = Date.now()+meta.abilityCd;

  socket.emit('ability_start', { ability:meta.ability });

  if (myChar==='tank') {
    if (!shieldBubble) {
      const geo=new THREE.SphereGeometry(0.9,12,12);
      const mat=new THREE.MeshBasicMaterial({color:0x4a90d9,transparent:true,opacity:0.28,side:THREE.BackSide});
      shieldBubble=new THREE.Mesh(geo,mat);
      scene.add(shieldBubble);
    }
  }
  if (myChar==='phantom') {
    phaseActive=true;
    document.getElementById('phase-overlay').classList.remove('hidden');
  }

  setTimeout(()=>{
    abilityActive=false;
    socket.emit('ability_end', { ability:meta.ability });
    if (myChar==='tank' && shieldBubble) { scene.remove(shieldBubble); shieldBubble=null; }
    if (myChar==='phantom') {
      phaseActive=false;
      document.getElementById('phase-overlay').classList.add('hidden');
    }
  }, meta.abilityDur);
}

// ════════════════════════════════════════════════════════════════════════════
//  MOVEMENT & COLLISION
// ════════════════════════════════════════════════════════════════════════════
function updateMovement(delta) {
  if (!controls.isLocked) return;

  const meta  = CHAR_META[myChar]??CHAR_META.scout;
  let   speed = meta.speed;
  if (myChar==='scout' && abilityActive) speed*=2.0;

  const dir=new THREE.Vector3();
  camera.getWorldDirection(dir);
  dir.y=0; dir.normalize();

  const right=new THREE.Vector3();
  right.crossVectors(dir, camera.up).normalize();

  const move=new THREE.Vector3();
  if (keys['KeyW']||keys['ArrowUp'])    move.addScaledVector(dir,   speed*delta);
  if (keys['KeyS']||keys['ArrowDown'])  move.addScaledVector(dir,  -speed*delta);
  if (keys['KeyA']||keys['ArrowLeft'])  move.addScaledVector(right,-speed*delta);
  if (keys['KeyD']||keys['ArrowRight']) move.addScaledVector(right, speed*delta);

  const isMoving = move.lengthSq()>0;

  // Phantom: skip collision when phase is active
  const skipCollision = phaseActive;

  const testX = camera.position.clone(); testX.x+=move.x;
  if (skipCollision || !collidesWithWalls(testX.x, testX.z)) camera.position.x=testX.x;

  const testZ = camera.position.clone(); testZ.z+=move.z;
  if (skipCollision || !collidesWithWalls(testZ.x, testZ.z)) camera.position.z=testZ.z;

  camera.position.y=EYE_H;

  if (isMoving && controls.isLocked) {
    bobT+=delta*speed*2.5;
    camera.position.y=EYE_H+Math.sin(bobT)*BOB_AMP;
  }

  if (shieldBubble) {
    shieldBubble.position.copy(camera.position);
    shieldBubble.position.y=EYE_H-0.7;
  }

  const now=Date.now();
  if (now-lastSent>50) {
    lastSent=now;
    socket.emit('player_update', {
      x:camera.position.x, y:camera.position.y,
      z:camera.position.z, rotY:camera.rotation.y,
    });
  }
}

function collidesWithWalls(x,z) {
  for (const b of wallBoxes) {
    if (x+P_RADIUS>b.minX && x-P_RADIUS<b.maxX &&
        z+P_RADIUS>b.minZ && z-P_RADIUS<b.maxZ) return true;
  }
  return false;
}

function checkTraps() {
  const px=camera.position.x, pz=camera.position.z;
  for (const trap of [...groundTraps]) {
    if (trap.placedBy===myId) continue;
    if (Math.hypot(px-trap.x, pz-trap.z)<0.7) {
      socket.emit('step_trap', { trapId:trap.id });
      removeTrap(trap.id);
    }
  }
}

function checkExit() {
  if (!exitOpen) return;
  if (Math.hypot(camera.position.x-exitPos.x, camera.position.z-exitPos.z)<1.3) {
    exitOpen=false;
    socket.emit('reached_exit');
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  HUD
// ════════════════════════════════════════════════════════════════════════════
function updateHUD() {
  const pct=Math.max(0, myHp/myMaxHp);
  const bar=document.getElementById('hp-bar');
  bar.style.width=`${pct*100}%`;
  bar.classList.toggle('low', pct<0.25);
  bar.classList.toggle('mid', pct>=0.25&&pct<0.5);
  document.getElementById('hp-num').textContent=Math.max(0,myHp);

  // Lives
  const hearts='❤️'.repeat(Math.max(0,myLives))+'🖤'.repeat(Math.max(0, MAX_LIVES-myLives));
  document.getElementById('lives-row').textContent=hearts;

  document.getElementById('ammo-count').textContent=myAmmo;
  document.getElementById('inv-trap').classList.toggle('inv-hidden',!myHasTrap);
  if (gunMesh) gunMesh.visible=myAmmo>0;
}

function startGraceBanner(until) {
  const el=document.getElementById('grace-banner');
  const valEl=document.getElementById('grace-val');
  el.classList.remove('hidden');

  const tick=setInterval(()=>{
    const left=Math.ceil((until-Date.now())/1000);
    valEl.textContent=Math.max(0,left);
    if (left<=0) {
      clearInterval(tick);
      el.classList.add('hidden');
      showMessage('⚔️ Grace period over — fight!');
    }
  }, 500);
}

function startPlayerGrace(until) {
  myGraceEnd=until;
  // visual: flash grace banner briefly
  const el=document.getElementById('grace-banner');
  const valEl=document.getElementById('grace-val');
  el.classList.remove('hidden');
  const tick=setInterval(()=>{
    const left=Math.ceil((until-Date.now())/1000);
    valEl.textContent=Math.max(0,left);
    if (left<=0) { clearInterval(tick); el.classList.add('hidden'); }
  }, 500);
}

function drawAbility(now) {
  const ctx=abilityCtx, S=64;
  ctx.clearRect(0,0,S,S);

  const meta=CHAR_META[myChar]; if(!meta) return;

  ctx.beginPath(); ctx.arc(S/2,S/2,S/2-2,0,Math.PI*2);
  ctx.fillStyle='#11112288'; ctx.fill();

  if (abilityActive) {
    const p=1-(abilityEndTime-now)/meta.abilityDur;
    ctx.beginPath(); ctx.arc(S/2,S/2,S/2-4,-Math.PI/2,-Math.PI/2+Math.PI*2*(1-p));
    ctx.strokeStyle=meta.hex; ctx.lineWidth=5; ctx.stroke();
    ctx.fillStyle=meta.hex+'44';
    ctx.beginPath(); ctx.arc(S/2,S/2,S/2-2,0,Math.PI*2); ctx.fill();
  } else if (now<abilityCdEnd) {
    const f=(abilityCdEnd-now)/meta.abilityCd;
    ctx.beginPath(); ctx.arc(S/2,S/2,S/2-4,-Math.PI/2,-Math.PI/2+Math.PI*2*(1-f));
    ctx.strokeStyle='#444466'; ctx.lineWidth=5; ctx.stroke();
    ctx.beginPath(); ctx.arc(S/2,S/2,S/2-4,-Math.PI/2,-Math.PI/2-Math.PI*2*f,true);
    ctx.lineTo(S/2,S/2); ctx.closePath();
    ctx.fillStyle='#00000077'; ctx.fill();
  } else {
    ctx.beginPath(); ctx.arc(S/2,S/2,S/2-4,0,Math.PI*2);
    ctx.strokeStyle=meta.hex; ctx.lineWidth=4; ctx.stroke();
  }

  const icons={sprint:'⚡',shield:'🛡️',cloak:'👻',phase:'🌀'};
  ctx.font='24px serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.fillText(icons[meta.ability]??'F', S/2, S/2);

  document.getElementById('ability-label').textContent =
    now<abilityCdEnd&&!abilityActive ? `${Math.ceil((abilityCdEnd-now)/1000)}s` : '[F]';
}

function drawMinimap() {
  if (!mazeData) return;
  const { cells, width, height }=mazeData;
  const S=150, cs=S/Math.max(width,height);
  minimapCtx.fillStyle='#00000099'; minimapCtx.fillRect(0,0,S,S);

  minimapCtx.strokeStyle='#5555aa'; minimapCtx.lineWidth=1;
  for (let cy=0; cy<height; cy++) {
    for (let cx=0; cx<width; cx++) {
      const c=cells[cy][cx], px=cx*cs, pz=cy*cs;
      if (c.n) { minimapCtx.beginPath(); minimapCtx.moveTo(px,pz); minimapCtx.lineTo(px+cs,pz); minimapCtx.stroke(); }
      if (c.w) { minimapCtx.beginPath(); minimapCtx.moveTo(px,pz); minimapCtx.lineTo(px,pz+cs); minimapCtx.stroke(); }
      if (cy===height-1&&c.s) { minimapCtx.beginPath(); minimapCtx.moveTo(px,pz+cs); minimapCtx.lineTo(px+cs,pz+cs); minimapCtx.stroke(); }
      if (cx===width-1 &&c.e) { minimapCtx.beginPath(); minimapCtx.moveTo(px+cs,pz); minimapCtx.lineTo(px+cs,pz+cs); minimapCtx.stroke(); }
    }
  }

  // Exit
  const ex=(exitPos.x/CELL)*cs, ez=(exitPos.z/CELL)*cs;
  minimapCtx.fillStyle=exitOpen?'#00ff88':'#334455';
  minimapCtx.fillRect(ex-3,ez-3,6,6);

  // Items
  minimapCtx.fillStyle='#ffcc00';
  for (const i of groundItems) minimapCtx.fillRect((i.x/CELL)*cs-1.5,(i.z/CELL)*cs-1.5,3,3);

  // Own traps
  minimapCtx.fillStyle='#ff6600';
  for (const t of groundTraps) {
    if (t.placedBy!==myId) continue;
    minimapCtx.fillRect((t.x/CELL)*cs-2,(t.z/CELL)*cs-2,4,4);
  }

  // Others
  for (const [,o] of Object.entries(others)) {
    if (o.cloaked) continue;
    minimapCtx.fillStyle=CHAR_META[o.char]?.hex??'#fff';
    minimapCtx.beginPath();
    minimapCtx.arc((o.mesh.position.x/CELL)*cs,(o.mesh.position.z/CELL)*cs,3.5,0,Math.PI*2);
    minimapCtx.fill();
  }

  // Me
  const mx=(camera.position.x/CELL)*cs, mz=(camera.position.z/CELL)*cs;
  minimapCtx.fillStyle='#fff';
  minimapCtx.beginPath(); minimapCtx.arc(mx,mz,4,0,Math.PI*2); minimapCtx.fill();
  const a=camera.rotation.y, al=cs*0.45;
  minimapCtx.strokeStyle='#fff'; minimapCtx.lineWidth=1.5;
  minimapCtx.beginPath(); minimapCtx.moveTo(mx,mz);
  minimapCtx.lineTo(mx-Math.sin(a)*al, mz-Math.cos(a)*al); minimapCtx.stroke();
}

// ─── Visual feedback ──────────────────────────────────────────────────────────
function flashDamage() {
  const el=document.getElementById('damage-flash');
  el.style.background='#ff000055';
  setTimeout(()=>el.style.background='#ff000000', 200);
}
function flashShield() {
  const el=document.getElementById('shield-flash');
  el.style.background='#4a90d944';
  setTimeout(()=>el.style.background='#4a90d900', 300);
}
function showMessage(text, dur=3500) {
  const el=document.getElementById('msg-flash');
  el.textContent=text; el.classList.remove('hidden');
  clearTimeout(el._t); el._t=setTimeout(()=>el.classList.add('hidden'), dur);
}
function addKillfeed(killerName, victimName, isMyDeath, isElim=false) {
  const kf=document.getElementById('killfeed');
  const e=document.createElement('div'); e.className='kf-entry';
  e.innerHTML = isElim
    ? `<span style="color:#ff6b6b">💀 ${victimName} eliminated</span>`
    : isMyDeath
    ? `<span style="color:#ff6b6b">💀 You were killed</span>`
    : `${killerName} <span style="color:#ff6b6b">☠</span> ${victimName}`;
  kf.prepend(e);
  setTimeout(()=>e.remove(), 5000);
}

function showDeathOverlay(livesLeft) {
  if (controls.isLocked) controls.unlock();
  const overlay = document.getElementById('death-overlay');
  const sub     = document.getElementById('death-sub');
  const countEl = document.getElementById('respawn-count');
  const livesMsg= document.getElementById('lives-left-msg');

  document.getElementById('death-title').textContent = '💀 YOU DIED';
  countEl.style.display = '';
  sub.innerHTML = 'Respawning in <span id="respawn-count">3</span>s…';
  livesMsg.textContent  = livesLeft > 0 ? `${livesLeft} life${livesLeft>1?'s':''} remaining` : 'No lives left!';
  overlay.classList.remove('hidden');

  let c=3;
  const t=setInterval(()=>{
    c--;
    const el=document.getElementById('respawn-count');
    if (el) el.textContent=Math.max(0,c);
    if (c<=0) clearInterval(t);
  },1000);
}

// ════════════════════════════════════════════════════════════════════════════
//  GAME OVER
// ════════════════════════════════════════════════════════════════════════════
function endGame({ winnerId, winnerName, reason, players }) {
  if (controls.isLocked) controls.unlock();
  clearInterval(graceInterval);

  document.getElementById('go-winner').textContent =
    winnerId ? `🏆  ${winnerName} wins!` : '🤝  Draw!';

  const reasons = {
    exit:          '🚪 Escaped through the exit',
    last_standing: '⚔️  Last player standing',
    draw:          '💀 Everyone perished',
  };
  document.getElementById('go-reason').textContent = reasons[reason]??reason;

  const tbody=document.getElementById('go-tbody'); tbody.innerHTML='';
  players.forEach(p=>{
    const tr=document.createElement('tr');
    if (p.name===winnerName) tr.classList.add('winner-row');
    const meta=CHAR_META[p.character];
    tr.innerHTML=`
      <td>${p.name}</td>
      <td style="color:${meta?.hex??'#fff'}">${meta?.name??'—'}</td>
      <td>${p.kills}</td>
      <td>${p.deaths??0}</td>
      <td>${'❤️'.repeat(Math.max(0,p.lives??0))+'🖤'.repeat(Math.max(0,3-(p.lives??0)))}</td>`;
    tbody.appendChild(tr);
  });

  showScreen('gameover');
}

// ════════════════════════════════════════════════════════════════════════════
//  SCREEN MANAGEMENT
// ════════════════════════════════════════════════════════════════════════════
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.getElementById(`screen-${name}`)?.classList.add('active');
}
function showError(id, msg) {
  const el=document.getElementById(id); if(!el) return;
  el.textContent=msg; el.classList.remove('hidden');
  setTimeout(()=>el.classList.add('hidden'), 4000);
}

// ════════════════════════════════════════════════════════════════════════════
//  ANIMATE LOOP
// ════════════════════════════════════════════════════════════════════════════
function animate() {
  requestAnimationFrame(animate);
  const delta=Math.min(clock.getDelta(), 0.1);
  const now=Date.now();

  if (document.getElementById('screen-game').classList.contains('active')) {
    updateMovement(delta);
    updateBullets(delta);
    checkTraps();
    checkExit();
    checkPickupPrompt();

    // Animate exit ring
    if (exitMarker) exitMarker.rotation.z+=delta*(exitOpen?1.2:0.25);

    // Animate item cubes (float + spin)
    for (const item of groundItems) {
      item.mesh.rotation.y+=delta*1.5;
      item.mesh.position.y=0.4+Math.sin(now*0.002+item.id)*0.07;
    }

    // Laser beam pulse (claymore traps)
    for (const t of groundTraps) {
      if (t.laserMesh) {
        t.laserMesh.material.opacity=0.6+Math.sin(now*0.006)*0.3;
      }
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
