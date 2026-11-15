#!/bin/bash
#
# Spiegelt die Tankbons-Datenbank auf einen zweiten PostgreSQL-Server („Cold Mirror“),
# sobald dieser erreichbar ist. Gedacht für einen Backup-Rechner, der nur gelegentlich läuft.
#
# Ablauf bei jedem Aufruf:
#   1. Backup-Server nicht erreichbar → still beenden (Normalfall).
#   2. Prüfsumme über alle Bons, Bilder und Einstellungen auf beiden Seiten vergleichen.
#      Gleich → nichts zu tun.
#   3. Sonst: Produktiv-Datenbank in EINER Transaktion auf den Backup-Server übertragen.
#      Bricht das ab (z. B. Backup-Rechner wird ausgeschaltet), bleibt dort der alte Stand.
#   4. Prüfsummen erneut vergleichen, Ergebnis als Unraid-Benachrichtigung.
#
# Zugangsdaten in der .env des Projekts:
#   MIRROR_HOST=backup-host.example     (Pflicht)
#   MIRROR_PORT=5432
#   MIRROR_USER=tankbon
#   MIRROR_PASSWORD=...                 (Pflicht)
#   MIRROR_DB=tankbon
#
# Einrichtung: Settings → User Scripts → Add new script, Schedule „Custom“ z. B. „23 * * * *“
# (stündlich), Inhalt:
#
#   #!/bin/bash
#   bash /boot/config/plugins/compose.manager/projects/tankbon/scripts/unraid-mirror.sh

# ---------- Einstellungen (per Umgebungsvariable überschreibbar) ----------
PROJECT_DIR="${PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
NOTIFY_ON_SUCCESS="${NOTIFY_ON_SUCCESS:-yes}"   # Meldung, wenn tatsächlich gespiegelt wurde
# ---------------------------------------------------------------------------

set -uo pipefail

NOTIFY=/usr/local/emhttp/webGui/scripts/notify
notify() { # $1 = normal|warning|alert, $2 = Betreff, $3 = Text
  echo "$2: $3"
  [ -x "$NOTIFY" ] && "$NOTIFY" -e "Tankbon-Spiegel" -s "$2" -d "$3" -i "$1" >/dev/null 2>&1
  return 0
}
fail() { notify alert "Tankbon-Spiegel fehlgeschlagen" "$1"; exit 1; }

# Nicht doppelt laufen lassen, falls ein Spiegeln länger dauert als der Zeitplan
exec 9>/tmp/tankbon-mirror.lock
flock -n 9 || { echo "Läuft bereits – übersprungen."; exit 0; }

# Werte aus .env lesen (ohne die Datei auszuführen)
env_value() {
  local v
  v=$(grep -E "^$1=" "$PROJECT_DIR/.env" 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '\r"'"'")
  echo "${v:-$2}"
}
DB_USER=$(env_value POSTGRES_USER tankbon)
DB_NAME=$(env_value POSTGRES_DB tankbon)
M_HOST=$(env_value MIRROR_HOST "")
M_PORT=$(env_value MIRROR_PORT 5432)
M_USER=$(env_value MIRROR_USER tankbon)
M_PASS=$(env_value MIRROR_PASSWORD "")
M_DB=$(env_value MIRROR_DB tankbon)

[ -n "$M_HOST" ] || fail "MIRROR_HOST fehlt in $PROJECT_DIR/.env"
[ -n "$M_PASS" ] || fail "MIRROR_PASSWORD fehlt in $PROJECT_DIR/.env"

[ -f "$PROJECT_DIR/docker-compose.yml" ] || fail "Projektordner nicht gefunden: $PROJECT_DIR"
CONTAINER=$(cd "$PROJECT_DIR" && docker compose ps -q db 2>/dev/null)
[ -n "$CONTAINER" ] || fail "Produktiv-Datenbank läuft nicht (docker compose ps -q db ist leer)"

# Befehle im Produktiv-Container: lokal bzw. gegen den Backup-Server
prod()   { docker exec -i "$CONTAINER" "$@"; }
mirror() { docker exec -i -e PGPASSWORD="$M_PASS" -e PGCONNECT_TIMEOUT=10 "$CONTAINER" "$@"; }

# 1. Backup-Server erreichbar?
if ! mirror pg_isready -q -h "$M_HOST" -p "$M_PORT" -t 5; then
  echo "Backup-Server $M_HOST:$M_PORT nicht erreichbar – nichts zu tun."
  exit 0
fi

# 2. Prüfsumme über alle Daten (Bons inkl. Bilder, Einstellungen)
FINGERPRINT_SQL="SELECT md5(
  coalesce((SELECT string_agg(md5(r::text), '' ORDER BY r.id) FROM receipts r), '') || '|' ||
  coalesce((SELECT string_agg(s.key || '=' || s.value::text, '' ORDER BY s.key) FROM settings s), ''))"

PROD_SUM=$(prod psql -X -q -t -A -U "$DB_USER" -d "$DB_NAME" -c "$FINGERPRINT_SQL") \
  || fail "Prüfsumme der Produktiv-Datenbank konnte nicht berechnet werden"
# Auf dem Backup-Server dürfen die Tabellen fehlen (erster Lauf) – dann ist er eben „anders“.
MIRROR_SUM=$(mirror psql -X -q -t -A -h "$M_HOST" -p "$M_PORT" -U "$M_USER" -d "$M_DB" -c "$FINGERPRINT_SQL" 2>/dev/null || echo "leer")

if [ "$PROD_SUM" = "$MIRROR_SUM" ]; then
  echo "Backup-Server ist bereits aktuell."
  exit 0
fi

# 3. Übertragen – alles oder nichts
ERR=$(mktemp)
prod pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc \
  | mirror pg_restore -h "$M_HOST" -p "$M_PORT" -U "$M_USER" -d "$M_DB" \
      --clean --if-exists --no-owner --no-privileges --single-transaction --exit-on-error 2>"$ERR"
STATUS=$?
if [ $STATUS -ne 0 ]; then
  DETAIL=$(grep -m1 -iE "error|fatal" "$ERR" | cut -c1-200)
  rm -f "$ERR"
  fail "Übertragung abgebrochen, Backup-Server unverändert. ${DETAIL}"
fi
rm -f "$ERR"

# 4. Kontrolle
MIRROR_SUM=$(mirror psql -X -q -t -A -h "$M_HOST" -p "$M_PORT" -U "$M_USER" -d "$M_DB" -c "$FINGERPRINT_SQL" 2>/dev/null)
[ "$PROD_SUM" = "$MIRROR_SUM" ] || fail "Nach dem Spiegeln stimmen die Daten nicht überein"

COUNT=$(mirror psql -X -q -t -A -h "$M_HOST" -p "$M_PORT" -U "$M_USER" -d "$M_DB" -c "SELECT count(*) FROM receipts")
MSG="$COUNT Bons auf $M_HOST gespiegelt."
if [ "$NOTIFY_ON_SUCCESS" = "yes" ]; then
  notify normal "Tankbon-Spiegel aktualisiert" "$MSG"
else
  echo "$MSG"
fi
