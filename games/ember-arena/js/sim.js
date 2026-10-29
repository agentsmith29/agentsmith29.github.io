// Ember Arena: the authoritative game simulation.
// It never touches the DOM, so the host browser, the bots and the Node tests all share it.

export const W = 15, H = 13;
export const TICK = 1 / 60;
export const FLOOR = 0, WALL = 1, CRATE = 2, LAVA = 3;
export const PU_BOMB = 1, PU_FIRE = 2, PU_SPEED = 3, PU_KICK = 4;
export const DIRS = ['down', 'up', 'left', 'right'];
export const SPAWNS = [[1, 1], [13, 11], [13, 1], [1, 11]];

export const FUSE = 2.4;            // seconds until a bomb goes off
export const BLAST_TIME = 0.6;      // how long flames stay on a tile
export const BASE_SPEED = 3.6;      // tiles per second
export const SPEED_STEP = 0.5;
export const MAX_SPEED = 6.6;
export const MAX_BOMBS = 8;
export const MAX_FIRE = 8;
export const KICK_SPEED = 9;
export const COUNTDOWN = 3;
export const ROUND_END = 3.5;
const END_GRACE = 0.5;              // lets near-simultaneous deaths count as a draw
const DROP_EVERY = 0.2;             // sudden death: one wall every this many seconds
const ASSIST = 0.3;                 // corner assist kicks in beyond this lane offset
const CRATE_DENSITY = 0.72;
const POWERUP_CHANCE = 0.35;
const ITEM_CH = ['.', 'B', 'F', 'S', 'K'];
export const VENT_PERIOD = 7;       // seconds between eruptions
export const VENT_WARN = 1.5;       // vents glow this long before erupting
const WARP_SNAP = 0.12;             // how close to a gate's centre you must be to warp

// Stage maps. '#' wall, '.' floor that may get a crate, ',' floor that never does,
// '~' lava (flames cross it, nothing else does), 'v' vent, 'A'/'a' and 'B'/'b' paired gates.
// A null map means the classic generated grid of pillars.
export const STAGES = [
  { name: 'Ash Plaza', blurb: 'Classic pillars and crates', map: null },
  {
    name: 'Lava Rift', blurb: 'A lava river with three bridges; flames jump it, you cannot',
    map: [
      '###############',
      '#,,.........,,#',
      '#,#.#.#.#.#.#,#',
      '#.............#',
      '#.#.#.#.#.#.#.#',
      '#.............#',
      '#~~.~~~.~~~.~~#',
      '#.............#',
      '#.#.#.#.#.#.#.#',
      '#.............#',
      '#,#.#.#.#.#.#,#',
      '#,,.........,,#',
      '###############',
    ],
  },
  {
    name: 'Geyser Gardens', blurb: 'Vents erupt every few seconds; watch for the glow',
    map: [
      '###############',
      '#,,.........,,#',
      '#,##.#...#.##,#',
      '#...#.....#...#',
      '#.#...v.v...#.#',
      '#...#.....#...#',
      '#.v...#v#...v.#',
      '#...#.....#...#',
      '#.#...v.v...#.#',
      '#...#.....#...#',
      '#,##.#...#.##,#',
      '#,,.........,,#',
      '###############',
    ],
  },
  {
    name: 'Rune Gates', blurb: 'Step onto a gate to warp across the arena',
    map: [
      '###############',
      '#,,.........,,#',
      '#,#.#.#.#.#.#,#',
      '#...A.....B...#',
      '#.#.#.###.#.#.#',
      '#.............#',
      '###.#.#,#.#.###',
      '#.............#',
      '#.#.#.###.#.#.#',
      '#...b.....a...#',
      '#,#.#.#.#.#.#,#',
      '#,,.........,,#',
      '###############',
    ],
  },
];

export const idx = (x, y) => y * W + x;

// Vents and gates never change during a round, so both host and guests derive them from the stage.
export function stageFeatures(stage) {
  const map = STAGES[stage]?.map;
  const vents = [], gates = {}, warps = new Map();
  if (map) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const ch = map[y][x];
        if (ch === 'v') vents.push(idx(x, y));
        else if (/[ab]/i.test(ch)) (gates[ch.toLowerCase()] ||= []).push(idx(x, y));
      }
    }
  }
  for (const [a, b] of Object.values(gates)) { warps.set(a, b); warps.set(b, a); }
  return { vents, warps };
}

