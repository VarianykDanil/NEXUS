# syntax=docker/dockerfile:1.7
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN groupadd --gid 10001 nexus \
    && useradd --uid 10001 --gid nexus --create-home --shell /usr/sbin/nologin nexus

WORKDIR /app
COPY pyproject.toml README.md ./
COPY src ./src
RUN --mount=type=cache,target=/root/.cache/pip python -m pip install '.[spot]'

USER nexus
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/v1/health', timeout=2)"

# The WebSocket implementation supplies its own RFC-compliant Date header.
# Disabling Uvicorn's additional header prevents duplicate handshake headers
# when the API is served through the Nginx edge proxy.
CMD ["uvicorn", "nexus_api.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-date-header"]
