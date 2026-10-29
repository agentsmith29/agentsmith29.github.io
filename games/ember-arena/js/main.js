// Ember Arena: screens, lobby, game loop and online sync.
//
// Online model: the host's browser runs the only real simulation. Guests send their inputs
// every tick and receive snapshots 30 times a second. A guest predicts its own movement
// locally (replaying inputs the host hasn't confirmed yet) and draws everyone else slightly
// in the past, interpolated between snapshots.
import * as Sim from './sim.js';
import { createBot, botUpdate } from './ai.js';
import { Renderer } from './render.js';
import { Keyboard } from './input.js';
import { sfx, unlock, isMuted, setMuted } from './audio.js';
import { HostNet, GuestNet, parseCode, netAvailable } from './net.js';
import { PALETTES, portrait, itemIcon } from './sprites.js';

const SEND_EVERY = 2;          // ticks between snapshots (30 per second)
const INTERP_TICKS = 5;        // draw remote players this many ticks in the past
const PEER_TIMEOUT = 8000;     // ms of silence before a peer counts as gone
const HUD_HEIGHT = 68;
const BOT_NAMES = ['Cinder', 'Wisp', 'Flicker', 'Blaze'];
const DIFF_LABEL = { easy: 'Easy', normal: 'Normal', hard: 'Hard' };
const SLOT_CYCLE = ['open', 'bot:normal', 'bot:hard', 'bot:easy', 'local2'];

