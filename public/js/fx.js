// Little moments of motion: confetti shapes, count-ups, ripples, card tilt.
// Everything checks prefers-reduced-motion and cleans up after itself.

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const canHover = () => matchMedia('(hover: hover) and (pointer: fine)').matches;
const COLORS = ['#FFF8CA', '#8A1517', '#CDE3E8', '#EE5A1E'];

// Shapes as tiny SVGs: circle, star, squiggle, triangle.
const SHAPES = [
  (c) => `<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" fill="${c}"/></svg>`,
  (c) => `<svg viewBox="0 0 20 20"><path d="M10 1l2.6 6.1 6.4.5-4.9 4.2 1.5 6.4L10 15l-5.6 3.2 1.5-6.4L1 7.6l6.4-.5z" fill="${c}"/></svg>`,
  (c) => `<svg viewBox="0 0 30 12"><path d="M2 8c4-8 6 6 10-2s6 6 10-2 4 2 6 2" fill="none" stroke="${c}" stroke-width="3" stroke-linecap="round"/></svg>`,
  (c) => `<svg viewBox="0 0 20 20"><path d="M10 2l8 15H2z" fill="${c}"/></svg>`,
];
const pick = (list) => list[Math.floor(Math.random() * list.length)];

// A burst of shapes from a point on the screen.
export function confetti(x, y, count = 24, spread = 1) {
  if (reduced()) return;
  for (let i = 0; i < count; i++) {
    const el = document.createElement('span');
    el.className = 'confetti';
    el.innerHTML = pick(SHAPES)(pick(COLORS));
    const size = 10 + Math.random() * 14;
    el.style.cssText = `left:${x}px;top:${y}px;width:${size}px;height:${size}px`;
    document.body.append(el);
    const angle = Math.random() * Math.PI * 2;
    const dist = (60 + Math.random() * 140) * spread;
    const dx = Math.cos(angle) * dist;
    const dy = Math.sin(angle) * dist - 60 * spread;
    const spin = (Math.random() - 0.5) * 720;
    el.animate([
      { transform: 'translate(-50%, -50%) scale(0.2) rotate(0deg)', opacity: 1 },
      { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(1) rotate(${spin / 2}deg)`, opacity: 1, offset: 0.55 },
      { transform: `translate(calc(-50% + ${dx * 1.15}px), calc(-50% + ${dy + 120}px)) scale(0.8) rotate(${spin}deg)`, opacity: 0 },
    ], { duration: 900 + Math.random() * 500, easing: 'cubic-bezier(.2,.7,.3,1)' }).onfinish = () => el.remove();
  }
}

export function confettiFrom(el, count, spread) {
  if (!el) return;
  const r = el.getBoundingClientRect();
  confetti(r.left + r.width / 2, r.top + r.height / 2, count, spread);
}

// Count a number up from 0 (or a start value) to its final value.
export function countUp(el, to, from = 0, duration = 900) {
  if (!el) return;
  const textNode = el.firstChild;
  if (reduced()) { textNode.nodeValue = String(to); return; }
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    textNode.nodeValue = String(Math.round(from + (to - from) * eased));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// Ripple on every button press.
document.addEventListener('pointerdown', (e) => {
  const btn = e.target.closest('.btn, .chip, .seg button, .format-opts button');
  if (!btn || reduced()) return;
  const r = btn.getBoundingClientRect();
  const dot = document.createElement('span');
  dot.className = 'ripple';
  const size = Math.max(r.width, r.height) * 2;
  dot.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
  btn.append(dot);
  dot.animate([{ transform: 'scale(0)', opacity: 0.45 }, { transform: 'scale(1)', opacity: 0 }], { duration: 550, easing: 'ease-out' }).onfinish = () => dot.remove();
});

// Player cards tilt toward the cursor on devices with a mouse.
document.addEventListener('pointermove', (e) => {
  if (!canHover() || reduced()) return;
  const card = e.target.closest('.ticket');
  document.querySelectorAll('.ticket.tilting').forEach((c) => {
    if (c !== card) { c.classList.remove('tilting'); c.style.removeProperty('--rx'); c.style.removeProperty('--ry'); }
  });
  if (!card) return;
  const r = card.getBoundingClientRect();
  const px = (e.clientX - r.left) / r.width - 0.5;
  const py = (e.clientY - r.top) / r.height - 0.5;
  card.classList.add('tilting');
  card.style.setProperty('--rx', `${(-py * 10).toFixed(2)}deg`);
  card.style.setProperty('--ry', `${(px * 12).toFixed(2)}deg`);
});

// Floating shapes around the home logo; they scatter when the pointer comes near.
export function heroShapes() {
  const shapes = [
    [0, '#CDE3E8', '8%', '78%', 26], [1, '#FFF8CA', '86%', '70%', 30], [3, '#8A1517', '64%', '6%', 22],
    [1, '#EE5A1E', '4%', '10%', 18], [0, '#8A1517', '92%', '20%', 16], [2, '#CDE3E8', '40%', '92%', 40],
  ];
  return shapes.map(([shape, color, left, top, size], i) => `
    <span class="float-shape" style="left:${left};top:${top};width:${size}px;height:${size}px;--i:${i}" aria-hidden="true">${SHAPES[shape](color)}</span>`).join('');
}

document.addEventListener('pointerover', (e) => {
  const s = e.target.closest('.float-shape');
  if (!s || reduced()) return;
  const dx = (Math.random() - 0.5) * 120, dy = (Math.random() - 0.5) * 120;
  s.animate([{ translate: '0 0', rotate: '0deg' }, { translate: `${dx}px ${dy}px`, rotate: `${(Math.random() - 0.5) * 360}deg` }, { translate: '0 0', rotate: '0deg' }],
    { duration: 1100, easing: 'cubic-bezier(.3,1.5,.5,1)' });
});
