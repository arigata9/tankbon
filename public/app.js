// ---------- Hilfsfunktionen ----------
const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const fmtEur = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const fmtNum = (d) => new Intl.NumberFormat('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });
const eur = (v) => (v == null ? '–' : fmtEur.format(v));
const liters = (v) => (v == null ? '–' : `${fmtNum(2).format(v)} l`);
const ppl = (v) => (v == null ? '–' : `${fmtNum(3).format(v)} €/l`);
const dateDe = (iso) => (iso ? new Date(`${iso}T12:00:00`).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '–');
// Zahl für Eingabefelder: deutsches Komma, ohne Tausenderpunkt
const inputNum = (v, d) => (v == null ? '' : Number(v).toFixed(d).replace('.', ','));
const parseNum = (s) => {
  const t = String(s ?? '').trim().replace(/\s/g, '').replace(',', '.');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
};

const icons = {
  scan: '<svg viewBox="0 0 24 24"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 12h10"/></svg>',
  photo: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="15" rx="2"/><circle cx="12" cy="12.5" r="3.5"/><path d="M8 5l1.5-2h5L16 5"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  download: '<svg viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>',
  receipt: '<svg viewBox="0 0 24 24"><path d="M6 2h12v20l-3-2-3 2-3-2-3 2zM9 7h6M9 11h6M9 15h4"/></svg>',
};

async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: 'same-origin', ...opts });
  if (!res.ok) {
    let msg = `Fehler ${res.status}`;
    try { msg = (await res.json()).error ?? msg; } catch {}
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3000);
}

function busy(text) {
  const el = document.createElement('div');
  el.className = 'busy';
  el.innerHTML = `<div class="box"><div class="spinner"></div>${esc(text)}</div>`;
  document.body.append(el);
  return () => el.remove();
}

let config = null;
async function getConfig() {
  config ??= await api('/api/config');
  return config;
}

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// ---------- Aktionen ----------
async function startScan() {
  const { shortcutName } = await getConfig();
  if (!isIOS) {
    toast('Der Scanner ist nur auf iPad/iPhone verfügbar – nutze „Foto hochladen“.');
    return;
  }
  // Startet den Kurzbefehl, der den iOS-Dokumentenscanner öffnet und den Bon hochlädt.
  location.href = `shortcuts://run-shortcut?name=${encodeURIComponent(shortcutName)}`;
}

const fileInput = $('#file-input');
fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  fileInput.value = '';
  if (!file) return;
  const done = busy('Bon wird gelesen …');
  try {
    const fd = new FormData();
    fd.append('image', file);
    const r = await api('/api/scans', { method: 'POST', body: fd });
    location.hash = `#/bon/${r.id}`;
  } catch (e) {
    toast(e.message);
  } finally {
    done();
  }
});