const $ = (sel) => document.querySelector(sel);
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const cleanName = (n) => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 14);
const store = {
  get(k, d) { try { return localStorage.getItem('ember-arena:' + k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ember-arena:' + k, v); } catch { /* storage blocked */ } },
};

const kb = new Keyboard();
const renderer = new Renderer($('#stage'));

const app = {
  mode: null,              // 'offline' | 'host' | 'guest'
  net: null,
  code: null,
  slots: [],
  you: 0,
  settings: { wins: 3, time: 120, stage: 'rotate' },
  game: null,
  attract: null,
  peers: new Map(),        // host: peer id -> last time we heard from it
  lastHeard: 0,            // guest: last time we heard from the host
  ping: null,
};

const myName = () => cleanName($('#name').value) || 'Player';
const inviteLink = (code) => `${location.origin}${location.pathname}?join=${code}`;

// ---------------------------------------------------------------- screens

function showScreen(name) {
  for (const id of ['title', 'lobby', 'game']) $('#screen-' + id).hidden = id !== name;
  document.body.classList.toggle('menu', name !== 'game');
  $('#hud').hidden = name !== 'game';
  $('#pause').hidden = true;
  renderer.setInset(name === 'game' ? HUD_HEIGHT : 0);
  kb.active = name === 'game';
}

function toast(text) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  $('#toasts').append(el);
  setTimeout(() => el.classList.add('out'), 3200);
  setTimeout(() => el.remove(), 3700);
}

// ---------------------------------------------------------------- title

function initTitle() {
  const name = $('#name');
  name.value = store.get('name', '');
  name.addEventListener('input', () => store.set('name', cleanName(name.value)));
  PALETTES.forEach((_, i) => {
    const c = portrait(i);
    c.style.animationDelay = `${i * -0.3}s`;
    $('#title-cast').append(c);
  });
  $('#btn-offline').onclick = openOffline;
  $('#btn-host').onclick = openHost;
  $('#join-form').onsubmit = (e) => {
    e.preventDefault();
    const code = parseCode($('#join-code').value);
    if (code) joinLobby(code);
    else toast('That does not look like a lobby code or invite link.');
  };
  const invite = parseCode(new URLSearchParams(location.search).get('join'));
  if (invite) {
    $('#invite').hidden = false;
    $('#invite-code').textContent = invite;
    $('#btn-join-invite').onclick = () => joinLobby(invite);
  }
  if (matchMedia('(pointer: coarse)').matches) $('#touch-note').hidden = false;
}

// ---------------------------------------------------------------- lobby

function openOffline() {
  app.mode = 'offline';
  app.you = 0;
  app.slots = [{ kind: 'you' }, { kind: 'bot', diff: 'normal' }, { kind: 'bot', diff: 'normal' }, { kind: 'bot', diff: 'normal' }];
  renderLobby();
  showScreen('lobby');
}

async function openHost() {
  if (!netAvailable()) { toast('Online play could not load (PeerJS was blocked or offline).'); return; }
  app.mode = 'host';
  app.you = 0;
  app.code = null;
  app.slots = [{ kind: 'you' }, { kind: 'open' }, { kind: 'open' }, { kind: 'open' }];
  renderLobby();
  showScreen('lobby');
  const net = new HostNet({
    onData: (peer, m) => app.net === net && onHostData(peer, m),
    onLeave: (peer) => app.net === net && dropPeer(peer),
    onError: (e) => console.warn('host network error', e),
  });
  app.net = net;
  try {
    app.code = await net.open();
    if (app.net !== net) { net.close(); return; }
    renderLobby();
  } catch (e) {
    if (app.net !== net) return;
    toast(`Could not open an online lobby (${e.type || e.message || 'network error'}).`);
    leaveLobby();
  }
}

async function joinLobby(code) {
  if (!netAvailable()) { toast('Online play could not load (PeerJS was blocked or offline).'); return; }
  unlock();
  app.mode = 'guest';
  app.code = code;
  app.you = -1;
  app.slots = [];
  renderLobby();
  showScreen('lobby');
  const net = new GuestNet({
    onData: (m) => app.net === net && onGuestData(m),
    onClose: () => app.net === net && lostHost('The host closed the lobby.'),
  });
  app.net = net;
  try {
    await net.join(code);
    if (app.net !== net) return;
    app.lastHeard = performance.now();
    net.send({ t: 'hello', name: myName() });
    history.replaceState(null, '', `?join=${code}`);
  } catch (e) {
    if (app.net !== net) return;
    toast(e.type === 'peer-unavailable' ? `Lobby ${code} was not found. It may have closed.` : `Could not connect to lobby ${code}.`);
    leaveLobby();
  }
}

function leaveLobby() {
  const net = app.net;
  if (app.mode === 'guest') net?.send({ t: 'bye' });
  app.net = null;
  setTimeout(() => net?.close(), 150);
  app.mode = null;
  app.game = null;
  app.code = null;
  app.ping = null;
  app.peers.clear();
  history.replaceState(null, '', location.pathname);
  $('#invite').hidden = true;
  renderer.reset();
  showScreen('title');
}

function lostHost(msg) {
  if (app.mode !== 'guest') return;
  toast(msg);
  leaveLobby();
}

function slotName(sl, i) {
  if (sl.kind === 'you') return myName();
  if (sl.kind === 'local2') return 'Player 2';
  if (sl.kind === 'bot') return BOT_NAMES[i];
  if (sl.kind === 'open') return app.mode === 'offline' ? 'Empty' : 'Waiting…';
  return sl.name;
}

function slotTag(sl, i) {
  const twoLocal = app.slots.some((s) => s.kind === 'local2');
  switch (sl.kind) {
    case 'you': return twoLocal ? 'You · WASD + Space' : 'You';
    case 'host': return 'Host';
    case 'local2': return app.mode === 'guest' ? "Host's keyboard" : 'Arrows + Enter';
    case 'bot': return `Bot · ${DIFF_LABEL[sl.diff]}`;
    case 'remote': return i === app.you ? 'You' : 'Online';
    default: return app.mode === 'guest' ? 'Open' : 'Click to add a bot';
  }
}

function renderLobby() {
  const editable = app.mode !== 'guest';
  $('#lobby-title').textContent = app.mode === 'offline' ? 'Local match' : 'Online lobby';
  $('#share').hidden = app.mode !== 'host';
  if (app.mode === 'host') {
    $('#share-link').value = app.code ? inviteLink(app.code) : 'Opening lobby…';
    $('#btn-copy').disabled = !app.code;
    $('#share-code').textContent = app.code || '…';
  }
  const slots = $('#slots');
  slots.replaceChildren();
  if (app.mode === 'guest' && !app.slots.length) {
    const p = document.createElement('p');
    p.className = 'muted connecting';
    p.textContent = `Connecting to lobby ${app.code}…`;
    slots.append(p);
  }
  app.slots.forEach((sl, i) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `slot slot-${sl.kind}`;
    el.style.setProperty('--pc', PALETTES[i].glow);
    const pic = portrait(i);
    const name = document.createElement('span');
    name.className = 'slot-name';
    name.textContent = slotName(sl, i);
    const tag = document.createElement('span');
    tag.className = 'slot-tag';
    tag.textContent = slotTag(sl, i);
    el.append(pic, name, tag);
    const cycle = editable && sl.kind !== 'you' && sl.kind !== 'remote';
    el.disabled = !cycle;
    if (cycle) el.onclick = () => cycleSlot(i);
    slots.append(el);
  });
  for (const [id, key] of [['#set-wins', 'wins'], ['#set-time', 'time'], ['#set-stage', 'stage']]) {
    $(id).value = String(app.settings[key]);
    $(id).disabled = !editable;
  }
  const players = app.slots.filter((s) => s.kind !== 'open').length;
  $('#btn-start').hidden = !editable;
  $('#btn-start').disabled = players < 2;
  $('#lobby-wait').hidden = editable || !app.slots.length;
  $('#lobby-help').textContent = editable
    ? players < 2 ? 'Add at least one more fighter to start.' : 'Click a slot to switch between bots, a second keyboard player or an open seat.'
    : '';
}

function cycleSlot(i) {
  const sl = app.slots[i];
  let k = SLOT_CYCLE.indexOf(sl.kind === 'bot' ? `bot:${sl.diff}` : sl.kind);
  for (let n = 0; n < SLOT_CYCLE.length; n++) {
    k = (k + 1) % SLOT_CYCLE.length;
    const next = SLOT_CYCLE[k];
    if (next === 'local2' && app.slots.some((s, j) => j !== i && s.kind === 'local2')) continue;
    app.slots[i] = next.startsWith('bot') ? { kind: 'bot', diff: next.slice(4) } : { kind: next };
    break;
  }
  renderLobby();
  broadcastLobby();
}

function initLobby() {
  $('#btn-leave').onclick = leaveLobby;
  $('#btn-start').onclick = () => { unlock(); startMatch(); };
  $('#btn-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(inviteLink(app.code)); toast('Invite link copied. Send it to a friend!'); }
    catch { $('#share-link').select(); toast('Press Ctrl+C / ⌘C to copy the link.'); }
  };
  $('#set-stage').append(...Sim.STAGES.map((st, i) => new Option(st.name, String(i))));
  for (const [id, key] of [['#set-wins', 'wins'], ['#set-time', 'time'], ['#set-stage', 'stage']]) {
    $(id).onchange = (e) => {
      const v = e.target.value;
      app.settings[key] = key === 'stage' && !/^\d+$/.test(v) ? v : Number(v);
      broadcastLobby();
    };
  }
}

// ---------------------------------------------------------------- host side networking

function publicSlots() {
  return app.slots.map((sl, i) => ({ kind: sl.kind === 'you' ? 'host' : sl.kind, name: slotName(sl, i), diff: sl.diff }));
}

function broadcastLobby() {
  if (app.mode !== 'host' || !app.net) return;
  const slots = publicSlots();
  for (const id of app.net.ids()) {
    if (!app.peers.has(id)) continue;
    const you = app.slots.findIndex((s) => s.peer === id);
    app.net.send(id, { t: 'lobby', slots, settings: app.settings, you, inGame: !!app.game });
  }
}

function onHostData(peer, m) {
  if (!m || typeof m !== 'object') return;
  if (m.t === 'hello') { hostJoin(peer, m.name); return; }
  if (!app.peers.has(peer)) return;
  app.peers.set(peer, performance.now());
  switch (m.t) {
    case 'i': {
      const c = app.game && Object.values(app.game.ctrl).find((x) => x.peer === peer);
      if (c) c.queue.push({ s: m.s | 0, x: Math.sign(m.x | 0), y: Math.sign(m.y | 0), b: m.b | 0 });
      break;
    }
    case 'ping': app.net.send(peer, { t: 'pong', c: m.c }); break;
    case 'bye': dropPeer(peer); break;
  }
}

function hostJoin(peer, name) {
  if (app.peers.has(peer)) return;
  let i = app.slots.findIndex((s) => s.kind === 'open');
  if (i < 0) i = app.slots.findIndex((s) => s.kind === 'bot');
  if (i < 0) {
    app.net.send(peer, { t: 'full' });
    setTimeout(() => app.net?.drop(peer), 500);
    return;
  }
  app.peers.set(peer, performance.now());
  app.slots[i] = { kind: 'remote', peer, name: cleanName(name) || 'Guest' };
  toast(`${app.slots[i].name} joined the lobby`);
  renderLobby();
  broadcastLobby();
  if (app.game) {
    // Mid-match joiners watch until the next match starts.
    app.net.send(peer, { t: 'start', you: -1, roster: app.game.roster, settings: app.settings });
    app.game.lastGv = -1;
  }
}

function dropPeer(peer) {
  if (!app.peers.has(peer)) return;
  app.peers.delete(peer);
  app.net?.drop(peer);
  const i = app.slots.findIndex((s) => s.kind === 'remote' && s.peer === peer);
  if (i >= 0) {
    toast(`${app.slots[i].name} left`);
    app.slots[i] = { kind: 'open' };
  }
  const g = app.game;
  if (g) {
    for (const id in g.ctrl) {
      if (g.ctrl[id].peer === peer) { Sim.removePlayer(g.s, Number(id)); g.ctrl[id] = { type: 'gone' }; }
    }
  }
  renderLobby();
  broadcastLobby();
}

// ---------------------------------------------------------------- guest side networking

function onGuestData(m) {
  if (!m || typeof m !== 'object') return;
  app.lastHeard = performance.now();
  switch (m.t) {
    case 'lobby':
      app.slots = m.slots;
      app.settings = m.settings;
      app.you = m.you;
      if (!m.inGame && app.game) { app.game = null; renderer.reset(); }
      if (!app.game) showScreen('lobby');
      renderLobby();
      break;
    case 'start': startGuestGame(m); break;
    case 's': if (app.game?.role === 'guest') onSnapshot(app.game, m); break;
    case 'pong': app.ping = performance.now() - m.c; break;
    case 'full': toast('That lobby is full.'); leaveLobby(); break;
  }
}

function startGuestGame(m) {
  app.settings = m.settings;
  app.game = {
    role: 'guest', you: m.you, roster: m.roster, view: Sim.emptyView(), snaps: [], pending: [],
    seq: 0, got: false, pred: null, disp: null, lastCount: '', goUntil: 0, suddenUntil: 0,
  };
  kb.solo = true;
  renderer.reset();
  buildHud(m.roster, m.you);
  showScreen('game');
}

function onSnapshot(g, m) {
  Sim.applySnapshot(g.view, m);
  g.snaps.push({ k: m.k, at: performance.now(), p: g.view.players.map((p) => ({ id: p.id, x: p.x, y: p.y })) });
  if (g.snaps.length > 40) g.snaps.shift();
  const ack = m.a?.[g.you];
  if (ack != null) g.pending = g.pending.filter((i) => i.s > ack);
  for (const ev of m.ev || []) onEvent(ev);
  g.got = true;
}

function guestTick(g) {
  if (g.you < 0) return;
  const st = kb.state('p1');
  const inp = { t: 'i', s: ++g.seq, x: st.dx, y: st.dy, b: st.bomb };
  app.net.send(inp);
  g.pending.push(inp);
  if (g.pending.length > 180) g.pending.shift();
  g.input = st;
  predict(g);
}

// Replays inputs the host hasn't confirmed yet on top of the last confirmed position.
function predict(g) {
  const v = g.view, me = v.players.find((p) => p.id === g.you);
  if (!me) return;
  const ghost = { id: me.id, x: me.x, y: me.y, speed: me.speed, kick: false };
  if (me.alive && (v.phase === 'play' || v.phase === 'over')) {
    const world = { grid: v.grid, bombs: v.bombs.map((b) => ({ ...b, pass: b.pass.slice() })) };
    for (const i of g.pending) {
      if (i.x || i.y) Sim.movePlayer(world, ghost, i.x, i.y, Sim.TICK, false);
      Sim.updatePass(world, ghost);
    }
  }
  g.pred = { x: ghost.x, y: ghost.y };
}

function guestPlayers(g, now, dt) {
  const snaps = g.snaps, latest = snaps[snaps.length - 1];
  const rt = latest.k + (now - latest.at) * 0.06 - INTERP_TICKS;
  let a = latest, b = latest;
  for (let i = snaps.length - 1; i > 0; i--) {
    if (snaps[i - 1].k <= rt) { a = snaps[i - 1]; b = snaps[i]; break; }
  }
  const f = b.k === a.k ? 1 : Math.max(0, Math.min(1, (rt - a.k) / (b.k - a.k)));
  return g.view.players.map((p) => {
    if (p.id === g.you && g.pred) {
      if (!g.disp || Math.abs(g.disp.x - g.pred.x) + Math.abs(g.disp.y - g.pred.y) > 1.5) g.disp = { ...g.pred };
      const k = 1 - Math.pow(0.4, dt * 60);
      g.disp.x += (g.pred.x - g.disp.x) * k;
      g.disp.y += (g.pred.y - g.disp.y) * k;
      const st = g.input || { dx: 0, dy: 0 };
      const moving = p.alive && (st.dx || st.dy) && g.view.phase !== 'countdown';
      const dir = st.dx < 0 ? 'left' : st.dx > 0 ? 'right' : st.dy < 0 ? 'up' : st.dy > 0 ? 'down' : p.dir;
      return { ...p, x: g.disp.x, y: g.disp.y, dir, moving: !!moving };
    }
    const pa = a.p.find((q) => q.id === p.id), pb = b.p.find((q) => q.id === p.id);
    if (!pa || !pb || Math.abs(pb.x - pa.x) + Math.abs(pb.y - pa.y) > 2) return p;
    return { ...p, x: pa.x + (pb.x - pa.x) * f, y: pa.y + (pb.y - pa.y) * f };
  });
}

// ---------------------------------------------------------------- match (offline + host)

function startMatch() {
  const roster = app.slots.map((sl, i) => (sl.kind === 'open' ? null : { slot: i, name: slotName(sl, i) })).filter(Boolean);
  if (roster.length < 2) return;
  const s = Sim.createMatch(roster, app.settings, (Math.random() * 2 ** 32) >>> 0);
  const ctrl = {};
  for (const r of roster) {
    const sl = app.slots[r.slot];
    ctrl[r.slot] = sl.kind === 'bot' ? { type: 'bot', bot: createBot(sl.diff) }
      : sl.kind === 'remote' ? { type: 'remote', peer: sl.peer, queue: [], last: { x: 0, y: 0, b: 0 }, ack: 0 }
        : { type: 'local', scheme: sl.kind === 'local2' ? 'p2' : 'p1' };
  }
  kb.solo = !app.slots.some((sl) => sl.kind === 'local2');
  app.game = {
    role: app.mode === 'host' ? 'host' : 'offline', s, ctrl, roster, you: 0,
    lastGv: -1, sent: 0, outEvents: [], paused: false, lastCount: '', goUntil: 0, suddenUntil: 0,
  };
  if (app.mode === 'host') {
    for (const id of app.net.ids()) {
      const you = app.slots.findIndex((sl) => sl.peer === id);
      app.net.send(id, { t: 'start', you, roster, settings: app.settings });
    }
  }
  renderer.reset();
  buildHud(roster, 0);
  showScreen('game');
}

function hostTick(g) {
  const s = g.s;
  for (const p of s.players) {
    const c = g.ctrl[p.id];
    if (c.type === 'local') {
      const st = kb.state(c.scheme);
      p.input.dx = st.dx;
      p.input.dy = st.dy;
      p.input.bomb = st.bomb;
    } else if (c.type === 'bot') botUpdate(s, p, c.bot, Sim.TICK);
    else if (c.type === 'remote') {
      // One input per tick keeps the host in step with the guest's prediction;
      // a backlog (after a network hiccup) gets trimmed so lag doesn't build up.
      if (c.queue.length > 8) c.queue.splice(0, c.queue.length - 3);
      const i = c.queue.shift();
      if (i) { c.last = i; c.ack = i.s; }
      p.input.dx = c.last.x;
      p.input.dy = c.last.y;
      p.input.bomb = c.last.b;
    }
  }
  Sim.tick(s);
  for (const ev of s.events) { onEvent(ev); g.outEvents.push(ev); }
  s.events.length = 0;
  if (g.role === 'host' && ++g.sent % SEND_EVERY === 0) {
    const acks = {};
    for (const id in g.ctrl) if (g.ctrl[id].type === 'remote') acks[id] = g.ctrl[id].ack;
    const withGrid = s.gridVer !== g.lastGv || g.sent % 120 === 0;
    g.lastGv = s.gridVer;
    const m = Sim.snapshot(s, withGrid, acks);
    m.ev = g.outEvents;
    g.outEvents = [];
    app.net.broadcast(m);
  }
}

function backToLobby() {
  app.game = null;
  renderer.reset();
  renderLobby();
  showScreen('lobby');
  broadcastLobby();
}

// ---------------------------------------------------------------- events, HUD and overlays

function onEvent(ev) {
  renderer.event(ev);
  const g = app.game, now = performance.now();
  switch (ev.t) {
    case 'bomb': sfx.place(); break;
    case 'boom': sfx.boom(); break;
    case 'crate': sfx.crate(); break;
    case 'pick': sfx.pick(); break;
    case 'die': sfx.die(); break;
    case 'kick': sfx.kick(); break;
    case 'warp': sfx.warp(); break;
    case 'drop': sfx.drop(); break;
    case 'go': sfx.go(); if (g) g.goUntil = now + 800; break;
    case 'sudden': sfx.alarm(); if (g) g.suddenUntil = now + 1800; break;
    case 'end': if (ev.w >= 0) sfx.win(); break;
  }
}

let hudEls = new Map();

function buildHud(roster, you) {
  const wrap = $('#hud-players');
  wrap.replaceChildren();
  hudEls = new Map();
  for (const r of roster) {
    const el = document.createElement('div');
    el.className = 'chip';
    el.style.setProperty('--pc', PALETTES[r.slot].glow);
    const text = document.createElement('div');
    text.className = 'chip-text';
    const name = document.createElement('div');
    name.className = 'chip-name';
    name.textContent = r.name + (r.slot === you ? ' (you)' : '');
    const wins = document.createElement('div');
    wins.className = 'chip-wins';
    const stats = document.createElement('div');
    stats.className = 'chip-stats';
    const stat = (kind) => {
      const s = document.createElement('span');
      s.append(itemIcon(kind), document.createElement('b'));
      stats.append(s);
      return s;
    };
    const parts = { bombs: stat(Sim.PU_BOMB), fire: stat(Sim.PU_FIRE), speed: stat(Sim.PU_SPEED), kick: stat(Sim.PU_KICK) };
    parts.kick.lastChild.remove();
    text.append(name, wins, stats);
    el.append(portrait(r.slot), text);
    wrap.append(el);
    hudEls.set(r.slot, { el, wins, ...parts, key: '' });
  }
}

function updateHud(view, g) {
  for (const p of view.players) {
    const h = hudEls.get(p.id);
    if (!h) continue;
    const key = [p.alive, p.wins, p.maxBombs, p.fire, p.speed, p.kick, app.settings.wins].join();
    if (key === h.key) continue;
    h.key = key;
    h.el.classList.toggle('dead', !p.alive);
    h.wins.innerHTML = Array.from({ length: app.settings.wins }, (_, i) => `<i class="${i < p.wins ? 'on' : ''}"></i>`).join('');
    h.bombs.lastChild.textContent = p.maxBombs;
    h.fire.lastChild.textContent = p.fire;
    h.speed.lastChild.textContent = Math.round((p.speed - Sim.BASE_SPEED) / Sim.SPEED_STEP) + 1;
    h.kick.hidden = !p.kick;
  }
  const tl = Math.ceil(view.timeLeft);
  const timer = $('#hud-timer');
  const text = view.sudden ? 'SUDDEN DEATH' : `${Math.floor(tl / 60)}:${String(tl % 60).padStart(2, '0')}`;
  if (timer.textContent !== text) timer.textContent = text;
  timer.classList.toggle('danger', view.sudden || (view.phase === 'play' && tl <= 10));
  const sub = `${Sim.STAGES[view.stage]?.name || ''} · Round ${view.round}`
    + (g.role === 'guest' && app.ping != null ? ` · ${Math.round(app.ping)} ms` : '');
  if ($('#hud-round').textContent !== sub) $('#hud-round').textContent = sub;
}

let overlayKey = '';

function rosterName(g, id) {
  return g.roster.find((r) => r.slot === id)?.name ?? '?';
}

function updateOverlay(view, g) {
  const now = performance.now();
  let key = '', html = '';
  if (view.phase === 'countdown') {
    const n = Math.max(1, Math.ceil(view.phaseT));
    key = `c${view.round}:${n}`;
    if (g.lastCount !== key) { g.lastCount = key; sfx.beep(); }
    const st = Sim.STAGES[view.stage];
    html = `<div class="big count">${n}</div><div class="sub">Round ${view.round} · ${esc(st?.name || '')}</div>`
      + (view.round === 1 || app.settings.stage !== Number(view.stage) ? `<div class="hint">${esc(st?.blurb || '')}</div>` : '');
  } else if (view.phase === 'play' && g.goUntil > now) {
    key = 'go';
    html = '<div class="big go">GO!</div>';
  } else if (view.phase === 'play' && g.suddenUntil > now) {
    key = 'sd';
    html = '<div class="big danger">SUDDEN DEATH</div><div class="sub">The walls are closing in</div>';
  } else if (view.phase === 'over') {
    const w = view.lastWinner;
    key = `o${view.round}:${w}`;
    html = w >= 0
      ? `<div class="big" style="--pc:${PALETTES[w].glow}">${esc(rosterName(g, w))}</div><div class="sub">wins round ${view.round}</div>`
      : `<div class="big">Draw!</div><div class="sub">Nobody survived round ${view.round}</div>`;
  } else if (view.phase === 'match') {
    key = `m${view.champion}`;
    const standings = [...view.players].sort((p, q) => q.wins - p.wins)
      .map((p) => `<li style="--pc:${PALETTES[p.id].glow}"><span>${esc(rosterName(g, p.id))}</span><b>${p.wins}</b></li>`).join('');
    const actions = g.role === 'guest'
      ? '<p class="muted">Waiting for the host to start a rematch…</p><button class="btn secondary" data-act="leave">Leave lobby</button>'
      : '<button class="btn" data-act="rematch">Rematch</button><button class="btn secondary" data-act="lobby">Back to lobby</button>';
    html = `<div class="card result"><div class="eyebrow">Match over</div>
      <h2 style="--pc:${PALETTES[view.champion].glow}">${esc(rosterName(g, view.champion))} wins!</h2>
      <ol class="standings">${standings}</ol><div class="actions">${actions}</div></div>`;
  }
  if (key !== overlayKey) {
    overlayKey = key;
    $('#overlay').innerHTML = html;
  }
}

function labelsFor(view, g) {
  if (view.phase !== 'countdown' && g.goUntil < performance.now()) return null;
  const out = {};
  for (const r of g.roster) out[r.slot] = r.name;
  return out;
}

function initGameUi() {
  $('#overlay').addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'rematch') startMatch();
    else if (act === 'lobby') backToLobby();
    else if (act === 'leave') leaveLobby();
  });
  $('#btn-menu').onclick = () => togglePause();
  $('#btn-resume').onclick = () => togglePause(false);
  $('#btn-quit').onclick = () => {
    if (app.mode === 'guest') leaveLobby();
    else backToLobby();
  };
  $('#btn-mute').onclick = () => toggleMute();
  syncMute();
  addEventListener('keydown', (e) => {
    if (e.target.closest?.('input, textarea, select')) return;
    if (e.code === 'Escape' && app.game) togglePause();
    if (e.code === 'KeyM') toggleMute();
  });
}

