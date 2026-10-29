// Bot players. They run on the host only and steer by writing into p.input, like a keyboard.
import { W, H, FLOOR, WALL, CRATE, LAVA, FUSE, BLAST_TIME, VENT_WARN, idx, bombAt } from './sim.js';

const DIFF = {
  easy: { think: 0.4, aggro: 0.35, hunt: 0.3, slack: 0.55, mistake: 0.06 },
  normal: { think: 0.22, aggro: 0.6, hunt: 0.7, slack: 0.4, mistake: 0.015 },
  hard: { think: 0.1, aggro: 0.9, hunt: 1.2, slack: 0.3, mistake: 0 },
};
const DIR4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export function createBot(diff) {
  return { cfg: DIFF[diff] || DIFF.normal, t: Math.random() * 0.3, path: [], stuck: 0, lx: 0, ly: 0 };
}

export function botUpdate(s, p, bot, dt) {
  const inp = p.input;
  if (!p.alive || s.phase === 'countdown' || s.phase === 'match') {
    inp.dx = inp.dy = 0;
    return;
  }
  // Clear a path that isn't getting anywhere (blocked by a fresh bomb, warped by a gate...).
  if ((inp.dx || inp.dy) && Math.abs(p.x - bot.lx) + Math.abs(p.y - bot.ly) < 1e-3) bot.stuck += dt;
  else bot.stuck = 0;
  bot.lx = p.x;
  bot.ly = p.y;
  if (bot.stuck > 0.35) { bot.path = []; bot.stuck = 0; bot.t = 0; }

  bot.t -= dt;
  if (bot.t <= 0) {
    bot.t = bot.cfg.think * (0.7 + Math.random() * 0.6);
    think(s, p, bot);
  }
  follow(p, bot);
}

function follow(p, bot) {
  const inp = p.input;
  inp.dx = inp.dy = 0;
  while (bot.path.length) {
    const i = bot.path[0], tx = i % W, ty = (i / W) | 0;
    const ex = tx - p.x, ey = ty - p.y;
    if (Math.abs(ex) < 0.06 && Math.abs(ey) < 0.06) { bot.path.shift(); continue; }
    if (Math.abs(ex) > 1.5 || Math.abs(ey) > 1.5) { bot.path = []; return; }   // we got warped
    if (Math.abs(ex) > Math.abs(ey)) inp.dx = Math.sign(ex);
    else inp.dy = Math.sign(ey);
    return;
  }
}

