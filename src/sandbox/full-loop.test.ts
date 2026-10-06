import { afterEach, describe, expect, test } from "bun:test";
import { startLineAgentServer } from "../bun-server";
import { loadConfig } from "../config";
import { createWhatsAppSignature } from "../whatsapp/signature";
import { createSandboxMockHandler, createSandboxState } from "./mock-services";

const servers: Bun.Server<undefined>[] = [];

afterEach(() => {
	for (const server of servers.splice(0)) {
		server.stop(true);
	}
});

describe("local sandbox full loop", () => {
	test("signs a LINE webhook and completes OpenAI, GitHub, and LINE reply mocks", async () => {
		const state = createSandboxState();
		const channelSecret = "sandbox-secret";
		let appOrigin = "";
		const mockServer = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: createSandboxMockHandler({
				state,
				channelSecret,
				getAppOrigin: () => appOrigin,
			}),
		});
		servers.push(mockServer);
		const mockOrigin = `http://127.0.0.1:${mockServer.port}`;
		const config = loadConfig({
			PORT: "0",
			LINE_CHANNEL_SECRET: channelSecret,
			LINE_CHANNEL_ACCESS_TOKEN: "line-token",
			LINE_API_BASE_URL: `${mockOrigin}/line`,
			OPENAI_API_KEY: "openai-key",
			OPENAI_BASE_URL: `${mockOrigin}/openai`,
			OPENAI_MODEL: "sandbox-model",
			GITHUB_OWNER: "sandbox",
			GITHUB_REPO: "repo",
			GITHUB_TOKEN: "github-token",
			GITHUB_API_BASE_URL: `${mockOrigin}/github`,
		});
		const appServer = startLineAgentServer(config, { hostname: "127.0.0.1" });
		servers.push(appServer);
		appOrigin = `http://127.0.0.1:${appServer.port}`;

		const pageResponse = await fetch(mockOrigin);
		const page = await pageResponse.text();
		expect(pageResponse.status).toBe(200);
		expect(page).toContain("LINE Coding Agent Sandbox");
		expect(page).toContain('id="question"');
		expect(page).toContain('id="use-memory"');
		expect(pageResponse.headers.get("content-security-policy")).toContain(
			"default-src 'self'",
		);
		const pageScript = page.match(/<script>([\s\S]*)<\/script>/)?.[1];
		expect(pageScript).toBeDefined();
		expect(() => new Function(pageScript ?? "")).not.toThrow();

		const response = await fetch(`${mockOrigin}/sandbox/send`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "why does login fail?" }),
		});
		const result = (await response.json()) as {
			ok: boolean;
			status: number;
			lineReplies: { messages: { text: string }[] }[];
			responseRequestCount: number;
			githubRequests: string[];
		};

		expect(response.status).toBe(200);
		expect(result.ok).toBe(true);
		expect(result.status).toBe(200);
		expect(result.responseRequestCount).toBe(3);
		expect(
			result.githubRequests.some((path) =>
				path.startsWith("/github/repos/sandbox/repo/tarball/main"),
			),
		).toBe(true);
		expect(
			result.githubRequests.includes(
				"/github/repos/sandbox/repo/contents/src/auth/login.ts?ref=main",
			),
		).toBe(true);
		expect(result.lineReplies).toHaveLength(1);
		expect(result.lineReplies[0]?.messages[0]?.text).toContain(
			"Sandbox full loop OK",
		);
		expect(state.responsesRequests).toHaveLength(3);
	});

	test("completes the full loop from Telegram webhook to Telegram reply", async () => {
		const state = createSandboxState();
		let appOrigin = "";
		const mockServer = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: createSandboxMockHandler({
				state,
				channelSecret: "unused-line-secret",
				getAppOrigin: () => appOrigin,
			}),
		});
		servers.push(mockServer);
		const mockOrigin = `http://127.0.0.1:${mockServer.port}`;
		const config = loadConfig({
			PORT: "0",
			TELEGRAM_BOT_TOKEN: "telegram-token",
			TELEGRAM_WEBHOOK_SECRET: "telegram-secret",
			TELEGRAM_ALLOWED_USER_IDS: "1001",
			TELEGRAM_API_BASE_URL: `${mockOrigin}/telegram`,
			OPENAI_API_KEY: "openai-key",
			OPENAI_BASE_URL: `${mockOrigin}/openai`,
			OPENAI_MODEL: "sandbox-model",
			GITHUB_OWNER: "sandbox",
			GITHUB_REPO: "repo",
			GITHUB_TOKEN: "github-token",
			GITHUB_API_BASE_URL: `${mockOrigin}/github`,
		});
		const appServer = startLineAgentServer(config, { hostname: "127.0.0.1" });
		servers.push(appServer);
		appOrigin = `http://127.0.0.1:${appServer.port}`;

		const response = await fetch(`${appOrigin}/telegram/webhook`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Telegram-Bot-Api-Secret-Token": "telegram-secret",
			},
			body: JSON.stringify({
				message: {
					message_id: 42,
					text: "repo: sandbox/repo\nbranch: main\nwhy does login fail?",
					from: { id: 1001 },
					chat: { id: 1001 },
				},
			}),
		});

		expect(response.status).toBe(200);
		expect(state.responsesRequests).toHaveLength(3);
		expect(state.githubRequests).toContain(
			"/github/repos/sandbox/repo/contents/src/auth/login.ts?ref=main",
		);
		expect(state.telegramReplies).toHaveLength(1);
		expect(state.telegramReplies[0]).toMatchObject({
			chat_id: 1001,
			reply_parameters: { message_id: 42 },
		});
	});

	test("completes the full loop from WhatsApp webhook to WhatsApp reply", async () => {
		const state = createSandboxState();
		let appOrigin = "";
		const mockServer = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: createSandboxMockHandler({
				state,
				channelSecret: "unused-line-secret",
				getAppOrigin: () => appOrigin,
			}),
		});
		servers.push(mockServer);
		const mockOrigin = `http://127.0.0.1:${mockServer.port}`;
		const config = loadConfig({
			PORT: "0",
			WHATSAPP_ACCESS_TOKEN: "whatsapp-token",
			WHATSAPP_PHONE_NUMBER_ID: "phone-id",
			WHATSAPP_VERIFY_TOKEN: "verify-token",
			WHATSAPP_APP_SECRET: "app-secret",
			WHATSAPP_API_BASE_URL: `${mockOrigin}/whatsapp/v26.0`,
			OPENAI_API_KEY: "openai-key",
			OPENAI_BASE_URL: `${mockOrigin}/openai`,
			OPENAI_MODEL: "sandbox-model",
			GITHUB_OWNER: "sandbox",
			GITHUB_REPO: "repo",
			GITHUB_TOKEN: "github-token",
			GITHUB_API_BASE_URL: `${mockOrigin}/github`,
		});
		const appServer = startLineAgentServer(config, { hostname: "127.0.0.1" });
		servers.push(appServer);
		appOrigin = `http://127.0.0.1:${appServer.port}`;
		const rawBody = JSON.stringify({
			entry: [
				{
					changes: [
						{
							field: "messages",
							value: {
								messages: [
									{
										from: "66812345678",
										id: "wamid.inbound",
										type: "text",
										text: { body: "why does login fail?" },
									},
								],
							},
						},
					],
				},
			],
		});

		const response = await fetch(`${appOrigin}/whatsapp/webhook`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Hub-Signature-256": createWhatsAppSignature(rawBody, "app-secret"),
			},
			body: rawBody,
		});

		expect(response.status).toBe(200);
		expect(state.responsesRequests).toHaveLength(3);
		expect(state.githubRequests).toContain(
			"/github/repos/sandbox/repo/contents/src/auth/login.ts?ref=main",
		);
		expect(state.whatsAppReplies).toHaveLength(1);
		expect(state.whatsAppReplies[0]).toMatchObject({
			messaging_product: "whatsapp",
			to: "66812345678",
			context: { message_id: "wamid.inbound" },
		});
	});
});
