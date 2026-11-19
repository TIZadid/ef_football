// Group-chat exports: a plain-text line-up and a poster-style PNG.

const COLORS = {
  turf1: '#1A0806', lime: '#F58F1F', orange: '#457534', paper: '#FFF8CA', ink: '#161412',
};
const DOTS = ['⚫', '⚪'];

// Keeper first, then the other starters.
const starting = (u) => (u.keeper ? [u.keeper, ...u.starters.filter((p) => p !== u.keeper)] : u.starters);

const verdict = (balance) => (balance >= 96 ? 'DEAD EVEN!' : balance >= 90 ? 'VERY FAIR' : balance >= 80 ? 'FAIR' : 'LOPSIDED');

export function shareText({ lineups, names, balance, match, format }) {
  const lines = [`⚽ GAME ON · ${match} · ${format}-a-side`, ''];
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

export async function renderShareImage({ lineups, names, balance, match, format }) {
  const teams = lineups.map((u) => [...starting(u), ...u.subs]);
  const keepers = lineups.map((u) => u.keeper);
  await Promise.all([
    document.fonts.load('160px Anton'),
    document.fonts.load('150px "Bagel Fat One"'),
    document.fonts.load('84px "Dela Gothic One"'),
    document.fonts.load('40px "Bagel Fat One"'),
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

  // Plain background, no textures.
  ctx.fillStyle = COLORS.turf1;
  ctx.fillRect(0, 0, W, H);

  // Header.
  ctx.fillStyle = COLORS.paper;
  ctx.font = '700 26px "Space Mono", monospace';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(fit(ctx, match, W - 300), 64, 96);
  ctx.textAlign = 'right';
  ctx.fillStyle = COLORS.lime;
  ctx.fillText(`● ${format}-A-SIDE`, W - 64, 96);
  ctx.textAlign = 'left';

  ctx.font = '150px "Bagel Fat One", Anton, Impact, sans-serif';
  // Hard offset shadow, sticker style.
  ctx.fillStyle = COLORS.lime;
  ctx.fillText('GAME ON', 64, 316);
  ctx.fillStyle = COLORS.paper;
  ctx.fillText('GAME ON', 56, 308);
  const w = ctx.measureText('GAME ON').width;
  ctx.fillStyle = COLORS.orange;
  ctx.fillText('.', 56 + w, 308);

  // Teams.
  const colW = (W - 64 * 2 - 24) / 2;
  teams.forEach((team, t) => {
    const x = 64 + t * (colW + 24);
    // Black bib: charcoal panel with a light outline; white bib: paper.
    const color = t ? COLORS.paper : '#7d837e';
    slant(ctx, x, 380, colW, 120, 26, COLORS.paper, t === 1);
    if (!t) slant(ctx, x + 3, 383, colW - 6, 114, 24, '#0E0403', false);
    ctx.fillStyle = t ? COLORS.ink : COLORS.paper;
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
      ctx.fillStyle = sub ? 'rgba(42,17,13,0.6)' : '#2A110D';
      ctx.fillRect(x, y, colW, ROW - 12);
      ctx.fillStyle = color;
      ctx.fillRect(t ? x + colW - 8 : x, y, 8, ROW - 12);
      const isKeeper = p === keepers[t];
      ctx.font = '42px Anton, Impact, sans-serif';
      ctx.fillStyle = sub ? 'rgba(255,248,202,0.7)' : COLORS.paper;
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

  // Footer: balance + verdict sticker + barcode.
  const fy = H - 120;
  ctx.fillStyle = COLORS.paper;
  ctx.fillRect(0, fy - 40, W, 160);
  ctx.fillStyle = COLORS.ink;
  ctx.font = '84px "Dela Gothic One", Anton, Impact, sans-serif';
  const pct = `${balance}%`;
  ctx.fillText(pct, 64, fy + 64);
  const bw = ctx.measureText(pct).width;
  ctx.font = '700 22px "Space Mono", monospace';
  ctx.fillText('SQUAD', 64 + bw + 20, fy + 30);
  ctx.fillText('BALANCE', 64 + bw + 20, fy + 62);
  ctx.save();
  ctx.translate(W / 2 + 150, fy - 40);
  ctx.rotate(-0.12);
  ctx.font = '40px "Bagel Fat One", Anton, sans-serif';
  const label = verdict(balance);
  const lw = ctx.measureText(label).width + 36;
  ctx.fillStyle = COLORS.ink;
  ctx.fillRect(-lw / 2 + 6, -30, lw, 64);
  ctx.fillStyle = COLORS.lime;
  ctx.fillRect(-lw / 2, -36, lw, 64);
  ctx.fillStyle = COLORS.ink;
  ctx.textAlign = 'center';
  ctx.fillText(label, 0, 10);
  ctx.restore();
  let bx = W - 64 - 260;
  const pattern = [3, 1, 2, 1, 4, 2, 1, 3, 1, 1, 2, 4, 1, 2, 3, 1, 2, 1, 1, 3, 2, 1, 4, 1, 2];
  pattern.forEach((pw, i) => {
    if (i % 2 === 0) ctx.fillRect(bx, fy - 4, pw * 4, 80);
    bx += pw * 4 + 2;
  });

  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}
