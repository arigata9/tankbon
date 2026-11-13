import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import express from 'express';
import multer from 'multer';
import * as db from './db.js';
import { parseReceipt } from './parser.js';
import { recognize, normalizeForStorage, isImage } from './ocr.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const SHORTCUT_NAME = process.env.SHORTCUT_NAME ?? 'Tankbon scannen';
const PUBLIC_URL = process.env.PUBLIC_URL?.replace(/\/+$/, '') || null;
const AUTH_USER = process.env.AUTH_USER || null;
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || null;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

// ---------- Optionaler Passwortschutz (HTTP Basic Auth) ----------
function safeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
if (AUTH_USER && AUTH_PASSWORD) {
  app.use((req, res, next) => {
    if (req.path === '/api/health') return next();
    const [scheme, encoded] = (req.headers.authorization ?? '').split(' ');
    if (scheme === 'Basic' && encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString();
      const idx = decoded.indexOf(':');
      if (idx > 0 && safeEqual(decoded.slice(0, idx), AUTH_USER) && safeEqual(decoded.slice(idx + 1), AUTH_PASSWORD)) {
        return next();
      }
    }
    res.set('WWW-Authenticate', 'Basic realm="Tankbon", charset="UTF-8"').status(401).send('Anmeldung erforderlich');
  });
}

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function baseUrl(req) {
  return PUBLIC_URL ?? `${req.protocol}://${req.get('host')}`;
}

// ---------- Eingabeprüfung ----------
function toNumber(v, digits) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `Ungültige Zahl: ${v}`);
  return Math.round(n * 10 ** digits) / 10 ** digits;
}
function toDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw new HttpError(400, `Ungültiges Datum: ${v}`);
  return v;
}
function toText(v, max = 200) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}
function sanitize(body) {
  const out = {};
  if ('station' in body) out.station = toText(body.station);
  if ('fuel_type' in body) out.fuel_type = toText(body.fuel_type, 50);
  if ('receipt_date' in body) out.receipt_date = toDate(body.receipt_date);
  if ('liters' in body) out.liters = toNumber(body.liters, 2);
  if ('price_per_liter' in body) out.price_per_liter = toNumber(body.price_per_liter, 3);
  if ('total' in body) out.total = toNumber(body.total, 2);
  if ('status' in body) {
    if (!['draft', 'confirmed'].includes(body.status)) throw new HttpError(400, 'Ungültiger Status');
    out.status = body.status;
  }
  return out;
}
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
function parseId(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Ungültige ID');
  return id;
}

// ---------- API ----------
app.get('/api/health', asyncRoute(async (_req, res) => {
  if (!db.dbState.ready) {
    return res.status(503).json({ ok: false, database: 'nicht verbunden', error: db.dbState.error, attempts: db.dbState.attempts });
  }
  await db.pool.query('SELECT 1');
  res.json({ ok: true, database: 'verbunden' });
}));

// Solange die Datenbank fehlt, liefert die API eine verständliche Fehlermeldung statt zu hängen.
app.use('/api', (req, res, next) => {
  if (db.dbState.ready || req.path === '/config') return next();
  res.status(503).json({ error: `Datenbank nicht erreichbar: ${db.dbState.error ?? 'Verbindung wird aufgebaut …'}` });
});

app.get('/api/config', (req, res) => {
  res.json({ shortcutName: SHORTCUT_NAME, baseUrl: baseUrl(req) });
});

/**
 * Neuen Bon erfassen.
 * Multipart-Felder:
 *   image – Scan/Foto (JPEG, PNG, HEIC oder PDF), optional
 *   text  – bereits vom iPad erkannter Text (Kurzbefehl "Text aus Bild extrahieren"), optional
 * Mindestens eins von beiden muss vorhanden sein. Ohne Text wird auf dem Server per OCR gelesen.
 */
