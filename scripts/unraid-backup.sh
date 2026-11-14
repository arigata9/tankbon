#!/bin/bash
#
# Tägliche Sicherung der Tankbons-Datenbank für Unraid („User Scripts“-Plugin).
#
# Einrichtung: Settings → User Scripts → Add new script → Name z. B. „tankbon-backup“,
# als Inhalt (Einstellungen nach Bedarf anpassen):
#
#   #!/bin/bash
#   export BACKUP_DIR=/mnt/user/backups/tankbon
#   bash /boot/config/plugins/compose.manager/projects/tankbon/scripts/unraid-backup.sh
#
# Schedule „Custom“ mit z. B. „17 3 * * *“ (täglich 03:17 Uhr).
#
# Wiederherstellen (im Projektordner):
#   docker compose exec -T db pg_restore -U <user> -d <db> --clean --if-exists --no-owner < DATEI.dump

# ---------- Einstellungen (per Umgebungsvariable überschreibbar) ----------
# Ordner mit docker-compose.yml und .env – standardmäßig der Projektordner, in dem dieses Skript liegt
PROJECT_DIR="${PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BACKUP_DIR="${BACKUP_DIR:-/mnt/user/backups/tankbon}"  # Zielordner (Share, nicht der USB-Stick)
KEEP_DAYS="${KEEP_DAYS:-30}"                            # Sicherungen älter als X Tage löschen …
KEEP_MIN="${KEEP_MIN:-7}"                               # … aber immer mindestens so viele behalten
NOTIFY_ON_SUCCESS="${NOTIFY_ON_SUCCESS:-no}"            # yes = auch bei Erfolg benachrichtigen
# ---------------------------------------------------------------------------

set -uo pipefail

NOTIFY=/usr/local/emhttp/webGui/scripts/notify
notify() { # $1 = normal|warning|alert, $2 = Betreff, $3 = Text
  echo "$2: $3"
  [ -x "$NOTIFY" ] && "$NOTIFY" -e "Tankbon-Backup" -s "$2" -d "$3" -i "$1" >/dev/null 2>&1
  return 0
}
fail() { notify alert "Tankbon-Backup fehlgeschlagen" "$1"; rm -f "${TMP_FILE:-}"; exit 1; }

# Zugangsdaten aus .env lesen (ohne die Datei auszuführen); Standardwerte wie in docker-compose.yml
env_value() {
  local v
  v=$(grep -E "^$1=" "$PROJECT_DIR/.env" 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '\r"'"'")
  echo "${v:-$2}"
}
DB_USER=$(env_value POSTGRES_USER tankbon)
DB_NAME=$(env_value POSTGRES_DB tankbon)

# Datenbank-Container ermitteln
[ -f "$PROJECT_DIR/docker-compose.yml" ] || fail "Projektordner nicht gefunden: $PROJECT_DIR"
CONTAINER=$(cd "$PROJECT_DIR" && docker compose ps -q db 2>/dev/null)
[ -n "$CONTAINER" ] || fail "Datenbank-Container läuft nicht (docker compose ps -q db ist leer)"

mkdir -p "$BACKUP_DIR" || fail "Zielordner kann nicht angelegt werden: $BACKUP_DIR"

STAMP=$(date +%Y-%m-%d_%H%M)
FILE="$BACKUP_DIR/tankbon-$STAMP.dump"
TMP_FILE="$FILE.partial"

# Sichern – erst in eine temporäre Datei, damit nie eine halbe Sicherung liegen bleibt
docker exec "$CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc > "$TMP_FILE" \
  || fail "pg_dump ist fehlgeschlagen (Benutzer $DB_USER, Datenbank $DB_NAME)"
[ -s "$TMP_FILE" ] || fail "Die Sicherung ist leer"

# Prüfen, ob sich die Sicherung lesen lässt und die Tabelle mit den Bons enthält
CONTENTS=$(docker exec -i "$CONTAINER" pg_restore --list < "$TMP_FILE") \
  || fail "Die Sicherung lässt sich nicht lesen (beschädigt?)"
grep -q "TABLE DATA public receipts" <<< "$CONTENTS" \
  || fail "Die Sicherung enthält die Tabelle mit den Bons nicht"

mv "$TMP_FILE" "$FILE" || fail "Sicherung konnte nicht abgelegt werden: $FILE"
SIZE=$(du -h "$FILE" | cut -f1)

# Alte Sicherungen löschen – nur eigene Dateien, und immer mindestens KEEP_MIN behalten
DELETED=0
mapfile -t OLD < <(ls -1t "$BACKUP_DIR"/tankbon-*.dump 2>/dev/null | tail -n +$((KEEP_MIN + 1)))
for f in "${OLD[@]}"; do
  if [ -n "$(find "$f" -maxdepth 0 -mtime +"$KEEP_DAYS" 2>/dev/null)" ]; then
    rm -f -- "$f" && DELETED=$((DELETED + 1))
  fi
done
COUNT=$(ls -1 "$BACKUP_DIR"/tankbon-*.dump 2>/dev/null | wc -l)

MSG="$(basename "$FILE") ($SIZE) gespeichert, $COUNT Sicherungen vorhanden, $DELETED alte gelöscht."
if [ "$NOTIFY_ON_SUCCESS" = "yes" ]; then
  notify normal "Tankbon-Backup erfolgreich" "$MSG"
else
  echo "$MSG"
fi
