import os from 'node:os';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { createWorker, PSM } from 'tesseract.js';

const require = createRequire(import.meta.url);
// Deutsche Sprachdaten liegen lokal im npm-Paket – kein Download zur Laufzeit nötig.
const LANG_PATH = path.join(path.dirname(require.resolve('@tesseract.js-data/deu')), '4.0.0_best_int');

let workerPromise = null;
let queue = Promise.resolve();

function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const worker = await createWorker('deu', 1, {
        langPath: LANG_PATH,
        gzip: true,
        cachePath: os.tmpdir(),
      });
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.SINGLE_COLUMN,
        preserve_interword_spaces: '1',
      });
      return worker;
    })().catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

/**
 * Bereitet ein Foto für die Texterkennung auf: Ausrichtung korrigieren,
 * Graustufen, Kontrast strecken, auf eine sinnvolle Breite skalieren.
 */
async function preprocess(buffer) {
  return sharp(buffer)
    .rotate()
    .grayscale()
    .resize({ width: 1600, withoutEnlargement: false })
    .normalize()
    .sharpen()
    .png()
    .toBuffer();
}

/** Texterkennung auf dem Server (Fallback, wenn das iPad keinen Text mitliefert). */
export function recognize(buffer) {
  // Ein Worker, Aufträge nacheinander – reicht für einen Haushalt und schont den RAM.
  const job = queue.then(async () => {
    const worker = await getWorker();
    const img = await preprocess(buffer);
    const { data } = await worker.recognize(img);
    return data.text;
  });
  queue = job.catch(() => {});
  return job;
}

/** Wandelt Bilder (z. B. HEIC/PNG) für die Ablage in ein kompaktes JPEG um. PDFs bleiben unverändert. */
export async function normalizeForStorage(buffer, mime) {
  if (mime === 'application/pdf') return { buffer, mime };
  try {
    const out = await sharp(buffer).rotate().resize({ width: 1800, withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
    return { buffer: out, mime: 'image/jpeg' };
  } catch {
    return { buffer, mime };
  }
}

export function isImage(mime) {
  return typeof mime === 'string' && mime.startsWith('image/');
}

/** Für Uploads ohne passenden MIME-Typ (Kurzbefehle senden teils application/octet-stream). */
export async function isReadableImage(buffer) {
  try {
    await sharp(buffer).metadata();
    return true;
  } catch {
    return false;
  }
}

export function isPdf(file) {
  return file.mimetype === 'application/pdf' || file.buffer.subarray(0, 5).toString() === '%PDF-';
}

const run = promisify(execFile);
const MAX_PAGES = 3;

/**
 * Verarbeitet ein PDF (z. B. aus „Dokument scannen“ im iOS-Kurzbefehl):
 *  - eingebetteten Text auslesen, falls das PDF eine Textebene hat,
 *  - sonst die Seiten rendern und per OCR lesen.
 * Liefert außerdem Seite 1 als JPEG für die Ablage und Anzeige.
 */
export async function processPdf(buffer) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tankbon-'));
  try {
    const pdfPath = path.join(dir, 'scan.pdf');
    await fs.writeFile(pdfPath, buffer);

    let text = '';
    try {
      const { stdout } = await run('pdftotext', ['-layout', '-l', String(MAX_PAGES), pdfPath, '-'], { maxBuffer: 5e6 });
      text = stdout.trim();
    } catch {
      // Keine Textebene oder defektes PDF – unten per OCR weiter.
    }

    await run('pdftoppm', ['-r', '250', '-gray', '-png', '-l', String(MAX_PAGES), pdfPath, path.join(dir, 'page')]);
    const pages = (await fs.readdir(dir)).filter((f) => f.startsWith('page') && f.endsWith('.png')).sort();
    if (!pages.length) throw new Error('PDF enthält keine Seiten');
    const pageBuffers = await Promise.all(pages.map((p) => fs.readFile(path.join(dir, p))));

    let source = 'pdf-text';
    // Nur Text mit Ziffern zählt – manche PDFs enthalten bloß Metadaten-Fragmente.
    if (!/\d[.,]\d{2}/.test(text)) {
      const texts = [];
      for (const page of pageBuffers) texts.push(await recognize(page));
      text = texts.join('\n');
      source = 'server';
    }

    const preview = await sharp(pageBuffers[0]).resize({ width: 1800, withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
    return { text, source, image: preview, mime: 'image/jpeg' };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