app.post('/api/scans', upload.single('image'), asyncRoute(async (req, res) => {
  const file = req.file;
  let text = typeof req.body.text === 'string' ? req.body.text.trim() : '';
  let source = text ? 'ios' : null;

  if (!file && !text) throw new HttpError(400, 'Weder Bild noch Text übermittelt');

  if (!text && file) {
    if (!isImage(file.mimetype)) {
      throw new HttpError(415, 'Für PDFs bitte den Text mitsenden (Kurzbefehl) oder ein Foto hochladen');
    }
    text = await recognize(file.buffer);
    source = 'server';
  }

  const parsed = parseReceipt(text);
  let image = null;
  let image_mime = null;
  if (file) {
    const stored = await normalizeForStorage(file.buffer, file.mimetype);
    image = stored.buffer;
    image_mime = stored.mime;
  }

  const receipt = await db.insertReceipt({
    ...parsed,
    status: 'draft',
    ocr_text: text,
    ocr_source: source,
    image,
    image_mime,
  });

  res.status(201).json({
    ...receipt,
    consistent: parsed.consistent,
    reviewUrl: `${baseUrl(req)}/#/bon/${receipt.id}`,
  });
}));

/** Manuelle Erfassung ohne Scan. */
app.post('/api/receipts', asyncRoute(async (req, res) => {
  const data = sanitize(req.body ?? {});
  const receipt = await db.insertReceipt({ status: 'confirmed', ocr_source: 'manual', ...data });
  res.status(201).json(receipt);
}));

app.get('/api/receipts', asyncRoute(async (req, res) => {
  const status = ['draft', 'confirmed'].includes(req.query.status) ? req.query.status : undefined;
  const year = /^\d{4}$/.test(req.query.year ?? '') ? req.query.year : undefined;
  res.json(await db.listReceipts({ status, year }));
}));

app.get('/api/receipts/:id', asyncRoute(async (req, res) => {
  const receipt = await db.getReceipt(parseId(req));
  if (!receipt) throw new HttpError(404, 'Bon nicht gefunden');
  res.json(receipt);
}));

app.get('/api/receipts/:id/image', asyncRoute(async (req, res) => {
  const img = await db.getImage(parseId(req));
  if (!img) throw new HttpError(404, 'Kein Bild vorhanden');
  res.set('Content-Type', img.image_mime ?? 'application/octet-stream');
  res.set('Cache-Control', 'private, max-age=86400');
  res.send(img.image);
}));

app.put('/api/receipts/:id', asyncRoute(async (req, res) => {
  const receipt = await db.updateReceipt(parseId(req), sanitize(req.body ?? {}));
  if (!receipt) throw new HttpError(404, 'Bon nicht gefunden');
  res.json(receipt);
}));

app.delete('/api/receipts/:id', asyncRoute(async (req, res) => {
  if (!(await db.deleteReceipt(parseId(req)))) throw new HttpError(404, 'Bon nicht gefunden');
  res.status(204).end();
}));

app.get('/api/stats', asyncRoute(async (req, res) => {
  const year = /^\d{4}$/.test(req.query.year ?? '') ? req.query.year : undefined;
  res.json(await db.getStats({ year }));
}));

/** CSV-Export (Semikolon + Dezimalkomma, öffnet sich direkt korrekt in Excel/Numbers mit deutscher Einstellung). */
app.get('/api/export.csv', asyncRoute(async (_req, res) => {
  const rows = await db.listReceipts({ status: 'confirmed' });
  const num = (v, d) => (v == null ? '' : Number(v).toFixed(d).replace('.', ','));
  const esc = (v) => (v == null ? '' : /[;"\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v);
  const lines = ['Datum;Tankstelle;Kraftstoff;Liter;Preis pro Liter;Betrag'];
  for (const r of rows) {
    lines.push([r.receipt_date ?? '', esc(r.station), esc(r.fuel_type), num(r.liters, 2), num(r.price_per_liter, 3), num(r.total, 2)].join(';'));
  }
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="tankbons.csv"');
  res.send('﻿' + lines.join('\r\n'));
}));

app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Nicht gefunden')));

app.use((err, _req, res, _next) => {
  const status = err.status ?? (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Interner Fehler' : err.message });
});

// Erst den Webserver starten, dann (im Hintergrund) die Datenbank anbinden.
const server = app.listen(PORT, '0.0.0.0', () => console.log(`Tankbon läuft auf Port ${PORT} (im Container)`));
db.migrate();

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(() => db.pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
