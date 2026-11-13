FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

# poppler-utils: PDFs aus dem iOS-Dokumentenscanner lesen und rendern
RUN apt-get update \
  && apt-get install -y --no-install-recommends poppler-utils \
  && rm -rf /var/lib/apt/lists/*

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# --chown: Liegt das Projekt auf einem Dateisystem mit eingeschränkten Rechten
# (z. B. Unraid-USB-Stick unter /boot, FAT32 mit 0600), könnte der Benutzer "node"
# die Dateien sonst nicht lesen.
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
