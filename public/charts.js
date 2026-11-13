// Schlanke SVG-Diagramme ohne externe Bibliothek.
// Gestaltung: 2px-Linie mit leichter Fläche, Punkte mit Ring in Flächenfarbe,
// Säulen max. 24px breit mit 4px gerundeter Oberkante, dezente Hilfslinien,
// Details per Hover bzw. Antippen.

const NS = 'http://www.w3.org/2000/svg';
const MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const HEIGHT = 230;
const M = { top: 22, right: 16, bottom: 30, left: 52 };

const fmtAxis = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });
const fmtEur = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });

function el(name, attrs = {}, parent) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.append(node);
  return node;
}

/** Saubere Achsenschritte (1, 2, 2,5, 5 × 10ⁿ). */
function niceScale(max, count = 4) {
  const safeMax = max > 0 ? max : 1;
  const raw = safeMax / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((s) => s >= raw);
  const top = Math.ceil(safeMax / step - 1e-9) * step;
  const ticks = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(v);
  return { top, ticks };
}

function monthLabel(date, withYear) {
  const m = MONTHS[date.getMonth()];
  return withYear ? `${m} ${String(date.getFullYear()).slice(2)}` : m;
}

/** Gemeinsames Gerüst: SVG, Hilfslinien, y-Achse, Tooltip, Tabelle für Screenreader. */
function frame(container, maxValue, { label, table }) {
  container.innerHTML = '';
  container.classList.add('chart');
  const width = Math.max(container.clientWidth, 260);
  const svg = el('svg', { width, height: HEIGHT, viewBox: `0 0 ${width} ${HEIGHT}`, role: 'img', 'aria-label': label });
  container.append(svg);

  const plotW = width - M.left - M.right;
  const plotH = HEIGHT - M.top - M.bottom;
  const { top, ticks } = niceScale(maxValue);
  const y = (v) => M.top + (1 - v / top) * plotH;

  const grid = el('g', { class: 'grid' }, svg);
  for (const t of ticks) {
    el('line', { x1: M.left, x2: width - M.right, y1: y(t), y2: y(t) }, grid);
    const txt = el('text', { x: M.left - 10, y: y(t), 'text-anchor': 'end', 'dominant-baseline': 'middle', class: 'axis' }, grid);
    txt.textContent = `${fmtAxis.format(t)} €`;
  }

  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  container.append(tip);

  if (table) {
    const tbl = document.createElement('table');
    tbl.className = 'sr-only';
    tbl.innerHTML = `<caption>${label}</caption><thead><tr>${table.head.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
      <tbody>${table.rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>`;
    container.append(tbl);
  }

  function showTip(html, px, py) {
    tip.innerHTML = html;
    tip.hidden = false;
    const tw = tip.offsetWidth;
    const left = Math.min(Math.max(px - tw / 2, 4), width - tw - 4);
    const above = py - tip.offsetHeight - 12;
    tip.style.left = `${left}px`;
    tip.style.top = `${above < 0 ? py + 16 : above}px`;
  }
  const hideTip = () => (tip.hidden = true);

  return { svg, width, plotW, plotH, y, top, showTip, hideTip };
}

const outsideListeners = new WeakMap();

/** Pointer-Handling, das mit Maus (Hover) und Touch (Antippen) funktioniert. */
function bindPointer(target, container, { onMove, onLeave }) {
  const local = (e) => {
    const r = target.ownerSVGElement ? target.ownerSVGElement.getBoundingClientRect() : target.getBoundingClientRect();
    return e.clientX - r.left;
  };
  target.addEventListener('pointermove', (e) => onMove(local(e)));
  target.addEventListener('pointerdown', (e) => onMove(local(e)));
  target.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse') onLeave();
  });
  // Touch: Tippen außerhalb schließt den Tooltip. Alter Listener wird beim Neuzeichnen entfernt.
  outsideListeners.get(container)?.abort();
  const ac = new AbortController();
  outsideListeners.set(container, ac);
  document.addEventListener('pointerdown', (e) => {
    if (!container.isConnected) return ac.abort();
    if (!container.contains(e.target)) onLeave();
  }, { signal: ac.signal });
}

/**
 * Liniendiagramm über eine echte Zeitachse.
 * points: [{ t: Date, value: Number, tip: HTML }]
 */
