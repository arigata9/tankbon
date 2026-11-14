# Tankbons

Web-App zum Erfassen von Tankstellen-Kassenbons. Auf dem iPad wird der Bon mit dem
**eingebauten Dokumentenscanner von iPadOS** gescannt und dort per Live-Text erkannt.
Die App liest **Betrag, Liter, Preis pro Liter, Datum und Tankstelle** (plus Kraftstoffsorte)
aus und speichert alles in PostgreSQL.

- Node.js 22, Express, PostgreSQL 16
- Frontend ohne Build-Schritt (HTML/CSS/JS), für das iPad optimiert, Hell-/Dunkelmodus
- Läuft komplett in Docker (`app` + `db`)

## Start

```bash
cp .env.example .env    # Passwort usw. anpassen
docker compose up -d --build
```

Die App läuft dann auf `http://<server-ip>:3000`. Die Tabelle wird beim Start automatisch angelegt.

Eine bestehende, externe PostgreSQL-Instanz lässt sich nutzen, indem man im Service `app`
`DATABASE_URL` darauf zeigen lässt und den Service `db` entfernt.

## Warum ein Kurzbefehl?

Safari lässt Webseiten nicht direkt auf den Dokumentenscanner (VisionKit) zugreifen – eine
Webseite bekommt nur die normale Kamera. Der Kurzbefehl schließt diese Lücke:

1. Der Button **Bon scannen** startet den Kurzbefehl `Tankbon scannen`.
2. Der Kurzbefehl öffnet den Dokumentenscanner (Kantenerkennung, Entzerrung, Kontrast).
3. Die Texterkennung passiert auf dem iPad (Apple Vision, sehr zuverlässig bei Bons).
4. Bild und Text werden an `POST /api/scans` geschickt, der Server liest die Werte aus.
5. Safari öffnet den Bon zur Prüfung; nach **Speichern** ist er erfasst.

Die genaue Anleitung zum Anlegen steht in der App unter **Einstellungen (Zahnrad)**.

Alternativ geht **Foto hochladen**: dann übernimmt der Server die Texterkennung
(Tesseract, deutsche Sprachdaten sind im Image enthalten).

## Konfiguration (`.env`)

| Variable | Bedeutung |
| --- | --- |
| `APP_PORT` | Port auf dem Host (Standard 3000) |
| `PUBLIC_URL` | Externe Adresse, z. B. `https://tank.example.de`; leer = automatisch |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | Zugangsdaten der Datenbank |
| `SHORTCUT_NAME` | Name des Kurzbefehls (Standard `Tankbon scannen`) |
| `AUTH_USER` / `AUTH_PASSWORD` | Optionaler Passwortschutz (HTTP Basic Auth) |

Mit Passwortschutz braucht der Kurzbefehl bei „Inhalte von URL abrufen“ zusätzlich den
Header `Authorization: Basic <base64 von benutzer:passwort>`.

## API

| Methode | Pfad | Zweck |
| --- | --- | --- |
| `POST` | `/api/scans` | Multipart: `image` (Datei) und/oder `text` → Entwurf mit erkannten Werten |
| `GET` | `/api/receipts?status=&year=` | Liste |
| `GET/PUT/DELETE` | `/api/receipts/:id` | Einzelner Bon |
| `GET` | `/api/receipts/:id/image` | Gescanntes Bild |
| `POST` | `/api/receipts` | Manuell erfassen |
| `GET` | `/api/stats?year=` | Kennzahlen |
| `GET` | `/api/export.csv` | CSV-Export (Excel-kompatibel, deutsches Format) |

## Sichern und Umziehen

Alle Daten – Bons, gescannte Bilder und Einstellungen – liegen in der Datenbank.
Ein Dump enthält also alles. Befehle im Projektordner ausführen; `tankbon` ist der
Datenbank-Benutzer bzw. -Name aus `.env` (`POSTGRES_USER` / `POSTGRES_DB`).

**Export** (alter Host):

```bash
docker compose exec -T db pg_dump -U tankbon -d tankbon -Fc > tankbon.dump
```

**Import** (neuer Host, nach `git clone` und Kopieren der `.env`):

```bash
docker compose up -d db
docker compose exec -T db pg_restore -U tankbon -d tankbon --clean --if-exists --no-owner < tankbon.dump
docker compose up -d --build
```

`--clean --if-exists` ersetzt vorhandene Tabellen, der Import kann also gefahrlos
wiederholt werden. Der Dump ist unabhängig von der PostgreSQL-Version auf dem neuen Host
(gleich oder neuer).

Für regelmäßige Sicherungen eignet sich derselbe Export-Befehl, z. B. täglich per Cronjob
(unter Unraid mit dem Plugin „User Scripts“).

## Fehlersuche

**Es antwortet nichts auf dem Port**
- Die Portzuordnung muss `HOST:3000` lauten, z. B. `3009:3000` – im Container lauscht die App immer auf 3000.
- Prüfen: `docker compose ps` – steht beim Container `Restarting`, startet er in einer Schleife neu.

**Datenbankfehler**
Die App startet auch ohne Datenbank und zeigt den Grund direkt an:
`http://<server>:<port>/api/health` oder auf der Startseite.

- *Benutzername oder Passwort falsch*: Das Passwort aus `.env` wird nur beim **allerersten**
  Start in das Datenbank-Volume geschrieben. Wurde es danach geändert, entweder das alte
  Passwort wieder eintragen oder – solange noch keine Daten drin sind – das Volume neu anlegen:
  `docker compose down -v && docker compose up -d`.
- *Host nicht gefunden*: In `DATABASE_URL` muss als Host der Service-Name `db` stehen
  (bzw. die Adresse der externen Datenbank).

## Entwicklung

```bash
npm install
DATABASE_URL=postgres://tankbon:tankbon@localhost:5432/tankbon npm run dev
npm test   # Tests für den Bon-Parser
```
