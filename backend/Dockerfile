FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.12 /uv /usr/local/bin/uv

WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY app ./app

ENV PATH="/app/.venv/bin:$PATH" \
    DATABASE_URL=sqlite:////data/flags.db
RUN mkdir -p /data
EXPOSE 8000
CMD ["fastapi", "run", "app/main.py", "--port", "8000"]
