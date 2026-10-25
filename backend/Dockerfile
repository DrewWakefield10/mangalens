FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONPATH=/app/backend
RUN apt-get update && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-jpn tesseract-ocr-jpn-vert tesseract-ocr-kor tesseract-ocr-chi-sim tesseract-ocr-chi-tra tesseract-ocr-rus libgomp1 libraqm0 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY backend/requirements.txt /app/backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt
COPY backend /app/backend
COPY scripts /app/scripts
COPY assets /app/assets
RUN useradd --uid 10001 --create-home mangalens && mkdir -p /app/data /app/models && chown -R mangalens:mangalens /app
USER mangalens
WORKDIR /app/backend
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