// ---------- Ansichten ----------
async function renderHome() {
  const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
  const year = params.get('jahr') ?? '';
  const q = year ? `?year=${year}` : '';
  const [stats, receipts, drafts] = await Promise.all([
    api(`/api/stats${q}`),
    api(`/api/receipts?status=confirmed${year ? `&year=${year}` : ''}`),
    api('/api/receipts?status=draft'),
  ]);

  const yearOpts = ['<option value="">Alle Jahre</option>']
    .concat(stats.years.map((y) => `<option value="${y}" ${String(y) === year ? 'selected' : ''}>${y}</option>`))
    .join('');

  const row = (r, draft = false) => `
    <a class="row" href="#/bon/${r.id}">
      <span class="date">${draft ? '<span class="badge">Entwurf</span>' : dateDe(r.receipt_date)}</span>
      <span class="station">${esc(r.station || 'Unbekannte Tankstelle')}${r.fuel_type ? `<small>${esc(r.fuel_type)}</small>` : ''}</span>
      <span class="num">${liters(r.liters)}</span>
      <span class="num">${ppl(r.price_per_liter)}</span>
      <span class="num total">${eur(r.total)}</span>
    </a>`;

  view.innerHTML = `
    <div class="head-row">
      <div>
        <h1>Übersicht</h1>
        <p class="sub" style="margin:0">${stats.count} ${stats.count === 1 ? 'Tankvorgang' : 'Tankvorgänge'}</p>
      </div>
      <div class="actions">
        <button class="btn primary large" id="scan">${icons.scan} Bon scannen</button>
        <button class="btn large" id="photo">${icons.photo} Foto hochladen</button>
      </div>
    </div>

    <div class="stats">
      <div class="stat"><div class="label">Ausgaben</div><div class="value">${eur(stats.total)}</div></div>
      <div class="stat"><div class="label">Getankt</div><div class="value">${liters(stats.liters)}</div></div>
      <div class="stat"><div class="label">Ø Preis</div><div class="value">${ppl(stats.avg_price_per_liter)}</div></div>
      <div class="stat"><div class="label">Ø pro Tankvorgang</div><div class="value">${stats.count ? eur(stats.total / stats.count) : '–'}</div></div>
    </div>

    ${drafts.length ? `<h2>Noch zu prüfen</h2><div class="list">${drafts.map((r) => row(r, true)).join('')}</div>` : ''}

    <div class="head-row" style="margin:32px 0 12px">
      <h2 style="margin:0">Tankvorgänge</h2>
      <div class="actions">
        ${stats.years.length > 1 || year ? `<select class="year" id="year" aria-label="Jahr">${yearOpts}</select>` : ''}
        <a class="btn ghost" href="#/neu">${icons.plus} Manuell</a>
        <a class="btn ghost" href="/api/export.csv">${icons.download} CSV</a>
      </div>
    </div>
    ${receipts.length
      ? `<div class="list">${receipts.map((r) => row(r)).join('')}</div>`
      : `<div class="list empty">${icons.receipt}<div>Noch keine Bons erfasst.</div></div>`}
  `;

  $('#scan').onclick = startScan;
  $('#photo').onclick = () => fileInput.click();
  const sel = $('#year');
  if (sel) sel.onchange = () => (location.hash = sel.value ? `#/?jahr=${sel.value}` : '#/');
}

const FUEL_TYPES = ['Super E10', 'Super E5', 'Super Plus', 'Diesel', 'Premium Diesel', 'Premium Benzin', 'LPG', 'CNG', 'AdBlue'];

