FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080 \
    CARDWELL_DATA_DIR=/data

WORKDIR /app

COPY index.html styles.css app.js server.py ./

RUN useradd --create-home --uid 10001 cardwell \
    && mkdir -p /data \
    && chown -R cardwell:cardwell /app /data

USER cardwell

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD python -c "import json, urllib.request; json.load(urllib.request.urlopen('http://127.0.0.1:8080/api/health', timeout=2))"

CMD ["python", "server.py"]
