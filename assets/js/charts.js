// Gráficos SVG leves (sem dependências).
import { esc } from './utils.js';

const niceMax = (v) => {
  if (v <= 0) return 10;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
};

// Barras empilhadas. series: [{ name, color, values[] }], tips[i] = html do tooltip da coluna i
export function stackedBars({ labels, series, tips = [], height = 220, width = 640, fmtAxis = (v) => v, everyLabel = 1 }) {
  const W = Math.max(300, Math.round(width));
  const H = height;
  const pad = { l: 46, r: 8, t: 10, b: 26 };
  const totals = labels.map((_, i) => series.reduce((s, se) => s + Math.max(0, se.values[i] || 0), 0));
  const max = niceMax(Math.max(...totals, 0));
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const bw = iw / labels.length;
  const barW = Math.max(3, Math.min(28, bw * 0.62));
  const y = (v) => pad.t + ih - (v / max) * ih;

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => max * f);
  let out = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Gráfico de barras">`;
  out += `<g class="grid">${ticks.map((t) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}"/><text x="${pad.l - 8}" y="${y(t) + 4}" text-anchor="end">${esc(fmtAxis(t))}</text>`).join('')}</g>`;
  labels.forEach((lab, i) => {
    const cx = pad.l + bw * i + bw / 2;
    let acc = 0;
    let rects = '';
    series.forEach((se, si) => {
      const v = Math.max(0, se.values[i] || 0);
      if (!v) return;
      const y0 = y(acc);
      const y1 = y(acc + v);
      const isTop = series.slice(si + 1).every((s2) => !(s2.values[i] > 0));
      const r = isTop ? Math.min(5, barW / 2) : 0;
      const h = y0 - y1;
      rects += r
        ? `<path class="bar" style="fill:${se.color}" d="M${cx - barW / 2},${y0} V${y1 + r} Q${cx - barW / 2},${y1} ${cx - barW / 2 + r},${y1} H${cx + barW / 2 - r} Q${cx + barW / 2},${y1} ${cx + barW / 2},${y1 + r} V${y0} Z"/>`
        : `<rect class="bar" style="fill:${se.color}" x="${cx - barW / 2}" y="${y1}" width="${barW}" height="${h}"/>`;
      acc += v;
    });
    out += `<g class="col" data-tip="${esc(tips[i] || '')}"><rect x="${pad.l + bw * i}" y="${pad.t}" width="${bw}" height="${ih}" fill="transparent"/>${rects}</g>`;
    if (i % everyLabel === 0 || i === labels.length - 1) out += `<text x="${cx}" y="${H - 8}" text-anchor="middle">${esc(lab)}</text>`;
  });
  return out + '</svg>';
}

// Rosca. segs: [{ label, value, color }]
export function donut(segs, { size = 130, thickness = 22, center = '' } = {}) {
  const total = segs.reduce((s, x) => s + x.value, 0) || 1;
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  let off = 0;
  const gap = segs.filter((s) => s.value > 0).length > 1 ? 2 : 0;
  const arcs = segs.map((s) => {
    const len = (s.value / total) * c;
    const el = `<circle r="${r}" cx="${size / 2}" cy="${size / 2}" fill="none" stroke-width="${thickness}" style="stroke:${s.color}" stroke-dasharray="${Math.max(0, len - gap)} ${c}" stroke-dashoffset="${-off}" data-tip="${esc(`${s.label}: ${Math.round((s.value / total) * 100)}%`)}"/>`;
    off += len;
    return el;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${size} ${size}" role="img" aria-label="Gráfico de rosca"><g transform="rotate(-90 ${size / 2} ${size / 2})">${arcs}</g>
    <text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" style="font-family:var(--f-display);font-size:20px;font-weight:600;fill:var(--choc)">${esc(center)}</text></svg>`;
}

// Tooltip único compartilhado
let tip;
export function attachTips(root) {
  tip ||= Object.assign(document.createElement('div'), { className: 'chart-tip', hidden: true });
  if (!tip.isConnected) document.body.appendChild(tip);
  root.addEventListener('pointermove', (e) => {
    const t = e.target.closest('[data-tip]');
    if (!t || !t.dataset.tip) { tip.hidden = true; return; }
    tip.innerHTML = t.dataset.tip;
    tip.hidden = false;
    const x = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8);
    tip.style.left = `${x}px`;
    tip.style.top = `${e.clientY - tip.offsetHeight - 12}px`;
  });
  root.addEventListener('pointerleave', () => (tip.hidden = true));
}