function togglePause(open = $('#pause').hidden) {
  const g = app.game;
  if (!g) return;
  $('#pause').hidden = !open;
  $('#pause-title').textContent = g.role === 'offline' ? 'Paused' : 'Menu';
  $('#pause-note').textContent = g.role === 'offline' ? '' : 'Online matches keep running while this menu is open.';
  $('#btn-quit').textContent = g.role === 'guest' ? 'Leave lobby' : g.role === 'host' ? 'End match for everyone' : 'Quit to lobby';
  if (g.role === 'offline') g.paused = open;
}

function toggleMute() {
  setMuted(!isMuted());
  syncMute();
}

function syncMute() {
  $('#btn-mute').classList.toggle('muted', isMuted());
  $('#btn-mute').setAttribute('aria-label', isMuted() ? 'Unmute sound' : 'Mute sound');
}

// ---------------------------------------------------------------- attract mode (bots behind the menus)

function attractTick() {
  if (!app.attract || app.attract.s.phase === 'match') {
    const roster = [0, 1, 2, 3].map((i) => ({ slot: i, name: BOT_NAMES[i] }));
    const s = Sim.createMatch(roster, { wins: 99, time: 70, stage: 'rotate' }, (Math.random() * 2 ** 32) >>> 0);
    s.phaseT = 0.5;
    app.attract = { s, bots: ['hard', 'normal', 'normal', 'easy'].map(createBot) };
  }
  const { s, bots } = app.attract;
  for (const p of s.players) botUpdate(s, p, bots[p.id], Sim.TICK);
  Sim.tick(s);
  for (const ev of s.events) renderer.event(ev);
  s.events.length = 0;
}

