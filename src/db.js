import pg from 'pg';

// NUMERIC als JS-Zahl zurückgeben statt als String (Werte sind klein genug).
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
// DATE als 'YYYY-MM-DD'-String belassen, damit keine Zeitzonenverschiebung entsteht.
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS receipts (
  id               SERIAL PRIMARY KEY,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed')),
  station          TEXT,
  receipt_date     DATE,
  liters           NUMERIC(8, 2),
  price_per_liter  NUMERIC(6, 3),
  total            NUMERIC(8, 2),
  fuel_type        TEXT,
  ocr_text         TEXT,
  ocr_source       TEXT,
  image            BYTEA,
  image_mime       TEXT
);
CREATE INDEX IF NOT EXISTS receipts_date_idx ON receipts (receipt_date DESC);
CREATE INDEX IF NOT EXISTS receipts_status_idx ON receipts (status);
`;

export async function migrate({ retries = 20, delayMs = 1500 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query(SCHEMA);
      return;
    } catch (err) {
      // Beim Start per docker compose ist Postgres evtl. noch nicht bereit.
      if (attempt >= retries) throw err;
      console.warn(`Datenbank noch nicht erreichbar (${err.code || err.message}), neuer Versuch …`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

// Alle Spalten außer dem Bild (das wird separat ausgeliefert).
const COLUMNS = `id, created_at, updated_at, status, station, receipt_date, liters,
  price_per_liter, total, fuel_type, ocr_text, ocr_source, (image IS NOT NULL) AS has_image, image_mime`;

export async function insertReceipt(r) {
  const { rows } = await pool.query(
    `INSERT INTO receipts (status, station, receipt_date, liters, price_per_liter, total,
       fuel_type, ocr_text, ocr_source, image, image_mime)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING ${COLUMNS}`,
    [
      r.status ?? 'draft',
      r.station ?? null,
      r.receipt_date ?? null,
      r.liters ?? null,
      r.price_per_liter ?? null,
      r.total ?? null,
      r.fuel_type ?? null,
      r.ocr_text ?? null,
      r.ocr_source ?? null,
      r.image ?? null,
      r.image_mime ?? null,
    ],
  );
  return rows[0];
}

export async function listReceipts({ status, year } = {}) {
  const where = [];
  const params = [];
  if (status) {
    params.push(status);
    where.push(`status = $${params.length}`);
  }
  if (year) {
    params.push(Number(year));
    where.push(`EXTRACT(YEAR FROM receipt_date) = $${params.length}`);
  }
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM receipts
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY receipt_date DESC NULLS FIRST, id DESC`,
    params,
  );
  return rows;
}

export async function getReceipt(id) {
  const { rows } = await pool.query(`SELECT ${COLUMNS} FROM receipts WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function getImage(id) {
  const { rows } = await pool.query('SELECT image, image_mime FROM receipts WHERE id = $1', [id]);
  return rows[0]?.image ? rows[0] : null;
}

const EDITABLE = ['status', 'station', 'receipt_date', 'liters', 'price_per_liter', 'total', 'fuel_type'];

export async function updateReceipt(id, patch) {
  const sets = [];
  const params = [];
  for (const key of EDITABLE) {
    if (key in patch) {
      params.push(patch[key]);
      sets.push(`${key} = $${params.length}`);
    }
  }
  if (!sets.length) return getReceipt(id);
  params.push(id);
  const { rows } = await pool.query(
    `UPDATE receipts SET ${sets.join(', ')}, updated_at = now()
     WHERE id = $${params.length} RETURNING ${COLUMNS}`,
    params,
  );
  return rows[0] ?? null;
}

export async function deleteReceipt(id) {
  const { rowCount } = await pool.query('DELETE FROM receipts WHERE id = $1', [id]);
  return rowCount > 0;
}

export async function getStats({ year } = {}) {
  const params = [];
  let filter = '';
  if (year) {
    params.push(Number(year));
    filter = `AND EXTRACT(YEAR FROM receipt_date) = $1`;
  }
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS count,
            COALESCE(SUM(total), 0) AS total,
            COALESCE(SUM(liters), 0) AS liters,
            CASE WHEN SUM(liters) > 0 THEN ROUND(SUM(total) / SUM(liters), 3) END AS avg_price_per_liter
     FROM receipts WHERE status = 'confirmed' ${filter}`,
    params,
  );
  const years = await pool.query(
    `SELECT DISTINCT EXTRACT(YEAR FROM receipt_date)::int AS year FROM receipts
     WHERE status = 'confirmed' AND receipt_date IS NOT NULL ORDER BY year DESC`,
  );
  return { ...rows[0], years: years.rows.map((r) => r.year) };
}
