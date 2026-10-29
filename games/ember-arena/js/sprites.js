// Pixel art for Ember Arena. Everything is drawn in code at native resolution (16px tiles),
// and the renderer scales it up without smoothing.
import { W, H, DIRS, PU_BOMB, PU_FIRE, PU_SPEED, PU_KICK } from './sim.js';

export const TILE = 16;

export const PALETTES = [
  { name: 'Ember', o: '#5a1608', m: '#e8501c', l: '#ff9b2f', c: '#ffe7a3', glow: '#ff7a2f' },
  { name: 'Frost', o: '#0b2552', m: '#2b7be4', l: '#5cc6ff', c: '#dcf7ff', glow: '#4cb8ff' },
  { name: 'Moss', o: '#103a12', m: '#33a43f', l: '#8ade55', c: '#eaffb8', glow: '#7ddc4a' },
  { name: 'Dusk', o: '#360c4f', m: '#9a3bd4', l: '#de6dff', c: '#ffdcff', glow: '#d46bff' },
];

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function px(g, x, y, col) {
  g.fillStyle = col;
  g.fillRect(x, y, 1, 1);
}

export function hash(x, y, k = 0) {
  let h = (x * 374761393 + y * 668265263 + k * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Filled disc centred on a pixel corner, in the current fill style.
export function disc(g, cx, cy, r) {
  const n = Math.ceil(r);
  for (let j = -n; j < n; j++) {
    const dy = j + 0.5;
    const hw = Math.round(Math.sqrt(Math.max(0, r * r - dy * dy)));
    if (hw > 0) g.fillRect(cx - hw, cy + j, hw * 2, 1);
  }
}

function stamp(g, rows, pal, ox, oy) {
  rows.forEach((row, y) => [...row].forEach((ch, x) => { if (pal[ch]) px(g, ox + x, oy + y, pal[ch]); }));
}

// ---------------------------------------------------------------- characters

// The fighters are little flame spirits: a round belly with a flickering tip.
function flameShape(frame) {
  const tipY = [2.5, 1.5, 2.5, 3.5][frame];
  const phase = frame * Math.PI / 2;
  const cx = 8, cy = 13.5, r = 5.5;
  return (x, y) => {
    const px = x + 0.5, py = y + 0.5;
    if ((px - cx) ** 2 + (py - cy) ** 2 <= r * r) return Math.hypot(px - cx, py - cy - 0.6) / r;
    if (py < cy && py > tipY) {
      const k = (py - tipY) / (cy - tipY);
      const mid = cx + Math.sin(phase + k * 2.6) * (1 - k) ** 1.4 * 2.2;
      const lat = Math.abs(px - mid) / (r * k ** 0.8);
      if (lat <= 1) return Math.min(1, lat * 0.75 + (1 - k) * 0.45);
    }
    return null;
  };
}

const EYES = { down: [5, 9], left: [4, 8], right: [6, 10] };

function fighter(pal, dir, frame, white) {
  const c = makeCanvas(16, 20), g = c.getContext('2d');
  const shape = flameShape(frame);
  for (let y = 0; y < 20; y++) {
    for (let x = 0; x < 16; x++) {
      const q = shape(x, y);
      if (q === null) continue;
      const edge = shape(x + 1, y) === null || shape(x - 1, y) === null || shape(x, y + 1) === null || shape(x, y - 1) === null;
      px(g, x, y, white ? '#ffffff' : edge ? pal.o : q < 0.42 ? pal.c : q < 0.7 ? pal.l : pal.m);
    }
  }
  if (!white && EYES[dir]) {
    for (const ex of EYES[dir]) {
      g.fillStyle = '#1c0f1a';
      g.fillRect(ex, 12, 2, 2);
      px(g, ex, 12, '#ffffff');
    }
  }
  return c;
}

export function portrait(slot) {
  const c = fighter(PALETTES[slot], 'down', 0, false);
  c.className = 'pixel';
  return c;
}

// ---------------------------------------------------------------- tiles

export function floorLayer() {
  const c = makeCanvas(W * TILE, H * TILE), g = c.getContext('2d');
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const X = x * TILE, Y = y * TILE;
      g.fillStyle = (x + y) % 2 ? '#2c2834' : '#2f2b38';
      g.fillRect(X, Y, 16, 16);
      g.fillStyle = '#38333f';
      g.fillRect(X, Y, 16, 1);
      g.fillRect(X, Y, 1, 16);
      g.fillStyle = '#221f29';
      g.fillRect(X, Y + 15, 16, 1);
      g.fillRect(X + 15, Y, 1, 16);
      for (let k = 0; k < 6; k++) {
        const sx = 2 + Math.floor(hash(x, y, k) * 12), sy = 2 + Math.floor(hash(x, y, k + 9) * 12);
        px(g, X + sx, Y + sy, hash(x, y, k + 20) > 0.5 ? '#36313f' : '#26232d');
      }
      if (hash(x, y, 99) < 0.18) {
        const sx = 3 + Math.floor(hash(x, y, 98) * 8), sy = 3 + Math.floor(hash(x, y, 97) * 8);
        for (let k = 0; k < 4; k++) px(g, X + sx + k, Y + sy + (k >> 1), '#24212b');
      }
    }
  }
  return c;
}

