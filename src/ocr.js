import os from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
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