// ---------------------------------------------------------------- loop

const interp = (s, a) => s.players.map((p) => ({ ...p, x: p.px + (p.x - p.px) * a, y: p.py + (p.y - p.py) * a }));

let last = performance.now(), acc = 0, lastBeat = 0;

function pump(now, draw) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  acc += dt;
  let steps = 0;
  while (acc >= Sim.TICK && steps < 8) {
    acc -= Sim.TICK;
    steps++;
    const g = app.game;
    if (!g || (g.role === 'guest' && !g.got)) attractTick();
    if (g?.role === 'guest') guestTick(g);
    else if (g && !g.paused) hostTick(g);
  }
  if (steps === 8) acc = 0;
  if (now - lastBeat > 1000) { lastBeat = now; heartbeat(now); }
  if (draw) render(dt, acc / Sim.TICK, now);
}

function render(dt, alpha, now) {
  const g = app.game;
  if (!g || (g.role === 'guest' && !g.got)) {
    if (app.attract) renderer.draw(app.attract.s, interp(app.attract.s, alpha), { dt });
    return;
  }
  const view = g.role === 'guest' ? g.view : g.s;
  const players = g.role === 'guest' ? guestPlayers(g, now, dt) : interp(view, alpha);
  renderer.draw(view, players, { dt, labels: labelsFor(view, g) });
  updateHud(view, g);
  updateOverlay(view, g);
}

function heartbeat(now) {
  if (app.mode === 'guest' && app.net) {
    app.net.send({ t: 'ping', c: now });
    if (app.lastHeard && now - app.lastHeard > PEER_TIMEOUT) lostHost('Lost the connection to the host.');
  } else if (app.mode === 'host') {
    for (const [peer, seen] of app.peers) if (now - seen > PEER_TIMEOUT) dropPeer(peer);
  }
}

function frame(now) {
  pump(now, true);
  requestAnimationFrame(frame);
}

// Browsers pause requestAnimationFrame in background tabs. A worker timer keeps the
// simulation (and the host's snapshots) running so an online match doesn't freeze.
const ticker = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 20)'], { type: 'text/javascript' })));
ticker.onmessage = () => { if (document.hidden) pump(performance.now(), false); };

addEventListener('pointerdown', unlock);
addEventListener('keydown', unlock);
addEventListener('pagehide', () => { if (app.mode === 'guest') app.net?.send({ t: 'bye' }); });

initTitle();
initLobby();
initGameUi();
showScreen('title');
requestAnimationFrame(frame);