function chooseStage(s) {
  const pick = s.settings.stage;
  if (pick === 'random') return Math.floor(s.rng() * STAGES.length);
  if (pick === 'rotate') return (s.stageStart + s.round - 1) % STAGES.length;
  return Math.max(0, Math.min(STAGES.length - 1, pick | 0));
}

export function rngFrom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function bombAt(s, x, y) {
  for (const b of s.bombs) if (Math.round(b.x) === x && Math.round(b.y) === y) return b;
  return null;
}

export function canEnter(s, p, x, y) {
  if (x < 0 || y < 0 || x >= W || y >= H || s.grid[idx(x, y)] !== FLOOR) return false;
  const b = bombAt(s, x, y);
  return !b || b.pass.includes(p.id);
}

// ---------------------------------------------------------------- match setup

export function createMatch(roster, settings, seed = Date.now()) {
  const s = {
    tick: 0, time: 0, rng: rngFrom(seed),
    settings: { wins: 3, time: 120, stage: 'rotate', ...settings },
    players: roster.map((r) => ({ id: r.slot, slot: r.slot, name: r.name, wins: 0, left: false, input: { dx: 0, dy: 0, bomb: 0 } })),
    round: 0, phase: 'countdown', phaseT: COUNTDOWN, timeLeft: 0, grace: END_GRACE,
    lastWinner: null, champion: null,
    grid: new Uint8Array(W * H), items: new Uint8Array(W * H), hidden: new Uint8Array(W * H),
    fire: new Uint8Array(W * H), shield: new Float64Array(W * H),
    bombs: [], expl: [], events: [], gridVer: 0, nextId: 1, sudden: null,
    stage: 0, stageStart: 0, vents: [], warps: new Map(),
  };
  s.stageStart = Math.floor(s.rng() * STAGES.length);
  startRound(s);
  return s;
}

export function startRound(s) {
  s.round++;
  s.stage = chooseStage(s);
  const feat = stageFeatures(s.stage);
  s.warps = feat.warps;
  s.vents = feat.vents.map((i, k) => ({ i, t: VENT_PERIOD * (0.55 + 0.45 * ((k * 0.618) % 1)) }));
  buildMap(s);
  s.bombs = [];
  s.expl = [];
  s.fire.fill(0);
  s.phase = 'countdown';
  s.phaseT = COUNTDOWN;
  s.timeLeft = s.settings.time;
  s.grace = END_GRACE;
  s.sudden = null;
  s.lastWinner = null;
  for (const p of s.players) {
    const [x, y] = SPAWNS[p.slot];
    Object.assign(p, {
      x, y, px: x, py: y, dir: 'down', moving: false, alive: !p.left,
      maxBombs: 1, fire: 2, speed: BASE_SPEED, kick: false, bombSeen: p.input.bomb, warpLock: -1,
    });
  }
  s.events.push({ t: 'round', r: s.round });
}

function buildMap(s) {
  const { grid, items, hidden, rng } = s;
  items.fill(0);
  hidden.fill(0);
  // Each corner keeps an L of three free tiles: drop a bomb at one end, hide at the other.
  const safe = new Set();
  for (const [sx, sy] of SPAWNS) {
    const ix = sx === 1 ? 1 : -1, iy = sy === 1 ? 1 : -1;
    safe.add(idx(sx, sy)).add(idx(sx + ix, sy)).add(idx(sx, sy + iy));
  }
  const map = STAGES[s.stage].map;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = idx(x, y);
      const ch = map ? map[y][x] : x === 0 || y === 0 || x === W - 1 || y === H - 1 || (x % 2 === 0 && y % 2 === 0) ? '#' : '.';
      if (ch === '#') grid[i] = WALL;
      else if (ch === '~') grid[i] = LAVA;
      else if (ch === '.' && !safe.has(i) && rng() < CRATE_DENSITY) {
        grid[i] = CRATE;
        if (rng() < POWERUP_CHANCE) hidden[i] = pickPowerup(rng);
      } else grid[i] = FLOOR;
    }
  }
  s.gridVer++;
}

function pickPowerup(rng) {
  const r = rng();
  return r < 0.36 ? PU_BOMB : r < 0.72 ? PU_FIRE : r < 0.9 ? PU_SPEED : PU_KICK;
}

