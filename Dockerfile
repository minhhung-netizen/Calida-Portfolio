FROM node:22-bookworm-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    NODE_ENV=production \
    PATH="/opt/venv/bin:$PATH" \
    PYTHON_BIN=python3

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv python3-pip ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY pipeline/requirements.txt ./pipeline/requirements.txt
RUN python3 -m venv /opt/venv \
    && pip install --no-cache-dir -r pipeline/requirements.txt

COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev

COPY pipeline ./pipeline
COPY web ./web
COPY data ./seed-data
COPY server/index.js ./server/index.js
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /app/data /app/secrets

EXPOSE 8080

CMD ["/usr/local/bin/docker-entrypoint.sh"]
