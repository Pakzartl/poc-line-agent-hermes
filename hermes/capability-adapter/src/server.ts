import { timingSafeEqual } from "node:crypto";
import {
	loadCapabilityAdapterConfig,
	type CapabilityAdapterConfig,
} from "./config";
import { renderScreenshot, type ScreenshotRenderer } from "./renderer";

const maxRequestBytes = 8_192;

export function createCapabilityAdapterHandler(input: {
	config: CapabilityAdapterConfig;
	render?: ScreenshotRenderer;
}): (request: Request) => Promise<Response> {
	const render = input.render ?? renderScreenshot;
	return async (request) => {
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/health") {
			return Response.json({ ok: true, service: "capability-adapter" });
		}
		if (request.method !== "POST" || url.pathname !== "/artifact/render") {
			return Response.json({ error: "not found" }, { status: 404 });
		}
		if (!authorized(request.headers.get("authorization"), input.config.token)) {
			return Response.json({ error: "unauthorized" }, { status: 401 });
		}
		const contentLength = Number(request.headers.get("content-length") ?? "0");
		if (contentLength > maxRequestBytes) {
			return Response.json({ error: "payload too large" }, { status: 413 });
		}
		const rawBody = await request.text();
		if (new TextEncoder().encode(rawBody).byteLength > maxRequestBytes) {
			return Response.json({ error: "payload too large" }, { status: 413 });
		}
		let body: unknown;
		try {
			body = JSON.parse(rawBody) as unknown;
		} catch {
			return Response.json({ error: "invalid JSON" }, { status: 400 });
		}
		const targetId =
			body && typeof body === "object"
				? (body as Record<string, unknown>).targetId
				: undefined;
		if (typeof targetId !== "string") {
			return Response.json({ error: "targetId is required" }, { status: 400 });
		}
		const target = input.config.artifactTargets.find(
			(candidate) => candidate.id === targetId,
		);
		if (!target) {
			return Response.json(
				{ error: "artifact target is not allowlisted" },
				{ status: 404 },
			);
		}
		try {
			const image = await render(target.url);
			return new Response(image, {
				headers: {
					"Content-Type": "image/png",
					"Cache-Control": "no-store",
					"X-Content-Type-Options": "nosniff",
				},
			});
		} catch (error) {
			console.error(
				JSON.stringify({
					message: "artifact render failed",
					targetId,
					error: error instanceof Error ? error.message : "unknown error",
				}),
			);
			return Response.json(
				{ error: "artifact render failed" },
				{ status: 502 },
			);
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

if (import.meta.main) {
	const config = loadCapabilityAdapterConfig(Bun.env);
	const handler = createCapabilityAdapterHandler({ config });
	Bun.serve({
		hostname: "0.0.0.0",
		port: config.port,
		fetch: handler,
	});
	console.log(
		JSON.stringify({
			message: "capability adapter started",
			port: config.port,
			artifactTargets: config.artifactTargets.map((target) => target.id),
		}),
	);
}
