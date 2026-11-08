FROM python:3.11-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONPATH=/app/contracts
WORKDIR /app
COPY service-b/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && useradd --create-home app
COPY contracts /app/contracts
COPY service-b/worker /app/worker
USER app
CMD ["python", "-m", "worker.main"]
