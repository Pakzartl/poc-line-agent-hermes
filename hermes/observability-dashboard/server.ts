import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const host = "127.0.0.1";
const port = parsePort(Bun.env.OBSERVABILITY_DASHBOARD_PORT ?? "8791");
const username = requireValue("OBSERVABILITY_DASHBOARD_USERNAME");
const password = requireValue("OBSERVABILITY_DASHBOARD_PASSWORD", 24);
const snapshotPath =
	Bun.env.OBSERVABILITY_SNAPSHOT_PATH ??
	"/srv/hermes/observability/snapshot.json";
const assetsDir = Bun.env.OBSERVABILITY_ASSETS_DIR ?? import.meta.dir;

const assets = new Map([
	["/ops/", asset("index.html", "text/html; charset=utf-8")],
	["/ops/styles.css", asset("styles.css", "text/css; charset=utf-8")],
	["/ops/app.js", asset("app.js", "application/javascript; charset=utf-8")],
]);
const expectedAuthorization = Buffer.from(
	`Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
);

const server = Bun.serve({
	hostname: host,
	port,
	fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/health") {
			return Response.json({ ok: true });
		}
		if (!authorized(request.headers.get("authorization"))) {
			return new Response("Authentication required", {
				status: 401,
				headers: {
					"Cache-Control": "no-store",
					"WWW-Authenticate":
						'Basic realm="Javis OVH observability", charset="UTF-8"',
				},
			});
		}
		if (request.method !== "GET" && request.method !== "HEAD") {
			return new Response("Method not allowed", { status: 405 });
		}
		if (url.pathname === "/ops") {
			return Response.redirect(`${url.origin}/ops/`, 308);
		}
		if (url.pathname === "/ops/api/snapshot") {
			try {
				return new Response(readFileSync(snapshotPath), {
					headers: responseHeaders("application/json; charset=utf-8"),
				});
			} catch {
				return Response.json(
					{ error: "snapshot unavailable" },
					{ status: 503, headers: { "Cache-Control": "no-store" } },
				);
			}
		}
		const staticAsset = assets.get(url.pathname);
		if (!staticAsset) {
			return new Response("Not found", { status: 404 });
		}
		return new Response(request.method === "HEAD" ? null : staticAsset.body, {
			headers: responseHeaders(staticAsset.contentType),
		});
	},
});

console.log(`OVH observability dashboard listening on ${server.url}`);

function asset(filename: string, contentType: string) {
	return { body: readFileSync(join(assetsDir, filename)), contentType };
}

function authorized(value: string | null): boolean {
	if (!value) return false;
	const received = Buffer.from(value);
	return (
		received.length === expectedAuthorization.length &&
		timingSafeEqual(received, expectedAuthorization)
	);
}

function responseHeaders(contentType: string): HeadersInit {
	return {
		"Cache-Control": "no-store",
		"Content-Security-Policy":
			"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
		"Content-Type": contentType,
		"Referrer-Policy": "no-referrer",
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options": "DENY",
	};
}

function requireValue(name: string, minimumLength = 1): string {
	const value = Bun.env[name]?.trim() ?? "";
	if (value.length < minimumLength) {
		throw new Error(
			`${name} must contain at least ${minimumLength} characters`,
		);
	}
	return value;
}

function parsePort(value: string): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65_535) {
		throw new Error(
			"OBSERVABILITY_DASHBOARD_PORT must be between 1024 and 65535",
		);
	}
	return parsed;
}
