// Sound effects synthesised with Web Audio, so the game ships without audio files.
let ctx = null, out = null, noiseBuf = null, lastBoom = 0;
let muted = false;
try { muted = localStorage.getItem('ember-arena:muted') === '1'; } catch { /* storage blocked */ }

const VOLUME = 0.45;

export function unlock() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    out = ctx.createGain();
    out.gain.value = muted ? 0 : VOLUME;
    out.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') ctx.resume();
}

export const isMuted = () => muted;

export function setMuted(m) {
  muted = m;
  try { localStorage.setItem('ember-arena:muted', m ? '1' : '0'); } catch { /* storage blocked */ }
  if (out) out.gain.value = m ? 0 : VOLUME;
}

function tone({ f, f2 = f, dur = 0.1, type = 'square', vol = 0.15, at = 0 }) {
  if (!ctx || muted) return;
  const t = ctx.currentTime + at;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(1, f2), t + dur);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + dur + 0.02);
}

function noise({ dur = 0.3, vol = 0.3, from = 1200, to = 200, at = 0 }) {
  if (!ctx || muted) return;
  const t = ctx.currentTime + at;
  const src = ctx.createBufferSource(), flt = ctx.createBiquadFilter(), g = ctx.createGain();
  src.buffer = noiseBuf;
  flt.type = 'lowpass';
  flt.frequency.setValueAtTime(from, t);
  flt.frequency.exponentialRampToValueAtTime(to, t + dur);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(flt).connect(g).connect(out);
  src.start(t);
  src.stop(t + dur);
}

export const sfx = {
  place: () => tone({ f: 220, f2: 110, dur: 0.08, type: 'triangle', vol: 0.25 }),
  boom: () => {
    if (!ctx || ctx.currentTime - lastBoom < 0.05) return;   // chain reactions: one big boom, not ten
    lastBoom = ctx.currentTime;
    noise({ dur: 0.55, vol: 0.5, from: 2400, to: 120 });
    tone({ f: 120, f2: 40, dur: 0.35, type: 'sine', vol: 0.45 });
  },
  crate: () => noise({ dur: 0.15, vol: 0.12, from: 3000, to: 800 }),
  pick: () => [660, 990, 1320].forEach((f, i) => tone({ f, dur: 0.08, vol: 0.12, at: i * 0.07 })),
  die: () => tone({ f: 520, f2: 80, dur: 0.6, type: 'sawtooth', vol: 0.14 }),
  kick: () => tone({ f: 160, f2: 320, dur: 0.06, vol: 0.15 }),
  warp: () => tone({ f: 300, f2: 1400, dur: 0.18, type: 'sine', vol: 0.18 }),
  drop: () => { noise({ dur: 0.18, vol: 0.25, from: 900, to: 100 }); tone({ f: 90, f2: 50, dur: 0.15, type: 'sine', vol: 0.3 }); },
  beep: () => tone({ f: 440, dur: 0.12, vol: 0.15 }),
  go: () => tone({ f: 880, dur: 0.3, vol: 0.18 }),
  alarm: () => { for (let i = 0; i < 3; i++) tone({ f: 700, f2: 500, dur: 0.18, vol: 0.12, at: i * 0.22 }); },
  win: () => [523, 659, 784, 1047].forEach((f, i) => tone({ f, dur: 0.16, vol: 0.14, at: i * 0.11 })),
};