export function lineChart(container, points, { start, end, label, table }) {
  const draw = () => {
    const max = Math.max(...points.map((p) => p.value), 0);
    const f = frame(container, max, { label, table });
    const { svg, width, plotW, y } = f;
    const t0 = start.getTime();
    const span = Math.max(end.getTime() - t0, 1);
    const x = (d) => M.left + ((d.getTime() - t0) / span) * plotW;

    // Monatsbeschriftung: mittig im jeweiligen Monat, ausgedünnt nach verfügbarer Breite.
    const months = [];
    for (let d = new Date(start.getFullYear(), start.getMonth(), 1); d <= end; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) months.push(d);
    const step = [1, 2, 3, 6].find((s) => (plotW / months.length) * s >= 40) ?? 12;
    const multiYear = start.getFullYear() !== end.getFullYear();
    const axis = el('g', {}, svg);
    months.forEach((d, i) => {
      if (i % step) return;
      const next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
      const mid = (Math.max(x(d), M.left) + Math.min(x(next), width - M.right)) / 2;
      const txt = el('text', { x: mid, y: HEIGHT - 8, 'text-anchor': 'middle', class: 'axis' }, axis);
      txt.textContent = monthLabel(d, multiYear && (d.getMonth() === 0 || i === 0));
    });

    const pts = [...points].sort((a, b) => a.t - b.t).map((p) => ({ ...p, px: x(p.t), py: y(p.value) }));
    if (!pts.length) return;

    const base = y(0);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p.px.toFixed(1)},${p.py.toFixed(1)}`).join('');
    if (pts.length > 1) {
      el('path', { d: `${line}L${pts.at(-1).px.toFixed(1)},${base}L${pts[0].px.toFixed(1)},${base}Z`, class: 'area' }, svg);
      el('path', { d: line, class: 'line' }, svg);
    }

    const cross = el('line', { y1: M.top, y2: base, class: 'crosshair', visibility: 'hidden' }, svg);
    const dots = pts.map((p) => el('circle', { cx: p.px, cy: p.py, r: 4, class: 'dot' }, svg));

    // Wert am letzten Punkt – einzige direkte Beschriftung.
    const last = pts.at(-1);
    const endLabel = el('text', {
      x: last.px, y: last.py - 12, class: 'value-label',
      'text-anchor': last.px > width - 50 ? 'end' : last.px < M.left + 40 ? 'start' : 'middle',
    }, svg);
    endLabel.textContent = fmtEur.format(last.value);

    const hit = el('rect', { x: M.left - 8, y: 0, width: plotW + 16, height: HEIGHT, class: 'hit' }, svg);
    let active = -1;
    bindPointer(hit, container, {
      onMove: (mx) => {
        let best = 0;
        pts.forEach((p, i) => { if (Math.abs(p.px - mx) < Math.abs(pts[best].px - mx)) best = i; });
        if (best !== active) {
          dots[active]?.setAttribute('r', 4);
          active = best;
          dots[best].setAttribute('r', 6);
        }
        const p = pts[best];
        cross.setAttribute('x1', p.px);
        cross.setAttribute('x2', p.px);
        cross.setAttribute('visibility', 'visible');
        endLabel.setAttribute('visibility', best === pts.length - 1 ? 'hidden' : 'visible');
        f.showTip(p.tip, p.px, p.py);
      },
      onLeave: () => {
        dots[active]?.setAttribute('r', 4);
        active = -1;
        cross.setAttribute('visibility', 'hidden');
        endLabel.setAttribute('visibility', 'visible');
        f.hideTip();
      },
    });
  };
  observe(container, draw);
}

/**
 * Säulendiagramm mit einer Säule pro Monat.
 * bars: [{ date: Date (Monatserster), value: Number, tip: HTML }]
 */
export function barChart(container, bars, { label, table }) {
  const draw = () => {
    const max = Math.max(...bars.map((b) => b.value), 0);
    const f = frame(container, max, { label, table });
    const { svg, plotW, y } = f;
    const band = plotW / bars.length;
    const barW = Math.min(24, band * 0.6);
    const base = y(0);
    const step = [1, 2, 3, 6].find((s) => band * s >= 40) ?? 12;
    const multiYear = bars.length && bars[0].date.getFullYear() !== bars.at(-1).date.getFullYear();
    const maxIdx = bars.reduce((best, b, i) => (b.value > bars[best].value ? i : best), 0);

    const rects = bars.map((b, i) => {
      const cx = M.left + band * (i + 0.5);
      if (i % step === 0) {
        const txt = el('text', { x: cx, y: HEIGHT - 8, 'text-anchor': 'middle', class: 'axis' }, svg);
        txt.textContent = monthLabel(b.date, multiYear && (b.date.getMonth() === 0 || i === 0));
      }
      if (!(b.value > 0)) return null;
      const top = y(b.value);
      const h = base - top;
      const r = Math.min(4, h, barW / 2);
      const x0 = cx - barW / 2;
      const d = `M${x0},${base}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x0 + barW - r}Q${x0 + barW},${top} ${x0 + barW},${top + r}V${base}Z`;
      return el('path', { d, class: 'bar' }, svg);
    });

    // Direkte Beschriftung nur für den teuersten Monat.
    if (bars[maxIdx]?.value > 0) {
      const lbl = el('text', { x: M.left + band * (maxIdx + 0.5), y: y(bars[maxIdx].value) - 8, 'text-anchor': 'middle', class: 'value-label' }, svg);
      lbl.textContent = fmtEur.format(bars[maxIdx].value);
    }

    const hit = el('rect', { x: M.left, y: 0, width: plotW, height: HEIGHT, class: 'hit' }, svg);
    let active = -1;
    const setActive = (i) => {
      if (i === active) return;
      active = i;
      rects.forEach((r, j) => r?.classList.toggle('dim', i >= 0 && j !== i));
    };
    bindPointer(hit, container, {
      onMove: (mx) => {
        const i = Math.min(bars.length - 1, Math.max(0, Math.floor((mx - M.left) / band)));
        setActive(i);
        const b = bars[i];
        // Etwas Abstand nach oben, damit die Wertbeschriftung über der Säule frei bleibt.
        f.showTip(b.tip, M.left + band * (i + 0.5), (b.value > 0 ? y(b.value) : base) - 18);
      },
      onLeave: () => {
        setActive(-1);
        f.hideTip();
      },
    });
  };
  observe(container, draw);
}

// Bei Größenänderung (Drehen des iPads, Split View) neu zeichnen.
const observers = new WeakMap();
function observe(container, draw) {
  observers.get(container)?.disconnect();
  let lastWidth = 0;
  const ro = new ResizeObserver(() => {
    const w = container.clientWidth;
    if (Math.abs(w - lastWidth) < 2) return;
    lastWidth = w;
    draw();
  });
  ro.observe(container);
  observers.set(container, ro);
  lastWidth = container.clientWidth;
  draw();
}
