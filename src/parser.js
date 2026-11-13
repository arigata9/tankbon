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

/**
 * Kassenbons nutzen schmale Schriften, in denen die Texterkennung das Liter-„l“ oft als
 * „1“, „I“ oder „|“ liest (z. B. „42,57 1 x 1,779 EUR/1“). An Stellen, an denen nur
 * ein „l“ stehen kann, wird es zurückkorrigiert.
 */
function fixLiterUnit(text) {
  return text
    // „EUR/1“, „€/1“, „Preis/1“, „1,779/1“ → „/l“
    .replace(/((?:€|eur|euro|preis|\d[.,]\d{3})[ \t]*\/[ \t]*)[1I|](?![\d.,])/gi, '$1l')
    // „42,57 1 x …“ bzw. „42,57 1“ am Zeilenende → „42,57 l“
    .replace(/(\d[.,]\d{2,3})[ \t]+[1I|](?=[ \t]*(?:[x×*]|$)|[ \t]{2,})/gim, '$1 l')
    // „42,571 x …“ – angeklebtes l als dritte Nachkommastelle gelesen
    .replace(/(\d[.,]\d{2})[1I|](?=[ \t]*[x×*])/gi, '$1 l');
}

function cleanText(text) {
  return fixLiterUnit(String(text ?? '')
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (c) => SUPERSCRIPT[c])
    .replace(/\r/g, '')
    .replace(/[‚‘’`´]/g, ',')
    .replace(/ /g, ' '));
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
        // Apples Texterkennung setzt Bezeichnung und Wert oft auf getrennte Zeilen
        // („Zu zahlen“ / „67,55“). Steht die Zahl am Zeilenanfang, zählt die Zeile darüber.
        label: line.slice(0, m.index).trim() ? line.slice(0, m.index) : (lines[lineIdx - 1] ?? ''),
      });
    }
  });
  return out;
}

function isLiters(n) {
  if (n.value <= 0.5 || n.value > 300) return false;
  if (/^\s*(l|ltr|liter|lt)\b(?!\s*\/)/i.test(n.after)) return true;
  if (/(menge|liter|abgabe|volumen)\s*:?\s*$/i.test(n.label) && !/^\s*(€|eur)/i.test(n.after)) return true;
  return false;
}

function isPricePerLiter(n) {
  if (n.value < 0.5 || n.value > 4) return false;
  if (/^\s*(€|eur|euro)?\s*\/\s*(l|ltr|liter)\b/i.test(n.after)) return true;
  if (/(€|eur)\s*\/\s*(l|ltr|liter)\s*:?\s*$/i.test(n.before)) return true;
  if (/(preis\s*\/?\s*(je\s*)?(l|ltr|liter)|literpreis|grundpreis|einzelpreis)\s*:?\s*(€|eur)?\s*$/i.test(n.label)) return true;
  // "42,57 l x 1,779" bzw. "42,57 l * 1,779"
  if (/\b(l|ltr|liter)\s*[x×*@à]\s*(€|eur)?\s*$/i.test(n.before)) return true;
  return false;
}

function isTotal(n) {
  if (n.value <= 0 || n.value > 2000 || n.decimals !== 2) return false;
  if (NOT_TOTAL.test(n.text)) return false;
  if (TOTAL_KEYWORDS.test(n.text)) return true;
  // Bezeichnung in der Zeile darüber, Zahl allein in dieser Zeile
  return n.label !== n.before && TOTAL_KEYWORDS.test(n.label) && !NOT_TOTAL.test(n.label) && !/\d[.,]\d{2}/.test(n.label);
}

const DISCOUNT = /rabatt|nachlass|cpl|ct\s*\/\s*l|coupon|gutschein|vorteil|ersparnis/i;

/**
 * Rabatte direkt unter dem Kraftstoff (z. B. „Rabatt 5cpl / -1,75 EUR“).
 * Berücksichtigt werden nur negative Beträge mit Rabatt-Bezeichnung in derselben Zeile
 * oder der Zeile darüber, höchstens 6 Zeilen nach dem Kraftstoff.
 */
function findFuelDiscount(numbers, afterLine) {
  let sum = 0;
  for (const n of numbers) {
    if (n.line <= afterLine || n.value >= 0) continue;
    if (n.line > afterLine + 6) break;
    if (DISCOUNT.test(n.text) || DISCOUNT.test(n.label)) sum += -n.value;
  }
  return round(sum, 2);
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
        // Ausnahme: eindeutig gekennzeichneter Literpreis („EUR/l“) und centgenaue Rechnung –
        // z. B. Aral-Bons, auf denen die Literzahl ganz ohne Einheit steht.
        const strongPrice = role.p(p) === 2 && l.decimals === 2 && diff <= 0.011;
        if (role.l(l) + role.p(p) + role.t(t) < 3 && !strongPrice) continue;
        if (!best || score > best.score) best = { score, l, p, t };
      }
    }
  }
  if (best) {
    const discount = findFuelDiscount(numbers, Math.max(best.l.line, best.p.line, best.t.line));
    if (discount > 0 && discount < best.t.value) {
      // Betrag = tatsächlich bezahlter Kraftstoffpreis; der Literpreis bleibt wie gedruckt.
      return { liters: best.l.value, price_per_liter: best.p.value, total: round(best.t.value - discount, 2), consistent: false, discount };
    }
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

/** Kategorie der Sorte (z. B. „Premium Benzin“) – nur noch Notlösung, wenn kein Produktname lesbar ist. */
export function findFuelCategory(text) {
  for (const [name, re] of FUELS) if (re.test(String(text ?? ''))) return name;
  return null;
}

/** „EXCELLIUM SUPER PLUS“ → „Excellium Super Plus“; Bezeichnungen mit Ziffern (E10, 98) bleiben. */
function tidyCase(s) {
  if (s !== s.toUpperCase()) return s;
  return s
    .split(' ')
    .map((w) => (/\d/.test(w) ? w : w.toLowerCase().replace(/(^|-)(\p{L})/gu, (_, p, c) => p + c.toUpperCase())))
    .join(' ');
}

/**
 * Produktname so, wie er auf dem Bon steht – ohne Säulennummer, Mengen, Preise und Symbole.
 * Beispiel: „Excellium Super Plus * €   86,20*A“ → „Excellium Super Plus“
 */
function cleanProductName(line) {
  const s = line
    .replace(/s[äa]ule\s*:?\s*(nr\.?)?\s*\d+/gi, ' ')
    .replace(/\b(zapf\w*|nr|s)\.?\s*\d+\b/gi, ' ')
    .replace(/-?\d+\s?[.,]\s?\d+/g, ' ')
    .replace(/\b\d{4,}\b/g, ' ') // Artikelnummern wie „000012“
    .replace(/[*#€@×:|]|\beur\b|\b(l|ltr|liter)\b|\/|\bx\b/gi, ' ')
    .replace(/\s+[A-Z]$/, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-.,]+|[\s\-.,]+$/g, '');
  return tidyCase(s);
}

function findFuel(lines, text) {
  const category = findFuelCategory(text);
  if (!category) return null;
  const re = FUELS.find(([name]) => name === category)[1];
  const line = lines.find((l) => re.test(l));
  const name = line ? cleanProductName(line) : '';
  const plausible = name.length >= 3 && name.length <= 40 && /\p{L}{2,}/u.test(name) && !/summe|betrag|gesamt|mwst|netto/i.test(name);
  return plausible ? name : category;
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
    fuel_type: findFuel(lines, cleaned),
    consistent: amounts.consistent,
  };
}
