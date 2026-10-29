// Online play over WebRTC data channels. The free PeerJS broker only introduces the two
// browsers; once connected, game traffic flows directly between them (or via PeerJS's TURN relay).
const PREFIX = 'ember-arena-v1-';
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 5;

export const makeCode = () => Array.from({ length: CODE_LEN }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');

export function parseCode(text) {
  let v = String(text || '').trim();
  const m = v.match(/[?&]join=([^&#\s]+)/i);
  if (m) v = m[1];
  v = v.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return v.length === CODE_LEN ? v : null;
}

export const netAvailable = () => typeof window.Peer === 'function';

export class HostNet {
  constructor({ onData, onLeave, onError }) {
    this.h = { onData, onLeave, onError };
    this.conns = new Map();
    this.peer = null;
    this.code = null;
  }

  open() {
    return new Promise((resolve, reject) => {
      const attempt = (n) => {
        const code = makeCode();
        const peer = new window.Peer(PREFIX + code, { debug: 1 });
        peer.on('open', () => { this.peer = peer; this.code = code; resolve(code); });
        peer.on('connection', (conn) => this.accept(conn));
        peer.on('disconnected', () => { if (!peer.destroyed && this.peer === peer) setTimeout(() => !peer.destroyed && peer.reconnect(), 1500); });
        peer.on('error', (err) => {
          if (this.peer === peer) { this.h.onError?.(err); return; }
          peer.destroy();
          if (err.type === 'unavailable-id' && n < 4) attempt(n + 1);
          else reject(err);
        });
      };
      attempt(0);
    });
  }

  accept(conn) {
    conn.on('open', () => this.conns.set(conn.peer, conn));
    conn.on('data', (m) => this.h.onData(conn.peer, m));
    conn.on('close', () => { if (this.conns.get(conn.peer) === conn) { this.conns.delete(conn.peer); this.h.onLeave(conn.peer); } });
    conn.on('error', () => conn.close());
  }

  ids() {
    return [...this.conns.keys()];
  }

  send(id, m) {
    const c = this.conns.get(id);
    if (c?.open) c.send(m);
  }

  broadcast(m) {
    for (const c of this.conns.values()) if (c.open) c.send(m);
  }

  drop(id) {
    const c = this.conns.get(id);
    this.conns.delete(id);
    c?.close();
  }

  close() {
    this.peer?.destroy();
    this.peer = null;
    this.conns.clear();
  }
}

export class GuestNet {
  constructor({ onData, onClose }) {
    this.h = { onData, onClose };
    this.peer = null;
    this.conn = null;
  }

  join(code) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (settled) { this.h.onClose?.(err); return; }
        settled = true;
        this.close();
        reject(err);
      };
      const timer = setTimeout(() => fail({ type: 'timeout' }), 15000);
      const peer = new window.Peer({ debug: 1 });
      this.peer = peer;
      peer.on('error', fail);
      peer.on('open', () => {
        const conn = peer.connect(PREFIX + code, { reliable: true, serialization: 'json' });
        conn.on('open', () => { settled = true; clearTimeout(timer); this.conn = conn; resolve(); });
        conn.on('data', (m) => this.h.onData(m));
        conn.on('close', () => fail({ type: 'closed' }));
        conn.on('error', fail);
      });
    });
  }

  send(m) {
    if (this.conn?.open) this.conn.send(m);
  }

  close() {
    const p = this.peer;
    this.peer = null;
    this.conn = null;
    p?.destroy();
  }
}
