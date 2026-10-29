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
    return { dx, dy, bomb: this.bomb[who] };
  }
}
