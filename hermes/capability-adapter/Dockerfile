FROM oven/bun:1.3.14-debian

RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium-headless-shell ca-certificates fonts-noto-color-emoji fonts-thai-tlwg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY src ./src

USER bun
EXPOSE 8788

CMD ["bun", "run", "src/server.ts"]
