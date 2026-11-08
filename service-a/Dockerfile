FROM python:3.11-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONPATH=/app/contracts
WORKDIR /app
COPY service-a/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && useradd --create-home app && mkdir -p /data && chown app:app /data
COPY contracts /app/contracts
COPY service-a/api /app/api
USER app
CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--no-access-log"]