async function renderForm(id) {
  const isNew = id == null;
  const [r, known] = await Promise.all([
    isNew ? Promise.resolve({ receipt_date: new Date().toISOString().slice(0, 10) }) : api(`/api/receipts/${id}`),
    api('/api/receipts?status=confirmed'),
  ]);
  const stations = [...new Set(known.map((k) => k.station).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de'));
  const isDraft = r.status === 'draft';

  const image = r.has_image
    ? r.image_mime === 'application/pdf'
      ? `<div class="receipt-img"><iframe src="/api/receipts/${r.id}/image" title="Bon"></iframe></div>`
      : `<div class="receipt-img"><a href="/api/receipts/${r.id}/image" target="_blank"><img src="/api/receipts/${r.id}/image" alt="Gescannter Bon"></a></div>`
    : `<div class="receipt-img none">${isNew ? 'Manuelle Erfassung' : 'Kein Bild vorhanden'}</div>`;

  view.innerHTML = `
    <a href="#/" class="btn ghost" style="margin:-8px 0 12px -12px">${icons.back} Übersicht</a>
    <h1>${isNew ? 'Neuer Tankvorgang' : isDraft ? 'Bon prüfen' : 'Tankvorgang'}</h1>
    <p class="sub">${isDraft ? 'Bitte die erkannten Werte mit dem Bon vergleichen und speichern.' : isNew ? 'Werte vom Bon eintragen.' : `Erfasst am ${new Date(r.created_at).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })}`}</p>

    <div class="detail">
      ${image}
      <form class="card" id="form" novalidate>
        <div id="check"></div>
        <label class="field"><span>Tankstelle</span>
          <input name="station" value="${esc(r.station)}" list="stations" autocomplete="off" autocapitalize="words">
          <datalist id="stations">${stations.map((s) => `<option value="${esc(s)}">`).join('')}</datalist>
        </label>
        <div class="grid-2">
          <label class="field"><span>Datum</span><input name="receipt_date" type="date" value="${esc(r.receipt_date)}"></label>
          <label class="field"><span>Kraftstoff</span>
            <input name="fuel_type" value="${esc(r.fuel_type)}" list="fuels" autocomplete="off">
            <datalist id="fuels">${FUEL_TYPES.map((f) => `<option value="${f}">`).join('')}</datalist>
          </label>
        </div>
        <div class="grid-3">
          <label class="field"><span>Liter</span><div class="unit"><input name="liters" inputmode="decimal" value="${inputNum(r.liters, 2)}"><em>l</em></div></label>
          <label class="field"><span>Preis pro Liter</span><div class="unit"><input name="price_per_liter" inputmode="decimal" value="${inputNum(r.price_per_liter, 3)}"><em>€/l</em></div></label>
          <label class="field"><span>Betrag</span><div class="unit"><input name="total" inputmode="decimal" value="${inputNum(r.total, 2)}"><em>€</em></div></label>
        </div>
        <div class="form-actions">
          ${isNew ? '<span></span>' : `<button type="button" class="btn danger" id="delete">${isDraft ? 'Verwerfen' : 'Löschen'}</button>`}
          <div class="right">
            <button type="submit" class="btn primary">${isDraft || isNew ? 'Speichern' : 'Änderungen speichern'}</button>
          </div>
        </div>
        ${r.ocr_text ? `<details class="raw"><summary>Erkannter Text (${r.ocr_source === 'ios' ? 'iPad' : 'Server'})</summary><pre>${esc(r.ocr_text)}</pre></details>` : ''}
      </form>
    </div>
  `;

  const form = $('#form');
  const check = $('#check');

  // Plausibilitätsprüfung: Liter × Preis/Liter sollte den Betrag ergeben.
  function updateCheck() {
    const l = parseNum(form.liters.value);
    const p = parseNum(form.price_per_liter.value);
    const t = parseNum(form.total.value);
    if ([l, p, t].some((v) => Number.isNaN(v))) {
      check.innerHTML = '<div class="notice">Bitte Zahlen im Format 12,34 eingeben.</div>';
      return;
    }
    const missing = [l, p, t].filter((v) => v == null).length;
    if (missing === 1) {
      const [label, value, field] =
        t == null ? ['Betrag', (l * p).toFixed(2), 'total']
        : l == null ? ['Liter', (t / p).toFixed(2), 'liters']
        : ['Preis pro Liter', (t / l).toFixed(3), 'price_per_liter'];
      check.innerHTML = `<div class="notice">${label} fehlt. <a href="#" data-fill="${field}" data-value="${value}">Berechnen (${value.replace('.', ',')})</a></div>`;
      return;
    }
    if (missing) {
      check.innerHTML = '';
      return;
    }
    const diff = Math.abs(l * p - t);
    check.innerHTML = diff <= 0.05
      ? '<div class="notice ok">Liter × Preis pro Liter ergibt den Betrag. ✓</div>'
      : `<div class="notice">Liter × Preis pro Liter = ${eur(l * p)} – weicht vom Betrag ab. Bitte prüfen (ggf. Rabatt).</div>`;
  }
  check.addEventListener('click', (e) => {
    const a = e.target.closest('[data-fill]');
    if (!a) return;
    e.preventDefault();
    form[a.dataset.fill].value = a.dataset.value.replace('.', ',');
    updateCheck();
  });
  form.addEventListener('input', updateCheck);
  updateCheck();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const nums = ['liters', 'price_per_liter', 'total'].map((k) => parseNum(form[k].value));
    if (nums.some((v) => Number.isNaN(v))) return toast('Bitte gültige Zahlen eingeben.');
    const body = {
      station: form.station.value,
      receipt_date: form.receipt_date.value || null,
      fuel_type: form.fuel_type.value,
      liters: nums[0],
      price_per_liter: nums[1],
      total: nums[2],
      status: 'confirmed',
    };
    try {
      await api(isNew ? '/api/receipts' : `/api/receipts/${r.id}`, {
        method: isNew ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      toast('Gespeichert');
      location.hash = '#/';
    } catch (err) {
      toast(err.message);
    }
  });

  const del = $('#delete');
  if (del) {
    del.onclick = async () => {
      if (!confirm(isDraft ? 'Diesen Scan verwerfen?' : 'Diesen Tankvorgang endgültig löschen?')) return;
      try {
        await api(`/api/receipts/${r.id}`, { method: 'DELETE' });
        toast(isDraft ? 'Verworfen' : 'Gelöscht');
        location.hash = '#/';
      } catch (err) {
        toast(err.message);
      }
    };
  }
}