function think(s, p, bot) {
  const cfg = bot.cfg;
  const x = Math.round(p.x), y = Math.round(p.y), here = idx(x, y);
  const danger = dangerMap(s);
  const g = search(s, p, danger, here);

  // 1. Standing where a blast will land: run to the closest tile that stays safe.
  if (danger[here] !== Infinity) {
    const safe = g.order.find((i) => danger[i] === Infinity);
    bot.path = safe !== undefined ? pathTo(g, safe) : [];
    return;
  }

  // 2. Drop a bomb when it would hit something and there is still a way out.
  let mine = 0;
  for (const b of s.bombs) if (b.owner === p.id) mine++;
  if (s.phase === 'play' && mine < p.maxBombs && !bombAt(s, x, y)) {
    const v = bombValue(s, p, x, y);
    if ((v.crates || v.enemies) && Math.random() < cfg.aggro) {
      const d2 = dangerMap(s, { x, y, t: FUSE, range: p.fire });
      const g2 = search(s, p, d2, here);
      const way = g2.order.find((i) => d2[i] === Infinity && g2.dist[i] / p.speed < FUSE - cfg.slack);
      if (way !== undefined || Math.random() < cfg.mistake) {
        p.input.bomb++;
        bot.path = way !== undefined ? pathTo(g2, way) : [];
        return;
      }
    }
  }

  // 3. Head for the best reachable spot: power-ups, crates to break, or opponents to corner.
  const enemies = s.players.filter((q) => q.alive && q.id !== p.id);
  let best = -1, bestScore = 0;
  for (const i of g.order) {
    if (danger[i] !== Infinity) continue;
    const cx = i % W, cy = (i / W) | 0;
    let score = 0;
    if (s.items[i]) score += 8;
    const v = bombValue(s, p, cx, cy);
    score += v.crates + v.enemies * 3 * cfg.hunt;
    let near = 99;
    for (const q of enemies) near = Math.min(near, Math.abs(Math.round(q.x) - cx) + Math.abs(Math.round(q.y) - cy));
    score += cfg.hunt / (1 + near);
    score /= 1 + g.dist[i] * 0.45;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  bot.path = best >= 0 ? pathTo(g, best) : [];
}

// Tiles a blast from (x, y) would cover, ignoring chain reactions.
function blastCells(s, x, y, range) {
  const out = [idx(x, y)];
  for (const [dx, dy] of DIR4) {
    for (let r = 1; r <= range; r++) {
      const cx = x + dx * r, cy = y + dy * r, i = idx(cx, cy);
      const g = s.grid[i];
      if (g === WALL) break;
      out.push(i);
      if (g === LAVA) continue;
      if (g === CRATE || s.items[i] || bombAt(s, cx, cy)) break;
    }
  }
  return out;
}

// Seconds until each tile is hit by flames (0 = burning now, Infinity = safe).
function dangerMap(s, extra) {
  const d = new Float32Array(W * H).fill(Infinity);
  for (const e of s.expl) for (const [x, y] of e.cells) d[idx(x, y)] = 0;
  const bombs = s.bombs.map((b) => ({ x: Math.round(b.x), y: Math.round(b.y), t: Math.max(0, b.fuse), range: b.range }));
  if (extra) bombs.push(extra);
  for (const v of s.vents) {
    if (v.t < VENT_WARN + 0.6 && s.grid[v.i] === FLOOR) bombs.push({ x: v.i % W, y: (v.i / W) | 0, t: v.t, range: 1, vent: true });
  }
  const cells = bombs.map((b) => blastCells(s, b.x, b.y, b.range));
  // A bomb caught in another bomb's blast goes off with it.
  for (let pass = 0; pass < 3; pass++) {
    for (let a = 0; a < bombs.length; a++) {
      for (let b = 0; b < bombs.length; b++) {
        if (!bombs[b].vent && bombs[b].t > bombs[a].t && cells[a].includes(idx(bombs[b].x, bombs[b].y))) bombs[b].t = bombs[a].t;
      }
    }
  }
  bombs.forEach((b, k) => { for (const i of cells[k]) if (d[i] > b.t) d[i] = b.t; });
  return d;
}

// Breadth-first search over tiles we can reach without being caught in flames on the way.
function search(s, p, danger, start) {
  const dist = new Int16Array(W * H).fill(-1);
  const prev = new Int16Array(W * H).fill(-1);
  const order = [start];
  dist[start] = 0;
  const stepT = 1 / p.speed;
  for (let h = 0; h < order.length; h++) {
    const i = order[h], x = i % W, y = (i / W) | 0;
    for (const [dx, dy] of DIR4) {
      const nx = x + dx, ny = y + dy, j = idx(nx, ny);
      if (dist[j] !== -1 || s.grid[j] !== FLOOR) continue;
      const b = bombAt(s, nx, ny);
      if (b && !b.pass.includes(p.id)) continue;
      const dj = danger[j];
      if (dj === 0) continue;
      const arrive = (dist[i] + 1) * stepT, leave = arrive + stepT;
      if (dj !== Infinity && dj < leave + 0.15 && dj + BLAST_TIME > arrive - 0.1) continue;
      dist[j] = dist[i] + 1;
      prev[j] = i;
      order.push(j);
    }
  }
  return { dist, prev, order };
}

function pathTo(g, target) {
  const path = [];
  for (let i = target; g.prev[i] !== -1; i = g.prev[i]) path.push(i);
  return path.reverse();
}

function bombValue(s, p, x, y) {
  let crates = 0, enemies = 0;
  for (const i of blastCells(s, x, y, p.fire)) {
    if (s.grid[i] === CRATE) crates++;
    for (const q of s.players) {
      if (q.alive && q.id !== p.id && idx(Math.round(q.x), Math.round(q.y)) === i) enemies++;
    }
  }
  return { crates, enemies };
}
