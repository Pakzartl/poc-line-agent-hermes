import { timingSafeEqual } from "node:crypto";
import { loadDbAdapterConfig, type DbAdapterConfig } from "./config";
import { executeWithPsql, type DbExecutor } from "./executor";
import { validateDbReadRequest } from "./policy";

const maxRequestBytes = 32_768;

export function createDbAdapterHandler(input: {
	config: DbAdapterConfig;
	execute?: DbExecutor;
	env?: Readonly<Record<string, string | undefined>>;
}): (request: Request) => Promise<Response> {
	const execute = input.execute ?? executeWithPsql;
	const env = input.env ?? Bun.env;
	return async (request) => {
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/health") {
			return Response.json({
				ok: true,
				service: "db-adapter",
			});
		}
		if (request.method !== "POST" || url.pathname !== "/db/query") {
			return Response.json({ error: "not found" }, { status: 404 });
		}
		if (!authorized(request.headers.get("authorization"), input.config.token)) {
			return Response.json({ error: "unauthorized" }, { status: 401 });
		}
		const rawBody = await boundedText(request);
		if (!rawBody.ok) {
			return Response.json(
				{ error: rawBody.reason },
				{ status: rawBody.status },
			);
		}
		let body: unknown;
		try {
			body = JSON.parse(rawBody.body) as unknown;
		} catch {
			return Response.json({ error: "invalid JSON" }, { status: 400 });
		}
		const validation = validateDbReadRequest(body, {
			datasources: input.config.datasources.map((item) => item.alias),
			...input.config.limits,
		});
		if (!validation.ok) {
			return Response.json(
				{ error: validation.reason },
				{ status: validation.status },
			);
		}
		const datasource = input.config.datasources.find(
			(item) => item.alias === validation.query.datasource,
		);
		if (!datasource) {
			return Response.json(
				{ error: "datasource is not configured" },
				{ status: 404 },
			);
		}
		try {
			const result = await execute({
				query: validation.query,
				datasource,
				env,
			});
			const rows = result.rows.slice(0, validation.query.limits.maxRows);
			const encodedBytes = new TextEncoder().encode(
				JSON.stringify(rows),
			).byteLength;
			if (encodedBytes > validation.query.limits.maxBytes) {
				return Response.json(
					{ error: "database response exceeds byte limit" },
					{ status: 502 },
				);
			}
			return Response.json(
				{
					rows,
					columns: [...new Set(rows.flatMap((row) => Object.keys(row)))],
					rowCount: rows.length,
					truncated:
						result.truncated === true || result.rows.length > rows.length,
					fingerprint: validation.query.fingerprint,
				},
				{
					headers: {
						"Cache-Control": "no-store",
						"X-Content-Type-Options": "nosniff",
					},
				},
			);
		} catch (error) {
			console.error(
				JSON.stringify({
					message: "db adapter query failed",
					datasource: validation.query.datasource,
					requestId: validation.query.requestId,
					fingerprint: validation.query.fingerprint,
					error: error instanceof Error ? error.message : "unknown error",
				}),
			);
			return Response.json({ error: "database query failed" }, { status: 502 });
		}
	};
}

function authorized(header: string | null, expectedToken: string): boolean {
	const prefix = "Bearer ";
	if (!header?.startsWith(prefix)) return false;
	const actual = Buffer.from(header.slice(prefix.length));
	const expected = Buffer.from(expectedToken);
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function boundedText(
	request: Request,
): Promise<
	{ ok: true; body: string } | { ok: false; status: number; reason: string }
> {
	const contentLength = Number(request.headers.get("content-length") ?? "0");
	if (contentLength > maxRequestBytes) {
		return { ok: false, status: 413, reason: "payload too large" };
	}
	const body = await request.text();
	if (new TextEncoder().encode(body).byteLength > maxRequestBytes) {
		return { ok: false, status: 413, reason: "payload too large" };
	}
	return { ok: true, body };
}

if (import.meta.main) {
	const config = loadDbAdapterConfig(Bun.env);
	const handler = createDbAdapterHandler({ config });
	Bun.serve({
		hostname: "0.0.0.0",
		port: config.port,
		fetch: handler,
	});
	console.log(
		JSON.stringify({
			message: "db adapter started",
			port: config.port,
			datasources: config.datasources.map((item) => item.alias),
		}),
	);
}
