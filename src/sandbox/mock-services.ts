import { Buffer } from "node:buffer";
import { createLineSignature } from "../line/signature";
import { sandboxPage } from "./page";

export type SandboxState = {
	responsesRequests: unknown[];
	githubRequests: string[];
	lineReplies: unknown[];
	telegramReplies: unknown[];
	whatsAppReplies: unknown[];
	webhookResults: unknown[];
};

export type SandboxMockOptions = {
	state: SandboxState;
	channelSecret: string;
	getAppOrigin: () => string;
	providerMode?: "mock" | "live";
	repository?: string;
	resetSessionMemory?: () => Promise<void>;
};

export function createSandboxState(): SandboxState {
	return {
		responsesRequests: [],
		githubRequests: [],
		lineReplies: [],
		telegramReplies: [],
		whatsAppReplies: [],
		webhookResults: [],
	};
}

export function createSandboxMockHandler(
	options: SandboxMockOptions,
): (request: Request) => Promise<Response> {
	return async (request) => {
		const url = new URL(request.url);

		if (request.method === "GET" && url.pathname === "/") {
			return sandboxPage({
				providerMode: options.providerMode ?? "mock",
				repository: options.repository ?? "sandbox/repo",
			});
		}

		if (request.method === "GET" && url.pathname === "/health") {
			return Response.json({
				ok: true,
				providerMode: options.providerMode ?? "mock",
				repository: options.repository ?? "sandbox/repo",
			});
		}

		if (request.method === "POST" && url.pathname === "/openai/responses") {
			return handleOpenAiResponses(request, options.state);
		}

		if (url.pathname.startsWith("/github/")) {
			return handleGitHub(url, options.state);
		}

		if (
			request.method === "POST" &&
			url.pathname === "/line/v2/bot/message/reply"
		) {
			const body = await request.json();
			options.state.lineReplies.push(body);
			return Response.json({});
		}

		if (
			request.method === "POST" &&
			/^\/telegram\/bot[^/]+\/sendMessage$/.test(url.pathname)
		) {
			options.state.telegramReplies.push(await request.json());
			return Response.json({ ok: true });
		}

		if (
			request.method === "POST" &&
			/^\/telegram\/bot[^/]+\/sendChatAction$/.test(url.pathname)
		) {
			return Response.json({ ok: true });
		}

		if (
			request.method === "POST" &&
			/^\/whatsapp\/v[^/]+\/[^/]+\/messages$/.test(url.pathname)
		) {
			options.state.whatsAppReplies.push(await request.json());
			return Response.json({ messages: [{ id: "wamid.sandbox" }] });
		}

		if (request.method === "POST" && url.pathname === "/sandbox/send") {
			return sendSandboxWebhook(request, options);
		}

		if (request.method === "GET" && url.pathname === "/sandbox/traces") {
			return Response.json(options.state);
		}

		if (request.method === "POST" && url.pathname === "/sandbox/reset") {
			await options.resetSessionMemory?.();
			resetState(options.state);
			return Response.json({ ok: true });
		}

		return new Response("not found", { status: 404 });
	};
}

async function handleOpenAiResponses(
	request: Request,
	state: SandboxState,
): Promise<Response> {
	const body = (await request.json()) as { input?: unknown[] };
	state.responsesRequests.push(body);
	const outputs = (body.input ?? []).filter(isFunctionCallOutput);

	if (outputs.length === 0) {
		return Response.json({
			id: "resp-sandbox-search",
			output: [
				{
					type: "function_call",
					call_id: "call-search-code",
					name: "search_code",
					arguments: JSON.stringify({
						repository: "sandbox/repo",
						query: "login error",
						branch: "main",
					}),
				},
			],
		});
	}

	if (outputs.length === 1) {
		return Response.json({
			id: "resp-sandbox-read",
			output: [
				{
					type: "function_call",
					call_id: "call-read-file",
					name: "read_file",
					arguments: JSON.stringify({
						repository: "sandbox/repo",
						path: "src/auth/login.ts",
						branch: "main",
					}),
				},
			],
		});
	}

	return Response.json({
		id: "resp-sandbox-final",
		output_text:
			"Sandbox full loop OK: searched code, read src/auth/login.ts, and replied through the configured messaging channel.",
		output: [
			{
				type: "message",
				content: [
					{
						type: "output_text",
						text: "Sandbox full loop OK: searched code, read src/auth/login.ts, and replied through the configured messaging channel.",
					},
				],
			},
		],
	});
}

