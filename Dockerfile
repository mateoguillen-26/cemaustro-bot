FROM node:20-slim

# better-sqlite3 se compila al instalar: hacen falta las herramientas de build.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

# La base tiene que vivir en un volumen montado en /app/data, o se pierde en
# cada despliegue. El volumen NO se declara aquí: Railway lo rechaza y quiere
# gestionarlo desde su panel. Con Docker a secas se monta al arrancar:
#   docker run -v $(pwd)/data:/app/data ...
RUN mkdir -p /app/data

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/index.js"]
