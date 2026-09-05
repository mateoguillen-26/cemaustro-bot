FROM node:20-slim

# better-sqlite3 se compila al instalar: hacen falta las herramientas de build.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

# La base vive en un volumen para que no se pierda en cada despliegue.
RUN mkdir -p /app/data
VOLUME ["/app/data"]

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/index.js"]
