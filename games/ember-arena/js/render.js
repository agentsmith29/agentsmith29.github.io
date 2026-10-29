// Draws the arena: pixel art into a native-resolution buffer, scaled up crisply,
// then glow lighting, labels and a vignette on top at screen resolution.
import { W, H, WALL, CRATE, LAVA, FUSE, BLAST_TIME, VENT_WARN, STAGES, idx } from './sim.js';
import { TILE, PALETTES, buildSprites, floorLayer, makeCanvas, disc, hash } from './sprites.js';

const NW = W * TILE, NH = H * TILE;
const DIR4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const FIRE = [[14, '#b8231a'], [10, '#ff6a1a'], [6, '#ffc43d'], [2, '#fff4d0']];
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

function glowSprite(rgb) {
  const c = makeCanvas(64, 64), g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, `rgba(${rgb},1)`);
  grad.addColorStop(0.35, `rgba(${rgb},0.45)`);
  grad.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return c;
}

const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(',');

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.buf = makeCanvas(NW, NH);
    this.b = this.buf.getContext('2d');
    this.sp = buildSprites();
    this.floor = floorLayer();
    this.light = {
      fire: glowSprite('255,140,40'), warm: glowSprite('255,220,170'), red: glowSprite('255,60,40'),
      a: glowSprite('76,184,255'), b: glowSprite('212,107,255'),
      players: PALETTES.map((p) => glowSprite(hexRgb(p.glow))),
    };
    this.particles = [];
    this.ghosts = [];
    this.drops = new Map();
    this.shake = 0;
    this.time = 0;
    this.insetTop = 0;
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  setInset(top) {
    if (top === this.insetTop) return;
    this.insetTop = top;
    this.resize();
  }

  resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const cw = Math.round(innerWidth * dpr), ch = Math.round(innerHeight * dpr);
    this.canvas.width = cw;
    this.canvas.height = ch;
    const top = this.insetTop * dpr, pad = 16 * dpr;
    let s = Math.min((cw - pad * 2) / NW, (ch - top - pad * 2) / NH);
    if (s >= 2) s = Math.floor(s);
    this.scale = Math.max(0.5, s);
    this.dpr = dpr;
    this.ox = Math.round((cw - NW * this.scale) / 2);
    this.oy = Math.round(top + (ch - top - NH * this.scale) / 2);
    this.vignette = null;
  }

  reset() {
    this.particles.length = 0;
    this.ghosts.length = 0;
    this.drops.clear();
    this.shake = 0;
  }

  // ---------------------------------------------------------------- effects from game events

  event(ev) {
    const cx = (ev.x ?? 0) * TILE + 8, cy = (ev.y ?? 0) * TILE + 8;
    switch (ev.t) {
      case 'boom':
        this.bump(1.6 + Math.min(2, ev.n / 8));
        this.burst(cx, cy, 14, ['#fff4d0', '#ffc43d', '#ff6a1a'], 70, 0.45, 0);
        break;
      case 'crate':
        this.burst(cx, cy, 10, ['#c98a4c', '#a86c35', '#6b4120'], 55, 0.7, 220);
        this.smoke(cx, cy, 3);
        break;
      case 'die': {
        const p = PALETTES[ev.p];
        this.ghosts.push({ x: ev.x, y: ev.y, slot: ev.p, t: 0 });
        this.burst(cx, cy, 18, [p.c, p.l, p.m], 50, 0.8, -30);
        this.smoke(cx, cy, 5);
        break;
      }
      case 'pick':
        this.burst(cx, cy, 10, ['#ffffff', '#ffe08a'], 40, 0.5, -30);
        break;
      case 'warp': {
        const col = PALETTES[ev.p];
        this.burst(cx, cy, 10, [col.l, '#ffffff'], 45, 0.4, 0);
        this.burst(ev.x2 * TILE + 8, ev.y2 * TILE + 8, 10, [col.l, '#ffffff'], 45, 0.4, 0);
        break;
      }
      case 'drop':
        this.drops.set(idx(ev.x, ev.y), { t0: this.time, landed: false });
        break;
      case 'kick':
        this.bump(0.5);
        break;
      case 'round':
        this.reset();
        break;
    }
  }

  bump(n) {
    if (!reduceMotion) this.shake = Math.min(6, this.shake + n);
  }

  burst(x, y, n, colors, speed, life, gravity) {
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2, v = speed * (0.35 + Math.random() * 0.8);
      const l = life * (0.6 + Math.random() * 0.6);
      this.particles.push({
        x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: l, max: l, g: gravity,
        color: colors[k % colors.length], size: Math.random() < 0.3 ? 2 : 1,
      });
    }
  }

  smoke(x, y, n) {
    for (let k = 0; k < n; k++) {
      const l = 0.7 + Math.random() * 0.5;
      this.particles.push({ smoke: true, x: x + (Math.random() - 0.5) * 8, y, vx: (Math.random() - 0.5) * 10, vy: -12 - Math.random() * 10, life: l, max: l, r: 2 + Math.random() * 2 });
    }
  }

  // ---------------------------------------------------------------- frame

  draw(view, players, { dt = 1 / 60, labels = null } = {}) {
    this.time += dt;
    const t = this.time, b = this.b;
    b.drawImage(this.floor, 0, 0);
    this.drawFloorFeatures(view, t);
    this.drawShadows(view);
    this.drawItems(view, t);
    this.drawBlocks(view, t);
    for (const bomb of view.bombs) this.drawBomb(bomb, t);
    this.drawFire(view.expl);
    const alive = players.filter((p) => p.alive).sort((p, q) => p.y - q.y);
    for (const p of alive) this.drawFighter(p, t);
    this.drawGhosts(dt);
    this.drawParticles(dt);

    const g = this.g, S = this.scale;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = '#0e0c12';
    g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    let sx = 0, sy = 0;
    if (this.shake > 0) {
      sx = Math.round((Math.random() * 2 - 1) * this.shake) * S;
      sy = Math.round((Math.random() * 2 - 1) * this.shake) * S;
      this.shake = Math.max(0, this.shake - dt * 16);
    }
    g.imageSmoothingEnabled = false;
    g.drawImage(this.buf, this.ox + sx, this.oy + sy, NW * S, NH * S);
    this.drawLight(view, alive, t, sx, sy);
    this.drawVignette();
    if (labels) this.drawLabels(alive, labels, sx, sy);
  }

  drawFloorFeatures(view, t) {
    const b = this.b, map = STAGES[view.stage]?.map;
    const lavaFrame = this.sp.lava[Math.floor(t * 3) % 4];
    for (let i = 0; i < W * H; i++) {
      const x = (i % W) * TILE, y = ((i / W) | 0) * TILE;
      if (view.grid[i] === LAVA) b.drawImage(lavaFrame, x, y);
      else if (map) {
        const ch = map[(i / W) | 0][i % W];
        if (ch === 'a' || ch === 'A') b.drawImage(this.sp.gates.a, x, y);
        else if (ch === 'b' || ch === 'B') b.drawImage(this.sp.gates.b, x, y);
      }
    }
    for (const v of view.vents) {
      const x = (v.i % W) * TILE, y = ((v.i / W) | 0) * TILE;
      b.drawImage(this.sp.vent, x, y);
      if (v.t < VENT_WARN) {
        // bubbling core that brightens as the eruption nears
        const k = 1 - v.t / VENT_WARN;
        b.fillStyle = k > 0.66 ? '#ffd34d' : k > 0.33 ? '#ff7a1a' : '#a8321a';
        disc(b, x + 8, y + 8, 2 + k * 1.5 + (Math.sin(t * 30) > 0 ? 0.5 : 0));
        if (Math.random() < k * 0.5) this.particles.push({ x: x + 6 + Math.random() * 4, y: y + 8, vx: (Math.random() - 0.5) * 12, vy: -30 - Math.random() * 20, life: 0.4, max: 0.4, g: 60, color: '#ffc43d', size: 1 });
      }
    }
  }

  drawShadows(view) {
    const b = this.b;
    b.fillStyle = 'rgba(0,0,0,0.28)';
    for (let y = 0; y < H - 1; y++) {
      for (let x = 0; x < W; x++) {
        const g = view.grid[idx(x, y)], below = view.grid[idx(x, y + 1)];
        if ((g === WALL || g === CRATE) && below !== WALL && below !== CRATE) b.fillRect(x * TILE, (y + 1) * TILE, TILE, 3);
      }
    }
  }

  drawItems(view, t) {
    const b = this.b;
    for (let i = 0; i < W * H; i++) {
      const k = view.items[i];
      if (!k) continue;
      const x = (i % W) * TILE, y = ((i / W) | 0) * TILE;
      const bob = Math.round(Math.sin(t * 4 + i) * 1);
      b.drawImage(this.sp.shadow, x + 2, y + 13);
      b.drawImage(this.sp.items[k], x, y - 1 + bob);
    }
  }

  drawBlocks(view, t) {
    const b = this.b, sp = this.sp;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = idx(x, y), g = view.grid[i];
        if (g === CRATE) { b.drawImage(sp.crate, x * TILE, y * TILE); continue; }
        if (g !== WALL) continue;
        const edge = x === 0 || y === 0 || x === W - 1 || y === H - 1;
        const fallen = this.drops.get(i);
        const img = edge ? sp.border : fallen || !isPillar(view, x, y) ? sp.fallen : sp.pillar[hash(x, y) < 0.35 ? 1 : 0];
        if (fallen) {
          const k = Math.min(1, (t - fallen.t0) / 0.3);
          if (k < 1) {
            b.fillStyle = `rgba(0,0,0,${0.15 + k * 0.35})`;
            b.fillRect(x * TILE + 2, y * TILE + 4, 12, 10);
            b.drawImage(img, x * TILE, y * TILE - Math.round((1 - k) ** 2 * 48));
            continue;
          }
          if (!fallen.landed) {
            fallen.landed = true;
            this.bump(1.2);
            this.smoke(x * TILE + 8, y * TILE + 14, 3);
          }
        }
        b.drawImage(img, x * TILE, y * TILE);
      }
    }
  }

  drawBomb(bomb, t) {
    const b = this.b;
    const cx = Math.round(bomb.x * TILE) + 8, cy = Math.round(bomb.y * TILE) + 9;
    const urgency = 1 - Math.max(0, bomb.fuse) / FUSE;
    const swell = Math.sin(t * (5 + urgency * 16)) > 0.2 ? 1 : 0;
    const r = 5 + swell;
    b.drawImage(this.sp.shadow, cx - 6, cy + 4);
    b.fillStyle = '#0e0c14';
    disc(b, cx, cy, r + 0.6);
    b.fillStyle = bomb.fuse < 0.6 && Math.sin(t * 40) > 0 ? '#8a2228' : '#2a2536';
    disc(b, cx, cy, r - 0.4);
    b.fillStyle = '#5a5370';
    b.fillRect(cx - 3, cy - 3, 2, 1);
    b.fillRect(cx - 4, cy - 2, 1, 2);
    b.fillStyle = '#ffffff';
    b.fillRect(cx - 3, cy - 2, 1, 1);
    b.fillStyle = '#c8a06a';
    b.fillRect(cx + 1, cy - r - 1, 1, 2);
    b.fillRect(cx + 2, cy - r - 2, 1, 1);
    b.fillStyle = Math.sin(t * 50) > 0 ? '#ffffff' : '#ffd34d';
    b.fillRect(cx + 3, cy - r - 3, 1, 1);
    if (Math.random() < 0.35) {
      this.particles.push({ x: cx + 3, y: cy - r - 3, vx: (Math.random() - 0.5) * 30, vy: -10 - Math.random() * 25, life: 0.25, max: 0.25, g: 80, color: '#ffd34d', size: 1 });
    }
  }

  drawFire(expl) {
    const b = this.b;
    for (const e of expl) {
      const k = Math.max(0, e.t / BLAST_TIME);
      const amp = k > 0.85 ? (1 - k) / 0.15 : Math.min(1, k / 0.6);
      const set = new Set(e.cells.map(([x, y]) => idx(x, y)));
      const jitter = Math.random() < 0.3 ? 2 : 0;
      for (const [w0, col] of FIRE) {
        const w = 2 * Math.round((w0 * amp + jitter) / 2);
        if (w <= 0) continue;
        b.fillStyle = col;
        for (const [x, y] of e.cells) {
          const cx = x * TILE + 8, cy = y * TILE + 8;
          disc(b, cx, cy, w / 2 + 1);
          for (const [dx, dy] of DIR4) {
            if (!set.has(idx(x + dx, y + dy))) continue;
            if (dx) b.fillRect(dx > 0 ? cx : cx - 8, cy - w / 2, 8, w);
            else b.fillRect(cx - w / 2, dy > 0 ? cy : cy - 8, w, 8);
          }
        }
      }
    }
  }

  drawFighter(p, t) {
    const b = this.b;
    const frame = Math.floor(t * 9 + p.id * 1.7) % 4;
    const bob = p.moving && Math.floor(t * 12) % 2 ? 1 : 0;
    const X = Math.round(p.x * TILE), Y = Math.round(p.y * TILE);
    b.drawImage(this.sp.shadow, X + 2, Y + 13);
    b.drawImage(this.sp.fighters[p.id][p.dir || 'down'][frame], X, Y - 3 - bob);
    if (p.moving && Math.random() < 0.25) {
      const pal = PALETTES[p.id];
      this.particles.push({ x: X + 5 + Math.random() * 6, y: Y + 12, vx: (Math.random() - 0.5) * 8, vy: -14 - Math.random() * 10, life: 0.45, max: 0.45, g: 0, color: Math.random() < 0.5 ? pal.l : pal.c, size: 1 });
    }
  }

  drawGhosts(dt) {
    const b = this.b;
    this.ghosts = this.ghosts.filter((gh) => (gh.t += dt) < 0.9);
    for (const gh of this.ghosts) {
      const k = gh.t / 0.9;
      const X = Math.round(gh.x * TILE), Y = Math.round(gh.y * TILE) - 3 - Math.round(k * 12);
      b.globalAlpha = 1 - k;
      b.drawImage(gh.t < 0.12 ? this.sp.white[0] : this.sp.fighters[gh.slot].up[Math.floor(gh.t * 12) % 4], X, Y);
      b.globalAlpha = 1;
    }
  }

  drawParticles(dt) {
    const b = this.b;
    this.particles = this.particles.filter((p) => (p.life -= dt) > 0);
    for (const p of this.particles) {
      p.vy += (p.g || 0) * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const k = p.life / p.max;
      if (p.smoke) {
        b.fillStyle = `rgba(150,140,160,${0.35 * k})`;
        disc(b, Math.round(p.x), Math.round(p.y), p.r + (1 - k) * 3);
      } else {
        b.globalAlpha = Math.min(1, k * 2);
        b.fillStyle = p.color;
        b.fillRect(Math.round(p.x), Math.round(p.y), p.size, p.size);
        b.globalAlpha = 1;
      }
    }
  }

  // Soft additive light at screen resolution: the "modern" layer over the pixel art.
  drawLight(view, players, t, sx, sy) {
    const g = this.g, S = this.scale * TILE, L = this.light;
    const put = (img, tx, ty, radius, alpha) => {
      if (alpha <= 0.005) return;
      const r = radius * S;
      g.globalAlpha = Math.min(1, alpha);
      g.drawImage(img, this.ox + sx + tx * S - r, this.oy + sy + ty * S - r, r * 2, r * 2);
    };
    g.globalCompositeOperation = 'lighter';
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const gr = view.grid[idx(x, y)];
        if (gr === LAVA) put(L.fire, x + 0.5, y + 0.5, 1.1, 0.12 + 0.04 * Math.sin(t * 2 + x));
        else if (gr === WALL && isPillar(view, x, y) && hash(x, y) < 0.35) put(L.fire, x + 0.5, y + 0.4, 0.8, 0.06 + 0.03 * Math.sin(t * 3 + x * 7));
        else if (view.items[idx(x, y)]) put(L.warm, x + 0.5, y + 0.5, 0.75, 0.09);
      }
    }
    const map = STAGES[view.stage]?.map;
    if (map) {
      for (const [i] of view.warps) {
        const ch = map[(i / W) | 0][i % W].toLowerCase();
        put(L[ch], (i % W) + 0.5, ((i / W) | 0) + 0.5, 1, 0.16 + 0.06 * Math.sin(t * 4));
      }
    }
    for (const v of view.vents) if (v.t < VENT_WARN) put(L.fire, (v.i % W) + 0.5, ((v.i / W) | 0) + 0.5, 1.2, 0.35 * (1 - v.t / VENT_WARN));
    for (const bomb of view.bombs) {
      const urgency = 1 - Math.max(0, bomb.fuse) / FUSE;
      put(L.red, bomb.x + 0.5, bomb.y + 0.55, 0.9, 0.08 + 0.22 * urgency * (Math.sin(t * 20) > 0 ? 1 : 0.5));
    }
    for (const e of view.expl) {
      const k = Math.max(0, e.t / BLAST_TIME);
      for (const [x, y] of e.cells) put(L.fire, x + 0.5, y + 0.5, 1.6, 0.5 * k);
    }
    for (const p of players) put(L.players[p.id], p.x + 0.5, p.y + 0.35, 1.3, 0.2);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
  }

  drawVignette() {
    const g = this.g, w = this.canvas.width, h = this.canvas.height;
    if (!this.vignette) {
      const v = makeCanvas(w, h), vg = v.getContext('2d');
      const grad = vg.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.75);
      grad.addColorStop(0, 'rgba(0,0,0,0)');
      grad.addColorStop(1, 'rgba(0,0,0,0.6)');
      vg.fillStyle = grad;
      vg.fillRect(0, 0, w, h);
      this.vignette = v;
    }
    g.drawImage(this.vignette, 0, 0);
  }

  drawLabels(players, labels, sx, sy) {
    const g = this.g, S = this.scale;
    const size = Math.max(11, Math.round(5 * S));
    g.font = `500 ${size}px "Pixelify Sans", ui-monospace, monospace`;
    g.textAlign = 'center';
    g.textBaseline = 'bottom';
    g.lineJoin = 'round';
    for (const p of players) {
      const text = labels[p.id];
      if (!text) continue;
      const x = this.ox + sx + (p.x * TILE + 8) * S, y = this.oy + sy + (p.y * TILE - 5) * S;
      g.lineWidth = Math.max(3, size / 3);
      g.strokeStyle = 'rgba(10,8,14,0.85)';
      g.strokeText(text, x, y);
      g.fillStyle = PALETTES[p.id].c;
      g.fillText(text, x, y);
    }
  }
}

// Original pillars sit on even/even tiles; any other inner wall dropped in during sudden death.
function isPillar(view, x, y) {
  const map = STAGES[view.stage]?.map;
  return map ? map[y][x] === '#' : x % 2 === 0 && y % 2 === 0;
}
