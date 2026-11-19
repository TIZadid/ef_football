// Group-chat exports: a plain-text line-up and a poster-style PNG.

const COLORS = {
  turf1: '#0b2213', turf2: '#0f2d19', lime: '#c8f53a', orange: '#ff5b1f', paper: '#eceadf', ink: '#0a0d0b',
};
const DOTS = ['🟢', '🟠'];

// Keeper first, then the other starters.
const starting = (u) => (u.keeper ? [u.keeper, ...u.starters.filter((p) => p !== u.keeper)] : u.starters);

export function shareText({ lineups, names, balance, date, format }) {
  const lines = [`⚽ GAME ON · ${date} · ${format}-a-side`, ''];
  lineups.forEach((u, t) => {
    lines.push(`${DOTS[t]} TEAM ${names[t].toUpperCase()}`);
    starting(u).forEach((p) => lines.push(`${p === u.keeper ? '🧤' : '•'} ${p.name}`));
    if (u.subs.length) lines.push(`🔁 Subs: ${u.subs.map((p) => p.name).join(', ')}`);
    lines.push('');
  });
  lines.push(`⚖️ ${balance}% balanced`);
  return lines.join('\n');
}

function fit(ctx, text, max) {
  if (ctx.measureText(text).width <= max) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > max) s = s.slice(0, -1);
  return `${s}…`;
}

function slant(ctx, x, y, w, hgt, cut, color, flip = false) {
  ctx.fillStyle = color;
  ctx.beginPath();
  if (flip) {
    ctx.moveTo(x, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + hgt); ctx.lineTo(x + cut, y + hgt);
  } else {
    ctx.moveTo(x, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w - cut, y + hgt); ctx.lineTo(x, y + hgt);
  }
  ctx.closePath();
  ctx.fill();
}