function block(top, hi, lo, front, frontLo, cracks) {
  const c = makeCanvas(16, 16), g = c.getContext('2d');
  g.fillStyle = top; g.fillRect(0, 0, 16, 12);
  g.fillStyle = hi; g.fillRect(0, 0, 16, 1); g.fillRect(0, 0, 1, 12);
  g.fillStyle = lo; g.fillRect(0, 11, 16, 1); g.fillRect(15, 0, 1, 12);
  g.fillStyle = front; g.fillRect(0, 12, 16, 4);
  g.fillStyle = frontLo; g.fillRect(0, 15, 16, 1);
  for (const [x, y] of [[3, 3], [11, 2], [6, 8], [12, 7]]) px(g, x, y, lo);
  for (const [x, y] of [[4, 3], [12, 2], [7, 8]]) px(g, x, y, hi);
  if (cracks) {
    [[4, 3], [5, 4], [5, 5], [6, 6], [7, 6], [8, 7], [9, 8], [10, 8]].forEach(([x, y], k) => px(g, x, y, k % 3 ? '#ff6a1a' : '#ffb040'));
    [[11, 12], [11, 13], [12, 14]].forEach(([x, y]) => px(g, x, y, '#e2501a'));
  }
  return c;
}

function crate() {
  const c = makeCanvas(16, 16), g = c.getContext('2d');
  g.fillStyle = '#4a2c14'; g.fillRect(0, 0, 16, 16);
  g.fillStyle = '#a86c35'; g.fillRect(1, 1, 14, 11);
  g.fillStyle = '#c98a4c'; g.fillRect(1, 1, 14, 1); g.fillRect(1, 1, 1, 11);
  g.fillStyle = '#7f4f24'; g.fillRect(2, 4, 12, 1); g.fillRect(2, 8, 12, 1);
  for (let k = 0; k < 10; k++) px(g, 3 + k, 10 - Math.round(k * 0.8), '#8d5a2b');
  for (const [x, y] of [[2, 2], [13, 2], [2, 10], [13, 10]]) px(g, x, y, '#e0c68f');
  g.fillStyle = '#5b3618'; g.fillRect(0, 12, 16, 4);
  g.fillStyle = '#6e441f'; g.fillRect(1, 12, 14, 1);
  g.fillStyle = '#3a210d'; g.fillRect(0, 15, 16, 1);
  return c;
}

// Lava gets a few animation frames of drifting bright blobs.
function lavaFrames() {
  return [0, 1, 2, 3].map((f) => {
    const c = makeCanvas(16, 16), g = c.getContext('2d');
    g.fillStyle = '#b5260f'; g.fillRect(0, 0, 16, 16);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const v = Math.sin((x + f * 2) * 0.8) + Math.sin((y - f) * 0.9 + x * 0.3);
        if (v > 1.1) px(g, x, y, '#ffb43a');
        else if (v > 0.45) px(g, x, y, '#f0601a');
      }
    }
    g.fillStyle = 'rgba(40,8,4,0.55)'; g.fillRect(0, 0, 16, 2);
    return c;
  });
}