export function removePlayer(s, id) {
  const p = s.players.find((q) => q.id === id);
  if (!p) return;
  p.left = true;
  if (p.alive) kill(s, p);
}

// ---------------------------------------------------------------- per tick

export function tick(s, dt = TICK) {
  s.tick++;
  s.time += dt;
  for (const p of s.players) { p.px = p.x; p.py = p.y; }
  if (s.phase === 'match') return;
  if (s.phase === 'countdown') {
    for (const p of s.players) p.bombSeen = p.input.bomb;
    s.phaseT -= dt;
    if (s.phaseT <= 0) { s.phase = 'play'; s.events.push({ t: 'go' }); }
    return;
  }
  if (s.phase === 'play') {
    s.timeLeft = Math.max(0, s.timeLeft - dt);
    if (s.timeLeft === 0) suddenDeath(s, dt);
  }
  updateFlames(s, dt);
  for (const p of s.players) if (p.alive) updatePlayer(s, p, dt);
  updateBombs(s, dt);
  updateVents(s, dt);
  for (const p of s.players) if (p.alive && s.fire[idx(Math.round(p.x), Math.round(p.y))]) kill(s, p);

  if (s.phase === 'play') {
    const alive = s.players.filter((p) => p.alive);
    if (alive.length <= 1) {
      s.grace -= dt;
      if (s.grace <= 0) endRound(s, alive[0] || null);
    }
  } else if (s.phase === 'over') {
    s.phaseT -= dt;
    if (s.phaseT <= 0) {
      if (s.champion !== null) { s.phase = 'match'; s.events.push({ t: 'match', w: s.champion }); }
      else startRound(s);
    }
  }
}

function endRound(s, winner) {
  s.phase = 'over';
  s.phaseT = ROUND_END;
  s.lastWinner = winner ? winner.id : -1;
  if (winner && ++winner.wins >= s.settings.wins) s.champion = winner.id;
  s.events.push({ t: 'end', w: s.lastWinner });
}

function kill(s, p) {
  p.alive = false;
  p.moving = false;
  s.events.push({ t: 'die', p: p.id, x: p.x, y: p.y });
}

function updatePlayer(s, p, dt) {
  let { dx, dy } = p.input;
  if (dx && dy) dy = 0;
  p.moving = !!(dx || dy);
  if (p.moving) {
    p.dir = dx < 0 ? 'left' : dx > 0 ? 'right' : dy < 0 ? 'up' : 'down';
    movePlayer(s, p, dx, dy, dt, true);
  }
  updatePass(s, p);
  warp(s, p);
  if (p.input.bomb !== p.bombSeen) {
    p.bombSeen = p.input.bomb;
    if (s.phase === 'play') placeBomb(s, p);
  }
  pickUp(s, p);
}

// Movement is grid-aligned with corner assist: you can only travel along a lane,
// and if you push into a wall while slightly off-lane next to an opening, you slide into it.
export function movePlayer(s, p, dx, dy, dt, authoritative) {
  let d = p.speed * dt;
  while (d > 1e-6) {
    const step = Math.min(d, 0.1);
    d -= step;
    moveStep(s, p, dx, dy, step, authoritative);
  }
}

function moveStep(s, p, dx, dy, d, authoritative) {
  const cx = Math.round(p.x), cy = Math.round(p.y);
  const along = dx ? 'x' : 'y', side = dx ? 'y' : 'x';
  const dir = dx || dy;
  const centre = dx ? cx : cy;
  const off = p[side] - (dx ? cy : cx);     // offset from the lane centre
  const nx = cx + dx, ny = cy + dy;

  if (canEnter(s, p, nx, ny)) {
    const a = Math.min(Math.abs(off), d);   // line up with the lane first, then advance
    p[side] -= Math.sign(off) * a;
    p[along] += dir * (d - a);
    return;
  }
  const past = (p[along] - centre) * dir;   // > 0 once past the middle of the tile
  if (past < 0) {
    const a = Math.min(-past, d);
    p[along] += dir * a;
    d -= a;
  }
  if (authoritative && p.kick && Math.abs(off) < 0.25 && past >= -0.05) tryKick(s, p, nx, ny, dx, dy);
  if (d > 0 && Math.abs(off) > ASSIST) {
    const sgn = Math.sign(off);
    const ahead = dx ? canEnter(s, p, nx, cy + sgn) : canEnter(s, p, cx + sgn, ny);
    const beside = dx ? canEnter(s, p, cx, cy + sgn) : canEnter(s, p, cx + sgn, cy);
    if (ahead && beside) p[side] += sgn * Math.min(d, 1 - Math.abs(off));
  }
}

