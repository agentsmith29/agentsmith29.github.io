// Keyboard input for up to two players on one keyboard. The most recently pressed
// direction wins, so rolling from one key to the next feels responsive.
const MOVES = {
  KeyW: ['p1', 0, -1], KeyS: ['p1', 0, 1], KeyA: ['p1', -1, 0], KeyD: ['p1', 1, 0],
  ArrowUp: ['p2', 0, -1], ArrowDown: ['p2', 0, 1], ArrowLeft: ['p2', -1, 0], ArrowRight: ['p2', 1, 0],
};
const BOMBS = { Space: 'p1', Enter: 'p2', NumpadEnter: 'p2', ShiftRight: 'p2' };

export class Keyboard {
  constructor() {
    this.held = [];
    this.bomb = { p1: 0, p2: 0 };
    this.solo = true;       // with no second local player, the arrows and Enter also drive player 1
    this.active = false;    // only swallow keys (no page scrolling) while a match is on screen
    this.touch = { dx: 0, dy: 0 };   // on-screen stick, always player 1
    addEventListener('keydown', (e) => this.down(e));
    addEventListener('keyup', (e) => { this.held = this.held.filter((c) => c !== e.code); });
    addEventListener('blur', () => { this.held = []; });
  }

  owner(scheme) {
    return this.solo ? 'p1' : scheme;
  }

  down(e) {
    if (e.target.closest?.('input, textarea, select')) return;
    const move = MOVES[e.code], bomb = BOMBS[e.code];
    if (!move && !bomb) return;
    if (this.active) e.preventDefault();
    if (e.repeat) return;
    if (move && !this.held.includes(e.code)) this.held.push(e.code);
    if (bomb && this.active) this.bomb[this.owner(bomb)]++;
  }

  state(who) {
    let dx = 0, dy = 0;
    for (let i = this.held.length - 1; i >= 0; i--) {
      const m = MOVES[this.held[i]];
      if (m && this.owner(m[0]) === who) { dx = m[1]; dy = m[2]; break; }
    }
    if (!dx && !dy && who === 'p1') ({ dx, dy } = this.touch);
    return { dx, dy, bomb: this.bomb[who] };
  }

  // A virtual stick (direction from the touch point to the pad centre, strongest axis wins)
  // and a bomb button, for phones and tablets.
  bindTouch(pad, knob, bombBtn) {
    let id = null;
    const aim = (e) => {
      const r = pad.getBoundingClientRect();
      const x = e.clientX - (r.left + r.width / 2), y = e.clientY - (r.top + r.height / 2);
      const dead = r.width * 0.12, max = r.width * 0.32;
      const len = Math.hypot(x, y) || 1, k = Math.min(1, max / len);
      knob.style.transform = `translate(${x * k}px, ${y * k}px)`;
      if (len < dead) this.touch = { dx: 0, dy: 0 };
      else if (Math.abs(x) > Math.abs(y)) this.touch = { dx: Math.sign(x), dy: 0 };
      else this.touch = { dx: 0, dy: Math.sign(y) };
    };
    const release = (e) => {
      if (e.pointerId !== id) return;
      id = null;
      this.touch = { dx: 0, dy: 0 };
      knob.style.transform = '';
    };
    pad.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      id = e.pointerId;
      pad.setPointerCapture(id);
      aim(e);
    });
    pad.addEventListener('pointermove', (e) => { if (e.pointerId === id) aim(e); });
    pad.addEventListener('pointerup', release);
    pad.addEventListener('pointercancel', release);
    bombBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (this.active) this.bomb.p1++;
      bombBtn.classList.add('down');
    });
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) bombBtn.addEventListener(ev, () => bombBtn.classList.remove('down'));
  }
}