function vent() {
  const c = makeCanvas(16, 16), g = c.getContext('2d');
  g.fillStyle = '#1d1a22'; disc(g, 8, 8, 6.5);
  g.fillStyle = '#4a4256'; disc(g, 8, 8, 5.5);
  g.fillStyle = '#16131b'; disc(g, 8, 8, 3.5);
  for (const [x, y] of [[4, 5], [11, 5], [5, 11], [10, 11]]) px(g, x, y, '#5d546b');
  return c;
}

function gate(col) {
  const c = makeCanvas(16, 16), g = c.getContext('2d');
  g.fillStyle = '#1b1822'; disc(g, 8, 8, 7);
  g.fillStyle = col; disc(g, 8, 8, 6);
  g.fillStyle = '#1b1822'; disc(g, 8, 8, 4.5);
  g.fillStyle = col;
  for (const [x, y] of [[7, 2], [8, 2], [7, 13], [8, 13], [2, 7], [2, 8], [13, 7], [13, 8]]) px(g, x, y, '#ffffff');
  return c;
}

// ---------------------------------------------------------------- power-ups

const ITEM_COLORS = {
  [PU_BOMB]: ['#3f6fe0', '#6f9bff', '#1d3577'],
  [PU_FIRE]: ['#e8501c', '#ff8a4a', '#7a2108'],
  [PU_SPEED]: ['#f2b72c', '#ffd970', '#7a5208'],
  [PU_KICK]: ['#2fae64', '#5fd690', '#135c31'],
};

const ICONS = {
  [PU_FIRE]: ['...w....', '...ww...', '..wyw...', '..wyyw..', '.wyyyyw.', '.wyrryw.', '.wyrryw.', '..wwww..'],
  [PU_SPEED]: ['....oo..', '...oo...', '..oo....', '.oooooo.', '....oo..', '...oo...', '..oo....', '..o.....'],
  [PU_KICK]: ['........', 'ww..ww..', '.ww..ww.', '..ww..ww', '.ww..ww.', 'ww..ww..', '........', '........'],
};
const ICON_PAL = { o: '#2a1a04', w: '#ffffff', y: '#ffd34d', r: '#ff3d1a' };

export function itemIcon(kind) {
  const c = makeCanvas(16, 16), g = c.getContext('2d');
  const [bg, hi, lo] = ITEM_COLORS[kind];
  g.fillStyle = lo; g.fillRect(3, 2, 10, 12); g.fillRect(2, 3, 12, 10);
  g.fillStyle = bg; g.fillRect(3, 3, 10, 10);
  g.fillStyle = hi; g.fillRect(3, 3, 10, 1); g.fillRect(3, 3, 1, 9);
  if (kind === PU_BOMB) {
    g.fillStyle = '#16131d'; disc(g, 8, 9, 3.4);
    px(g, 6, 7, '#ffffff');
    px(g, 9, 5, '#c8a06a'); px(g, 10, 4, '#c8a06a');
    px(g, 11, 3, '#ffd34d');
  } else stamp(g, ICONS[kind], ICON_PAL, 4, 4);
  return c;
}

export function buildSprites() {
  const shadow = makeCanvas(12, 4), sg = shadow.getContext('2d');
  sg.fillStyle = 'rgba(0,0,0,0.35)';
  sg.fillRect(2, 0, 8, 1); sg.fillRect(0, 1, 12, 2); sg.fillRect(2, 3, 8, 1);
  return {
    fighters: PALETTES.map((pal) => Object.fromEntries(DIRS.map((d) => [d, [0, 1, 2, 3].map((f) => fighter(pal, d, f, false))]))),
    white: [0, 1, 2, 3].map((f) => fighter(null, 'up', f, true)),
    shadow,
    border: block('#3b3446', '#4a4256', '#2d2836', '#241f2b', '#17141c', false),
    pillar: [
      block('#4a4256', '#5d546b', '#3a3344', '#2a2431', '#1d1922', false),
      block('#4a4256', '#5d546b', '#3a3344', '#2a2431', '#1d1922', true),
    ],
    fallen: block('#54303a', '#6e3e48', '#3e2229', '#2c171d', '#1d0e12', true),
    crate: crate(),
    lava: lavaFrames(),
    vent: vent(),
    gates: { a: gate('#4cb8ff'), b: gate('#d46bff') },
    items: Object.fromEntries([PU_BOMB, PU_FIRE, PU_SPEED, PU_KICK].map((k) => [k, itemIcon(k)])),
  };
}