function handleGitHub(url: URL, state: SandboxState): Response {
	state.githubRequests.push(`${url.pathname}${url.search}`);

	if (url.pathname === "/github/repos/sandbox/repo/tarball/main") {
		return tarGzipResponse({
			"sandbox-repo/src/auth/login.ts": sandboxFileContent,
		});
	}

	if (
		url.pathname === "/github/repos/sandbox/repo/contents/src/auth/login.ts"
	) {
		return Response.json({
			path: "src/auth/login.ts",
			size: sandboxFileContent.length,
			encoding: "base64",
			content: Buffer.from(sandboxFileContent, "utf8").toString("base64"),
		});
	}

	return Response.json({ message: "not found" }, { status: 404 });
}

function tarGzipResponse(files: Record<string, string>): Response {
	const entries = Object.entries(files).flatMap(([path, content]) => {
		const body = new TextEncoder().encode(content);
		const header = new Uint8Array(512);
		writeTarText(header, 0, 100, path);
		writeTarText(
			header,
			124,
			12,
			`${body.byteLength.toString(8).padStart(11, "0")}\0`,
		);
		header[156] = "0".charCodeAt(0);
		return [
			header,
			body,
			new Uint8Array((512 - (body.byteLength % 512)) % 512),
		];
	});
	entries.push(new Uint8Array(1024));
	const tar = new Uint8Array(
		entries.reduce((total, entry) => total + entry.byteLength, 0),
	);
	let offset = 0;
	for (const entry of entries) {
		tar.set(entry, offset);
		offset += entry.byteLength;
	}
	return new Response(Bun.gzipSync(tar), {
		headers: { "Content-Type": "application/x-gzip" },
	});
}

function writeTarText(
	target: Uint8Array,
	offset: number,
	length: number,
	value: string,
): void {
	target.set(new TextEncoder().encode(value).slice(0, length), offset);
}

async function sendSandboxWebhook(
	request: Request,
	options: SandboxMockOptions,
): Promise<Response> {
	const appOrigin = options.getAppOrigin();
	if (!appOrigin) {
		return Response.json(
			{ ok: false, error: "app server is not ready" },
			{ status: 503 },
		);
	}

	const body = (await readOptionalJson(request)) as {
		text?: string;
		replyToken?: string;
		useMemory?: boolean;
	};
	const rawBody = JSON.stringify({
		events: [
			{
				type: "message",
				replyToken: body.replyToken ?? "sandbox-reply-token",
				source: { type: "user", userId: "sandbox-user" },
				memoryEnabled: body.useMemory === true,
				message: {
					type: "text",
					text: body.text ?? "why does login fail?",
				},
			},
		],
	});
	const response = await fetch(`${appOrigin}/line/webhook`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-line-signature": createLineSignature(rawBody, options.channelSecret),
		},
		body: rawBody,
	});
	const result = {
		ok: response.ok,
		status: response.status,
		body: await response.text(),
		providerMode: options.providerMode ?? "mock",
		repository: options.repository ?? "sandbox/repo",
		memoryEnabled: body.useMemory === true,
		lineReplies: options.state.lineReplies,
		responseRequestCount: options.state.responsesRequests.length,
		githubRequests: options.state.githubRequests,
	};
	options.state.webhookResults.push(result);

	return Response.json(result, { status: response.ok ? 200 : 502 });
}

async function readOptionalJson(request: Request): Promise<unknown> {
	const text = await request.text();
	if (!text) {
		return {};
	}

	return JSON.parse(text);
}

function resetState(state: SandboxState): void {
	state.responsesRequests.length = 0;
	state.githubRequests.length = 0;
	state.lineReplies.length = 0;
	state.telegramReplies.length = 0;
	state.whatsAppReplies.length = 0;
	state.webhookResults.length = 0;
}

function isFunctionCallOutput(
	value: unknown,
): value is { type: "function_call_output" } {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		value.type === "function_call_output"
	);
}

const sandboxFileContent = [
	"export function login(username: string, password: string) {",
	"	if (!username || !password) {",
	'		throw new Error("missing credentials");',
	"	}",
	'	return { ok: true, source: "sandbox" };',
	"}",
].join("\n");