function tryKick(s, p, x, y, dx, dy) {
  const b = bombAt(s, x, y);
  if (!b || b.vx || b.vy || !bombCanEnter(s, b, x + dx, y + dy)) return;
  b.vx = dx * KICK_SPEED;
  b.vy = dy * KICK_SPEED;
  b.pass = [];
  s.events.push({ t: 'kick', x, y });
}

// You may stand on a bomb you (or someone) just dropped, but once you step off it is solid.
export function updatePass(s, p) {
  const cx = Math.round(p.x), cy = Math.round(p.y);
  for (const b of s.bombs) {
    if (b.pass.length && (Math.round(b.x) !== cx || Math.round(b.y) !== cy)) {
      const k = b.pass.indexOf(p.id);
      if (k >= 0) b.pass.splice(k, 1);
    }
  }
}

// Standing on the centre of a gate moves you to its partner. You have to step off
// the partner before it will send you back, so you don't bounce between them.
function warp(s, p) {
  const cx = Math.round(p.x), cy = Math.round(p.y), i = idx(cx, cy);
  if (p.warpLock !== -1 && p.warpLock !== i) p.warpLock = -1;
  const to = s.warps.get(i);
  if (to === undefined || p.warpLock === i) return;
  if (Math.abs(p.x - cx) > WARP_SNAP || Math.abs(p.y - cy) > WARP_SNAP) return;
  const tx = to % W, ty = (to / W) | 0;
  if (s.grid[to] !== FLOOR || bombAt(s, tx, ty)) return;
  s.events.push({ t: 'warp', p: p.id, x: cx, y: cy, x2: tx, y2: ty });
  p.x = p.px = tx;
  p.y = p.py = ty;
  p.warpLock = to;
}

function updateVents(s, dt) {
  if (s.phase !== 'play' && s.phase !== 'over') return;
  const queue = [];
  for (const v of s.vents) {
    v.t -= dt;
    if (v.t > 0) continue;
    v.t += VENT_PERIOD;
    if (s.grid[v.i] !== FLOOR) continue;
    blast(s, v.i % W, (v.i / W) | 0, 1, queue);
  }
  while (queue.length) {
    const b = queue.shift();
    if (s.bombs.includes(b)) explode(s, b, queue);
  }
}

function placeBomb(s, p) {
  const x = Math.round(p.x), y = Math.round(p.y), i = idx(x, y);
  if (s.grid[i] !== FLOOR || bombAt(s, x, y) || s.fire[i]) return;
  let mine = 0;
  for (const b of s.bombs) if (b.owner === p.id) mine++;
  if (mine >= p.maxBombs) return;
  const pass = s.players.filter((q) => q.alive && Math.round(q.x) === x && Math.round(q.y) === y).map((q) => q.id);
  s.bombs.push({ id: s.nextId++, owner: p.id, x, y, fuse: FUSE, range: p.fire, vx: 0, vy: 0, pass });
  s.events.push({ t: 'bomb', x, y });
}

function pickUp(s, p) {
  const x = Math.round(p.x), y = Math.round(p.y), i = idx(x, y);
  const k = s.items[i];
  if (!k) return;
  s.items[i] = 0;
  s.gridVer++;
  if (k === PU_BOMB) p.maxBombs = Math.min(MAX_BOMBS, p.maxBombs + 1);
  else if (k === PU_FIRE) p.fire = Math.min(MAX_FIRE, p.fire + 1);
  else if (k === PU_SPEED) p.speed = Math.min(MAX_SPEED, p.speed + SPEED_STEP);
  else if (k === PU_KICK) p.kick = true;
  s.events.push({ t: 'pick', p: p.id, k, x, y });
}

function bombCanEnter(s, b, x, y) {
  if (x < 0 || y < 0 || x >= W || y >= H) return false;
  const i = idx(x, y);
  if (s.grid[i] !== FLOOR || s.items[i]) return false;
  const other = bombAt(s, x, y);
  if (other && other !== b) return false;
  return !s.players.some((q) => q.alive && Math.round(q.x) === x && Math.round(q.y) === y);
}

