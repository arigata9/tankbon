/**
 * Liest aus dem OCR-Text eines Tankstellen-Kassenbons die relevanten Werte aus.
 *
 * Vorgehen:
 *  1. Alle Zahlen mit Nachkommastellen werden mit ihrem Kontext (Text davor/danach) gesammelt.
 *  2. Anhand von Einheiten und Schlüsselwörtern werden Kandidaten für Liter, Preis/Liter und Summe bestimmt.
 *  3. Es wird die Kombination gesucht, für die Liter × Preis/Liter ≈ Summe gilt.
 *     Das macht die Erkennung robust gegen MwSt-Zeilen, Rabatte, gegebenes Bargeld usw.
 *  4. Fehlt ein Wert, wird er – wenn möglich – aus den beiden anderen berechnet.
 */

const SUPERSCRIPT = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9' };

const BRANDS = [
  ['Aral', /\baral\b/i],
  ['Shell', /\bshell\b/i],
  ['Esso', /\besso\b/i],
  ['TotalEnergies', /\btotal\s*energies\b/i],
  ['Total', /\btotal\b(?!\s*(?:eur|€|betrag|:|\d))/i],
  ['JET', /\bjet\b/i],
  ['AVIA', /\bavia\b/i],
  ['Agip', /\bagip\b/i],
  ['Eni', /\beni\b/i],
  ['OMV', /\bomv\b/i],
  ['Star', /\bstar\b(?:\s+tankstelle)?/i],
  ['Orlen', /\borlen\b/i],
  ['HEM', /\bhem\b/i],
  ['Westfalen', /\bwestfalen\b/i],
  ['Raiffeisen', /\braiffeisen\b/i],
  ['bft', /\bbft\b/i],
  ['Tamoil', /\btamoil\b/i],
  ['Q1', /\bq1\b/i],
  ['Hoyer', /\bhoyer\b/i],
  ['Score', /\bscore\b/i],
  ['Classic', /\bclassic\b/i],
  ['Sprint', /\bsprint\b/i],
  ['Globus', /\bglobus\b/i],
  ['Kaufland', /\bkaufland\b/i],
  ['Marktkauf', /\bmarktkauf\b/i],
  ['V-Markt', /\bv-?markt\b/i],
  ['Calpam', /\bcalpam\b/i],
  ['Elan', /\belan\b/i],
  ['Oil!', /\boil\s*!/i],
  ['Bavaria Petrol', /\bbavaria\s+petrol\b/i],
  ['Mundorf', /\bmundorf\b/i],
  ['Freie Tankstelle', /\bfreie\s+tankstelle\b/i],
  ['BP', /\bbp\b/i],
  ['Migrol', /\bmigrol\b/i],
  ['Socar', /\bsocar\b/i],
  ['Turmöl', /\bturm[oö]l\b/i],
  ['Eggert', /\beggert\b/i],
];

const FUELS = [
  ['Premium Diesel', /\b(ultimate|v-?power|excellium|maxx?motion|supreme)\b[^\n]{0,12}diesel|diesel[^\n]{0,6}\b(ultimate|v-?power|excellium|premium|plus)\b/i],
  ['Premium Benzin', /\b(ultimate\s*10[02]|v-?power\s*(racing|100)?|excellium\s*(98|super)?|maxx?motion\s*(super|100)?|supreme\s*\+?)\b/i],
  ['Super Plus', /super\s*plus|super\s*98|\bsp\s*98\b/i],
  ['Super E10', /super\s*e\s*-?\s*10|\be\s*-?\s*10\b|super\s*95\s*e\s*10/i],
  ['Super E5', /super\s*e\s*-?\s*5\b|super\s*95|\be\s*-?\s*5\b/i],
  ['Diesel', /diesel/i],
  ['LPG', /\blpg\b|autogas/i],
  ['CNG', /\bcng\b|erdgas/i],
  ['AdBlue', /ad\s*blue/i],
  ['Super', /\bsuper\b/i],
];

const TOTAL_KEYWORDS = /summe|gesamt|total|zu\s*zahlen|zahlbetrag|betrag|endbetrag|\bbar\b|ec[-\s]?karte|girocard|karten?zahlung|visa|master\s*card|maestro|kredit\s*karte|v\s*pay|amex|apple\s*pay|kontaktlos/i;
const NOT_TOTAL = /mwst|mw\.?\s*st|ust|netto|steuer|tax|r[uü]ckgeld|wechselgeld|gegeben|zur[uü]ck|rabatt|nachlass|punkte|payback|guthaben/i;

