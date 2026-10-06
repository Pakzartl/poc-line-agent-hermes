import { describe, expect, test } from "bun:test";
import { loadConfig } from "../config";
import type { SessionMemoryStore } from "../memory/types";
import { createWhatsAppReplyClient } from "./reply";
import { createWhatsAppSignature } from "./signature";
import { handleWhatsAppVerification, handleWhatsAppWebhook } from "./webhook";

const config = loadConfig({
	WHATSAPP_ACCESS_TOKEN: "access-token",
	WHATSAPP_PHONE_NUMBER_ID: "phone-id",
	WHATSAPP_VERIFY_TOKEN: "verify-token",
	WHATSAPP_APP_SECRET: "app-secret",
});

describe("WhatsApp webhook", () => {
	test("answers the Meta verification challenge", async () => {
		const response = handleWhatsAppVerification(
			new Request(
				"http://localhost/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=verify-token&hub.challenge=12345",
			),
			config,
		);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("12345");
	});

	test("verifies the signature, extracts text messages, and replies", async () => {
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
										id: "wamid.1",
										type: "text",
										text: { body: "explain login" },
									},
								],
							},
						},
					],
				},
			],
		});
		const sessionIds: string[] = [];
		const replies: unknown[][] = [];

		const response = await handleWhatsAppWebhook(
			new Request("http://localhost/whatsapp/webhook", {
				method: "POST",
				headers: {
					"X-Hub-Signature-256": createWhatsAppSignature(rawBody, "app-secret"),
				},
				body: rawBody,
			}),
			{
				config,
				orchestrator: { answer: async () => "login explanation" },
				memoryStore: trackingMemoryStore(sessionIds),
				whatsAppReplyClient: {
					reply: async (...args) => {
						replies.push(args);
					},
				},
			},
		);

		expect(response.status).toBe(200);
		expect(sessionIds).toEqual([
			"whatsapp:user:66812345678",
			"whatsapp:user:66812345678",
		]);
		expect(replies).toEqual([["66812345678", "login explanation", "wamid.1"]]);
	});

	test("rejects invalid signatures", async () => {
		const response = await handleWhatsAppWebhook(
			new Request("http://localhost/whatsapp/webhook", {
				method: "POST",
				headers: { "X-Hub-Signature-256": "sha256=invalid" },
				body: "{}",
			}),
			{
				config,
				orchestrator: { answer: async () => "unused" },
				memoryStore: trackingMemoryStore([]),
				whatsAppReplyClient: { reply: async () => undefined },
			},
		);

		expect(response.status).toBe(401);
	});

	test("sends text messages through the WhatsApp Cloud API", async () => {
		let request: Request | undefined;
		const client = createWhatsAppReplyClient({
			accessToken: "secret-access-token",
			phoneNumberId: "1234",
			apiBaseUrl: "https://graph.example/v26.0",
			fetch: Object.assign(
				async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
					request = new Request(input, init);
					return Response.json({ messages: [{ id: "wamid.2" }] });
				},
				{ preconnect: fetch.preconnect },
			),
		});

		await client.reply("66812345678", "hello", "wamid.1");

		expect(request?.url).toBe("https://graph.example/v26.0/1234/messages");
		expect(request?.headers.get("Authorization")).toBe(
			"Bearer secret-access-token",
		);
		expect(await requestJson(request)).toEqual({
			messaging_product: "whatsapp",
			to: "66812345678",
			type: "text",
			text: { body: "hello", preview_url: false },
			context: { message_id: "wamid.1" },
		});
	});
});

async function requestJson(request: Request | undefined): Promise<unknown> {
	if (!request) {
		throw new Error("Expected request to be captured");
	}
	return request.json();
}

function trackingMemoryStore(sessionIds: string[]): SessionMemoryStore {
	return {
		read: async (sessionId) => {
			sessionIds.push(sessionId);
			return [];
		},
		append: async (sessionId, messages) => {
			sessionIds.push(sessionId);
			return messages;
		},
		clear: async () => undefined,
	};
}