function slideBomb(s, b, dt) {
  const dx = Math.sign(b.vx), dy = Math.sign(b.vy);
  let d = KICK_SPEED * dt;
  while (d > 0) {
    const cx = Math.round(b.x), cy = Math.round(b.y);
    const past = (b.x - cx) * dx + (b.y - cy) * dy;
    if (past >= -1e-6 && !bombCanEnter(s, b, cx + dx, cy + dy)) {
      b.x = cx; b.y = cy; b.vx = 0; b.vy = 0;
      return;
    }
    const step = Math.min(d, 0.1);
    b.x += dx * step;
    b.y += dy * step;
    d -= step;
  }
}

function updateBombs(s, dt) {
  for (const b of s.bombs) {
    if (b.vx || b.vy) slideBomb(s, b, dt);
    b.fuse -= dt;
  }
  const queue = s.bombs.filter((b) => b.fuse <= 0 || s.fire[idx(Math.round(b.x), Math.round(b.y))]);
  while (queue.length) {
    const b = queue.shift();
    if (s.bombs.includes(b)) explode(s, b, queue);
  }
}

// Cell kinds in an explosion: 0 centre, 1 horizontal arm, 2 vertical arm, 3-6 ends (left, right, up, down).
const ARMS = [[-1, 0, 1, 3], [1, 0, 1, 4], [0, -1, 2, 5], [0, 1, 2, 6]];

function explode(s, b, queue) {
  s.bombs.splice(s.bombs.indexOf(b), 1);
  blast(s, Math.round(b.x), Math.round(b.y), b.range, queue);
}

function blast(s, x, y, range, queue) {
  const cells = [[x, y, 0]];
  for (const [dx, dy, mid, end] of ARMS) {
    for (let r = 1; r <= range; r++) {
      const cx = x + dx * r, cy = y + dy * r, i = idx(cx, cy);
      if (s.grid[i] === WALL) break;
      if (s.grid[i] === LAVA) {
        cells.push([cx, cy, r === range ? end : mid]);
        continue;
      }
      if (s.grid[i] === CRATE) {
        s.grid[i] = FLOOR;
        if (s.hidden[i]) {
          s.items[i] = s.hidden[i];
          s.hidden[i] = 0;
          s.shield[i] = s.time + BLAST_TIME + 0.05;   // the flames that revealed it don't burn it
        }
        cells.push([cx, cy, end]);
        s.events.push({ t: 'crate', x: cx, y: cy });
        break;
      }
      const other = bombAt(s, cx, cy);
      if (other) {
        cells.push([cx, cy, end]);
        if (!queue.includes(other)) queue.push(other);
        break;
      }
      if (s.items[i]) {
        if (s.shield[i] < s.time) s.items[i] = 0;
        cells.push([cx, cy, end]);
        break;
      }
      cells.push([cx, cy, r === range ? end : mid]);
    }
  }
  s.expl.push({ id: s.nextId++, t: BLAST_TIME, cells });
  for (const [cx, cy] of cells) s.fire[idx(cx, cy)]++;
  s.gridVer++;
  s.events.push({ t: 'boom', x, y, n: cells.length });
}

function updateFlames(s, dt) {
  let done = false;
  for (const e of s.expl) {
    e.t -= dt;
    if (e.t <= 0) done = true;
  }
  if (!done) return;
  for (const e of s.expl) if (e.t <= 0) for (const [x, y] of e.cells) s.fire[idx(x, y)]--;
  s.expl = s.expl.filter((e) => e.t > 0);
}

// When the clock runs out, walls drop in a spiral from the outside in.
function suddenDeath(s, dt) {
  if (!s.sudden) {
    s.sudden = { order: spiralOrder(), i: 0, t: 0 };
    s.events.push({ t: 'sudden' });
  }
  const sd = s.sudden;
  sd.t -= dt;
  while (sd.t <= 0) {
    let i;
    do i = sd.order[sd.i++]; while (i !== undefined && (s.grid[i] === WALL || s.grid[i] === LAVA));
    if (i === undefined) { sd.t = Infinity; break; }
    sd.t += DROP_EVERY;
    const x = i % W, y = (i / W) | 0;
    s.grid[i] = WALL;
    s.items[i] = 0;
    s.hidden[i] = 0;
    s.gridVer++;
    s.bombs = s.bombs.filter((b) => Math.round(b.x) !== x || Math.round(b.y) !== y);
    for (const p of s.players) if (p.alive && Math.round(p.x) === x && Math.round(p.y) === y) kill(s, p);
    s.events.push({ t: 'drop', x, y });
  }
}