async function renderSetup() {
  const { shortcutName, baseUrl } = await getConfig();
  view.innerHTML = `
    <a href="#/" class="btn ghost" style="margin:-8px 0 12px -12px">${icons.back} Übersicht</a>
    <h1>Einrichtung</h1>
    <p class="sub">Damit „Bon scannen“ den eingebauten Dokumentenscanner von iPadOS nutzt, wird einmalig ein Kurzbefehl angelegt.</p>

    <div class="card prose">
      <p>Öffne auf dem iPad die App <b>Kurzbefehle</b>, tippe auf <b>+</b> und benenne den Kurzbefehl exakt <code>${esc(shortcutName)}</code>. Füge dann diese Aktionen hinzu:</p>
      <ol class="steps">
        <li><b>Dokument scannen</b><br>öffnet den Scanner mit automatischer Kantenerkennung.</li>
        <li><b>Text aus Bild extrahieren</b><br>Eingabe: <i>Gescanntes Dokument</i>. Die Texterkennung läuft direkt auf dem iPad.</li>
        <li><b>Inhalte von URL abrufen</b><br>
          URL: <code>${esc(baseUrl)}/api/scans</code><br>
          Methode: <b>POST</b>, Anfragetext: <b>Formular</b><br>
          Feld <code>text</code> (Typ Text) → <i>Extrahierter Text</i><br>
          Feld <code>image</code> (Typ Datei) → <i>Gescanntes Dokument</i>
        </li>
        <li><b>Wörterbuchwert abrufen</b><br>Wert für Schlüssel <code>reviewUrl</code> aus <i>Inhalte von URL</i>.</li>
        <li><b>URLs öffnen</b><br>Eingabe: <i>Wörterbuchwert</i> – öffnet den Bon direkt zur Prüfung.</li>
      </ol>
      <p>Danach startet der Button <b>Bon scannen</b> diesen Kurzbefehl. Beim ersten Lauf fragt iPadOS einmalig, ob der Kurzbefehl auf den Server zugreifen darf.</p>
      <p style="color:var(--muted);font-size:14px;margin:0">Tipp: In Safari über <b>Teilen → Zum Home-Bildschirm</b> lässt sich die App wie eine normale App starten.</p>
    </div>
  `;
}

// ---------- Router ----------
async function route() {
  const path = location.hash.replace(/^#/, '').split('?')[0] || '/';
  try {
    let m;
    if (path === '/') await renderHome();
    else if (path === '/neu') await renderForm(null);
    else if (path === '/einrichtung') await renderSetup();
    else if ((m = path.match(/^\/bon\/(\d+)$/))) await renderForm(Number(m[1]));
    else location.hash = '#/';
    window.scrollTo(0, 0);
  } catch (e) {
    view.innerHTML = `<div class="card empty">${esc(e.message)}<br><br><a class="btn" href="#/">Zur Übersicht</a></div>`;
  }
}

window.addEventListener('hashchange', route);
// Beim Zurückkehren vom Kurzbefehl (Tab war im Hintergrund) Übersicht aktualisieren.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (location.hash === '' || location.hash.startsWith('#/?') || location.hash === '#/')) route();
});
route();
