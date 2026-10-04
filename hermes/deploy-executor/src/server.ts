import { timingSafeEqual } from "node:crypto";
import { loadDeployExecutorConfig, type DeployExecutorConfig } from "./config";
import {
	DeployConflictError,
	DeployInputError,
	deployWithIdempotency,
	type CommandRunner,
	type DeployRequest,
} from "./deployer";

const maxRequestBytes = 8_192;

export function createDeployExecutorHandler(input: {
	config: DeployExecutorConfig;
	run?: CommandRunner;
}): (request: Request) => Promise<Response> {
	return async (request) => {
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/health") {
			return Response.json({ ok: true, service: "deploy-executor" });
		}
		if (request.method !== "POST" || url.pathname !== "/deploy") {
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
		let parsed: unknown;
		try {
			parsed = JSON.parse(rawBody) as unknown;
		} catch {
			return Response.json({ error: "invalid JSON" }, { status: 400 });
		}
		const deployRequest = toDeployRequest(
			parsed,
			request.headers.get("idempotency-key"),
		);
		if (!deployRequest) {
			return Response.json(
				{ error: "invalid deploy request" },
				{ status: 400 },
			);
		}
		try {
			const result = await deployWithIdempotency({
				config: input.config,
				request: deployRequest,
				run: input.run,
			});
			return Response.json(
				{
					executionId: result.artifact.id,
					status: result.artifact.status,
					replayed: result.replayed,
					artifact: result.artifact,
				},
				{ status: result.artifact.status === "succeeded" ? 200 : 502 },
			);
		} catch (error) {
			if (error instanceof DeployInputError) {
				return Response.json({ error: error.message }, { status: 400 });
			}
			if (error instanceof DeployConflictError) {
				return Response.json({ error: error.message }, { status: 409 });
			}
			console.error(
				JSON.stringify({
					message: "deploy executor failed",
					error: error instanceof Error ? error.message : "unknown error",
				}),
			);
			return Response.json(
				{ error: "deploy executor failed" },
				{ status: 500 },
			);
		}
	};
}

function toDeployRequest(
	value: unknown,
	idempotencyKey: string | null,
): DeployRequest | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	if (
		record.version !== "DEPLOY_PLAN_V1" ||
		typeof record.repository !== "string" ||
		!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(record.repository) ||
		typeof record.targetId !== "string" ||
		typeof record.commitSha !== "string" ||
		typeof record.digest !== "string" ||
		!/^[0-9a-f]{64}$/.test(record.digest) ||
		typeof record.requestedBy !== "string" ||
		typeof record.approvedBy !== "string" ||
		!idempotencyKey
	) {
		return null;
	}
	return {
		repo: `https://github.com/${record.repository}.git`,
		target: record.targetId,
		sha: record.commitSha,
		idempotencyKey,
		requestedBy: record.requestedBy,
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
	const config = loadDeployExecutorConfig(Bun.env);
	const handler = createDeployExecutorHandler({ config });
	Bun.serve({
		hostname: "127.0.0.1",
		port: config.port,
		fetch: handler,
	});
	console.log(
		JSON.stringify({
			message: "deploy executor started",
			port: config.port,
			targets: config.targets.map((target) => target.id),
		}),
	);
}
