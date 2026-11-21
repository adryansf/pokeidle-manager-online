# Estágio 1: compila o dashboard React/Vite (sem modo mock).
FROM node:20-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
ENV VITE_MOCK=""
RUN npm run build

# Estágio 2: bot Python + painel FastAPI (pronto para Dokploy / Docker Compose).
FROM python:3.12-slim
WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DATA_DIR=/data \
    DAILY_FILE=/data/daily_state.json \
    SESSION_FILE=/data/session_state.json \
    TELEMETRY_HOST=0.0.0.0 \
    TELEMETRY_PORT=8080 \
    TRUST_PROXY=1 \
    UPDATE_CHECK=0

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && mkdir -p /data

COPY *.py ./
COPY scripts/ ./scripts/
COPY --from=web /web/dist ./web_dist

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=3)" || exit 1

CMD ["python", "-u", "main.py"]