function spiralOrder() {
  const out = [];
  let x0 = 1, y0 = 1, x1 = W - 2, y1 = H - 2;
  while (x0 <= x1 && y0 <= y1) {
    for (let x = x0; x <= x1; x++) out.push(idx(x, y0));
    for (let y = y0 + 1; y <= y1; y++) out.push(idx(x1, y));
    if (y1 > y0) for (let x = x1 - 1; x >= x0; x--) out.push(idx(x, y1));
    if (x1 > x0) for (let y = y1 - 1; y > y0; y--) out.push(idx(x0, y));
    x0++; y0++; x1--; y1--;
  }
  return out;
}

// ---------------------------------------------------------------- network snapshots

const r3 = (v) => Math.round(v * 1000) / 1000;

export function encodeGrid(s) {
  let out = '';
  for (let i = 0; i < W * H; i++) {
    const g = s.grid[i];
    out += g === WALL ? '#' : g === CRATE ? 'x' : g === LAVA ? '~' : ITEM_CH[s.items[i]];
  }
  return out;
}

export function snapshot(s, withGrid, acks) {
  return {
    t: 's', k: s.tick, ph: s.phase, pt: r3(s.phaseT), tl: r3(s.timeLeft), rd: s.round, st: s.stage,
    v: s.vents.map((v) => r3(v.t)),
    lw: s.lastWinner, ch: s.champion, sd: s.sudden ? 1 : 0,
    g: withGrid ? encodeGrid(s) : undefined,
    p: s.players.map((p) => [p.id, r3(p.x), r3(p.y), DIRS.indexOf(p.dir), +p.alive, +p.moving, p.maxBombs, p.fire, r3(p.speed), +p.kick, p.wins]),
    b: s.bombs.map((b) => [b.id, r3(b.x), r3(b.y), r3(b.fuse), b.owner, b.pass]),
    e: s.expl.map((e) => [e.id, r3(e.t), e.cells]),
    a: acks,
  };
}

// A guest's copy of the world, shaped like the host state so the renderer can draw either.
export function emptyView() {
  return {
    grid: new Uint8Array(W * H), items: new Uint8Array(W * H), players: [], bombs: [], expl: [],
    tick: 0, phase: 'countdown', phaseT: 0, timeLeft: 0, round: 0, lastWinner: null, champion: null, sudden: false,
    stage: -1, vents: [], warps: new Map(),
  };
}

export function applySnapshot(v, m) {
  if (m.g) {
    for (let i = 0; i < W * H; i++) {
      const ch = m.g[i];
      v.grid[i] = ch === '#' ? WALL : ch === 'x' ? CRATE : ch === '~' ? LAVA : FLOOR;
      v.items[i] = Math.max(0, ITEM_CH.indexOf(ch));
    }
  }
  if (m.st !== v.stage) {
    const feat = stageFeatures(m.st);
    v.stage = m.st;
    v.warps = feat.warps;
    v.vents = feat.vents.map((i) => ({ i, t: VENT_PERIOD }));
  }
  m.v.forEach((t, k) => { if (v.vents[k]) v.vents[k].t = t; });
  v.tick = m.k;
  v.phase = m.ph;
  v.phaseT = m.pt;
  v.timeLeft = m.tl;
  v.round = m.rd;
  v.lastWinner = m.lw;
  v.champion = m.ch;
  v.sudden = !!m.sd;
  v.players = m.p.map((a) => ({
    id: a[0], x: a[1], y: a[2], dir: DIRS[a[3]], alive: !!a[4], moving: !!a[5],
    maxBombs: a[6], fire: a[7], speed: a[8], kick: !!a[9], wins: a[10],
  }));
  v.bombs = m.b.map((a) => ({ id: a[0], x: a[1], y: a[2], fuse: a[3], owner: a[4], pass: a[5] }));
  v.expl = m.e.map((a) => ({ id: a[0], t: a[1], cells: a[2] }));
}