function cleanText(text) {
  return String(text ?? '')
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (c) => SUPERSCRIPT[c])
    .replace(/\r/g, '')
    .replace(/[‚‘’`´]/g, ',')
    .replace(/ /g, ' ');
}

function round(n, d) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

/** Sammelt alle Dezimalzahlen mit Kontext. */
function extractNumbers(lines) {
  const out = [];
  lines.forEach((rawLine, lineIdx) => {
    // Datums- und Uhrzeitangaben entfernen, damit z. B. "13.11" nicht als Zahl gilt.
    let line = rawLine
      .replace(/\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/g, (m) => ' '.repeat(m.length))
      .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, (m) => ' '.repeat(m.length));
    // "1,77 9 EUR/l" – hochgestellte dritte Stelle, die OCR mit Leerzeichen abtrennt.
    line = line.replace(/(\d[.,]\d{2})\s(\d)(?=\s*(?:€|eur)?\s*\/\s*l)/gi, '$1$2');
    const re = /(?<![\d.,])(-?\d{1,4})\s?[.,]\s?(\d{2,3})(?![\d]|[.,]\d)/g;
    let m;
    while ((m = re.exec(line))) {
      const value = Number(`${m[1]}.${m[2]}`);
      out.push({
        value,
        decimals: m[2].length,
        line: lineIdx,
        before: line.slice(0, m.index),
        after: line.slice(m.index + m[0].length),
        text: rawLine,
      });
    }
  });
  return out;
}

function isLiters(n) {
  if (n.value <= 0.5 || n.value > 300) return false;
  if (/^\s*(l|ltr|liter|lt)\b(?!\s*\/)/i.test(n.after)) return true;
  if (/(menge|liter|abgabe|volumen)\s*:?\s*$/i.test(n.before) && !/^\s*(€|eur)/i.test(n.after)) return true;
  return false;
}

function isPricePerLiter(n) {
  if (n.value < 0.5 || n.value > 4) return false;
  if (/^\s*(€|eur|euro)?\s*\/\s*(l|ltr|liter)\b/i.test(n.after)) return true;
  if (/(€|eur)\s*\/\s*(l|ltr|liter)\s*:?\s*$/i.test(n.before)) return true;
  if (/(preis\s*\/?\s*(je\s*)?(l|ltr|liter)|literpreis|grundpreis|einzelpreis)\s*:?\s*(€|eur)?\s*$/i.test(n.before)) return true;
  // "42,57 l x 1,779" bzw. "42,57 l * 1,779"
  if (/\b(l|ltr|liter)\s*[x×*@à]\s*(€|eur)?\s*$/i.test(n.before)) return true;
  return false;
}

function isTotal(n) {
  if (n.value <= 0 || n.value > 2000 || n.decimals !== 2) return false;
  if (NOT_TOTAL.test(n.text)) return false;
  return TOTAL_KEYWORDS.test(n.text);
}

function findAmounts(numbers) {
  const liters = numbers.filter(isLiters);
  const ppl = numbers.filter(isPricePerLiter);
  const totals = numbers.filter(isTotal);

  const role = {
    l: (n) => (liters.includes(n) ? 2 : 0),
    p: (n) => (ppl.includes(n) ? 2 : n.decimals === 3 ? 1 : 0),
    t: (n) => (totals.includes(n) ? 2 : 0),
  };

  // Beste Kombination mit Liter × Preis/Liter ≈ Summe suchen.
  let best = null;
  const plausibleL = numbers.filter((n) => n.value > 0.5 && n.value <= 300);
  const plausibleP = numbers.filter((n) => n.value >= 0.5 && n.value <= 4);
  const plausibleT = numbers.filter((n) => n.value > 0.5 && n.value <= 2000 && n.decimals === 2 && !NOT_TOTAL.test(n.text));
  for (const l of plausibleL) {
    for (const p of plausibleP) {
      if (p === l) continue;
      const expected = l.value * p.value;
      for (const t of plausibleT) {
        if (t === l || t === p) continue;
        const diff = Math.abs(expected - t.value);
        if (diff > Math.max(0.02, t.value * 0.001)) continue;
        const score = role.l(l) + role.p(p) + role.t(t) - diff;
        // Ohne mindestens zwei klare Hinweise sind Zufallstreffer zu wahrscheinlich.
        if (role.l(l) + role.p(p) + role.t(t) < 3) continue;
        if (!best || score > best.score) best = { score, l, p, t };
      }
    }
  }
  if (best) {
    return { liters: best.l.value, price_per_liter: best.p.value, total: best.t.value, consistent: true };
  }

  // Keine stimmige Kombination – einzelne Kandidaten nehmen und Fehlendes berechnen.
  let l = liters[0]?.value ?? null;
  let p = ppl[0]?.value ?? null;
  let t = null;
  if (totals.length) {
    // Häufigster Betrag gewinnt (Summe steht oft mehrfach auf dem Bon), sonst der größte.
    const counts = new Map();
    for (const n of totals) counts.set(n.value, (counts.get(n.value) ?? 0) + 1);
    t = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
  }
  if (l != null && p != null && t == null) t = round(l * p, 2);
  else if (t != null && p != null && l == null) l = round(t / p, 2);
  else if (t != null && l != null && p == null) p = round(t / l, 3);
  return { liters: l, price_per_liter: p, total: t, consistent: false };
}

function findDate(text, now = new Date()) {
  const candidates = [];
  const de = /\b(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})\b/g;
  const iso = /\b(20\d{2})-(\d{2})-(\d{2})(?:T|\b)/g;
  let m;
  while ((m = de.exec(text))) {
    let y = Number(m[3]);
    if (m[3].length === 2) y += 2000;
    candidates.push([y, Number(m[2]), Number(m[1])]);
  }
  while ((m = iso.exec(text))) candidates.push([Number(m[1]), Number(m[2]), Number(m[3])]);

  const maxTime = now.getTime() + 2 * 86400000;
  for (const [y, mo, d] of candidates) {
    if (y < 2000 || mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    const date = new Date(Date.UTC(y, mo - 1, d));
    if (date.getUTCMonth() !== mo - 1) continue; // z. B. 31.02.
    if (date.getTime() > maxTime) continue;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return null;
}

function findStation(lines) {
  const head = lines.slice(0, 15);
  let brand = null;
  for (const line of head) {
    for (const [name, re] of BRANDS) {
      if (re.test(line)) {
        brand = name;
        break;
      }
    }
    if (brand) break;
  }
  if (!brand) {
    for (const line of lines) {
      for (const [name, re] of BRANDS) {
        if (name !== 'Total' && re.test(line)) {
          brand = name;
          break;
        }
      }
      if (brand) break;
    }
  }

  // Ort aus der Zeile mit Postleitzahl (DE: 5-stellig, AT/CH: 4-stellig).
  let city = null;
  for (const line of head) {
    const m = line.match(/\b(?:D-|A-|CH-)?\d{4,5}\s+([A-ZÄÖÜ][A-Za-zÄÖÜäöüß.\- ]{1,40})/);
    if (m) {
      city = m[1].replace(/\s{2,}.*$/, '').trim();
      break;
    }
  }

  if (brand && city) return `${brand} ${city}`;
  if (brand) return brand;

  // Fallback: erste "sprechende" Zeile.
  const ignore = /kassenbon|beleg|rechnung|quittung|willkommen|herzlich|kunde|^\W*$/i;
  const first = head.find((l) => /[A-Za-zÄÖÜäöü]{3,}/.test(l) && !ignore.test(l));
  return first ? [first.trim(), city].filter(Boolean).join(' ') : city;
}

function findFuel(text) {
  for (const [name, re] of FUELS) if (re.test(text)) return name;
  return null;
}

export function parseReceipt(text, { now } = {}) {
  const cleaned = cleanText(text);
  const lines = cleaned
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const numbers = extractNumbers(lines);
  const amounts = findAmounts(numbers);
  return {
    station: findStation(lines),
    receipt_date: findDate(cleaned, now),
    liters: amounts.liters,
    price_per_liter: amounts.price_per_liter,
    total: amounts.total,
    fuel_type: findFuel(cleaned),
    consistent: amounts.consistent,
  };
}
