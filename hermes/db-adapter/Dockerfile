FROM oven/bun:1.3.14-debian

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates postgresql-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY src ./src
COPY verify-readonly-role.sh ./verify-readonly-role.sh

USER bun
EXPOSE 8789

CMD ["bun", "run", "src/server.ts"]