export async function renderShareImage({ lineups, names, balance, date, format }) {
  const teams = lineups.map((u) => [...starting(u), ...u.subs]);
  const keepers = lineups.map((u) => u.keeper);
  await Promise.all([
    document.fonts.load('160px Anton'),
    document.fonts.load('700 24px "Space Mono"'),
  ]).catch(() => {});

  const W = 1080;
  const ROW = 78;
  const rows = Math.max(...teams.map((t) => t.length));
  const hasSubs = lineups.some((u) => u.subs.length);
  const H = Math.max(1350, 560 + rows * ROW + (hasSubs ? 60 : 0) + 230);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Mown stripes, vignette, pitch markings.
  for (let x = 0; x < W; x += 180) {
    ctx.fillStyle = COLORS.turf1; ctx.fillRect(x, 0, 90, H);
    ctx.fillStyle = COLORS.turf2; ctx.fillRect(x + 90, 0, 90, H);
  }
  const v = ctx.createRadialGradient(W / 2, H * 0.35, 200, W / 2, H / 2, H * 0.8);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,0.6)');
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(236,234,223,0.08)';
  ctx.lineWidth = 4;
  ctx.beginPath(); ctx.arc(W / 2, H * 0.62, 260, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, H * 0.62); ctx.lineTo(W, H * 0.62); ctx.stroke();

  // Header.
  ctx.fillStyle = COLORS.paper;
  ctx.font = '700 26px "Space Mono", monospace';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(`${date}  ·  ${format}-A-SIDE`, 64, 96);
  ctx.textAlign = 'right';
  ctx.fillStyle = COLORS.lime;
  ctx.fillText('● MATCHDAY', W - 64, 96);
  ctx.textAlign = 'left';

  ctx.font = '210px Anton, Impact, sans-serif';
  ctx.fillStyle = COLORS.paper;
  ctx.fillText('GAME ON', 56, 320);
  const w = ctx.measureText('GAME ON').width;
  ctx.fillStyle = COLORS.lime;
  ctx.fillText('.', 56 + w, 320);

  // Teams.
  const colW = (W - 64 * 2 - 24) / 2;
  teams.forEach((team, t) => {
    const x = 64 + t * (colW + 24);
    const color = t ? COLORS.orange : COLORS.lime;
    slant(ctx, x, 380, colW, 120, 26, color, t === 1);
    ctx.fillStyle = COLORS.ink;
    ctx.font = '700 20px "Space Mono", monospace';
    ctx.textAlign = t ? 'right' : 'left';
    const tx = t ? x + colW - 24 : x + 24;
    ctx.fillText(`${lineups[t].starters.length} START${lineups[t].subs.length ? ` · ${lineups[t].subs.length} SUBS` : ''}`, tx, 418);
    ctx.font = '72px Anton, Impact, sans-serif';
    ctx.fillText(names[t].toUpperCase(), tx, 486);

    const nStart = lineups[t].starters.length;
    if (lineups[t].subs.length) {
      ctx.font = '700 22px "Space Mono", monospace';
      ctx.fillStyle = color;
      ctx.fillText('SUBS', t ? x + colW - 8 : x + 8, 528 + nStart * ROW + 34);
    }
    team.forEach((p, i) => {
      const sub = i >= nStart;
      const y = 528 + i * ROW + (sub ? 60 : 0);
      ctx.fillStyle = sub ? 'rgba(6,14,9,0.45)' : 'rgba(6,14,9,0.72)';
      ctx.fillRect(x, y, colW, ROW - 12);
      ctx.fillStyle = color;
      ctx.fillRect(t ? x + colW - 8 : x, y, 8, ROW - 12);
      const isKeeper = p === keepers[t];
      ctx.font = '42px Anton, Impact, sans-serif';
      ctx.fillStyle = sub ? 'rgba(236,234,223,0.7)' : COLORS.paper;
      const label = `${isKeeper ? '🧤 ' : ''}${p.name.toUpperCase()}`;
      ctx.fillText(fit(ctx, label, colW - 120), t ? x + colW - 28 : x + 28, y + 50);
      const tag = isKeeper ? 'GK' : sub ? '' : (p.def === 3 || p.pos === 'CB' || p.alt === 'CB') ? 'CB' : '';
      if (tag) {
        ctx.font = '700 20px "Space Mono", monospace';
        const tw = ctx.measureText(tag).width + 16;
        const bx = t ? x + 20 : x + colW - 20 - tw;
        ctx.fillStyle = isKeeper ? COLORS.lime : COLORS.paper;
        ctx.fillRect(bx, y + 20, tw, 30);
        ctx.fillStyle = COLORS.ink;
        ctx.textAlign = 'left';
        ctx.fillText(tag, bx + 8, y + 42);
        ctx.textAlign = t ? 'right' : 'left';
      }
    });
  });
  ctx.textAlign = 'left';

  // VS stamp.
  ctx.save();
  ctx.translate(W / 2, 440);
  ctx.rotate(-0.14);
  ctx.fillStyle = COLORS.ink;
  ctx.fillRect(-58, -40, 116, 80);
  ctx.strokeStyle = COLORS.paper;
  ctx.lineWidth = 4;
  ctx.strokeRect(-58, -40, 116, 80);
  ctx.fillStyle = COLORS.paper;
  ctx.font = '56px Anton, Impact, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('VS', 0, 22);
  ctx.restore();

  // Footer: balance + barcode.
  const fy = H - 120;
  ctx.fillStyle = COLORS.paper;
  ctx.fillRect(0, fy - 40, W, 160);
  ctx.fillStyle = COLORS.ink;
  ctx.font = '96px Anton, Impact, sans-serif';
  ctx.fillText(`${balance}%`, 64, fy + 62);
  const bw = ctx.measureText(`${balance}%`).width;
  ctx.font = '700 24px "Space Mono", monospace';
  ctx.fillText('BALANCED', 64 + bw + 20, fy + 58);
  let bx = W - 64 - 260;
  const pattern = [3, 1, 2, 1, 4, 2, 1, 3, 1, 1, 2, 4, 1, 2, 3, 1, 2, 1, 1, 3, 2, 1, 4, 1, 2];
  pattern.forEach((pw, i) => {
    if (i % 2 === 0) ctx.fillRect(bx, fy - 4, pw * 4, 80);
    bx += pw * 4 + 2;
  });

  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}
