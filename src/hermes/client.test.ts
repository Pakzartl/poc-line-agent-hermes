import { describe, expect, test } from "bun:test";
import {
	createHermesClient,
	findRecoveredAssistantMessage,
	HermesApiError,
} from "./client";

describe("Hermes client", () => {
	test("creates the session before posting chat with bearer auth and exact bodies", async () => {
		const requests: Request[] = [];
		const client = createHermesClient({
			baseUrl: "https://hermes.internal/",
			apiServerKey: "server-key",
			fetch: Object.assign(
				async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
					const request = new Request(input, init);
					requests.push(request);
					if (request.url.endsWith("/api/sessions")) {
						return Response.json({ id: "telegram:chat:9001" }, { status: 201 });
					}
					return Response.json({
						object: "hermes.session.chat.completion",
						message: { role: "assistant", content: "hello" },
					});
				},
				{ preconnect: fetch.preconnect },
			),
		});

		const result = await client.chat({
			sessionId: "telegram:chat:9001",
			source: "telegram",
			input: "hi",
		});

		expect(result.text).toBe("hello");
		expect(requests).toHaveLength(2);
		expect(requests[0]?.url).toBe("https://hermes.internal/api/sessions");
		expect(requests[0]?.method).toBe("POST");
		expect(requests[0]?.headers.get("authorization")).toBe("Bearer server-key");
		expect(await requestJson(requests[0])).toEqual({
			id: "telegram:chat:9001",
			source: "telegram",
		});
		expect(requests[1]?.url).toBe(
			"https://hermes.internal/api/sessions/telegram%3Achat%3A9001/chat",
		);
		expect(requests[1]?.headers.get("authorization")).toBe("Bearer server-key");
		expect(requests[1]?.headers.has("x-hermes-session-key")).toBe(false);
		expect(await requestJson(requests[1])).toEqual({ input: "hi" });
	});

	test("continues to chat when the session already exists", async () => {
		let calls = 0;
		const client = createHermesClient({
			baseUrl: "https://hermes.internal",
			apiServerKey: "server-key",
			fetch: Object.assign(
				async () => {
					calls += 1;
					return calls === 1
						? Response.json({ error: "exists" }, { status: 409 })
						: Response.json({ text: "hello" });
				},
				{ preconnect: fetch.preconnect },
			),
		});

		await expect(
			client.chat({
				sessionId: "telegram:chat:9001",
				source: "telegram",
				input: "hi",
			}),
		).resolves.toEqual({ text: "hello" });
		expect(calls).toBe(2);
	});

	test("treats a missing session as empty history before the first chat", async () => {
		let request: Request | undefined;
		const client = createHermesClient({
			baseUrl: "https://hermes.internal",
			apiServerKey: "server-key",
			fetch: Object.assign(
				async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
					request = new Request(input, init);
					return Response.json({ error: "not found" }, { status: 404 });
				},
				{ preconnect: fetch.preconnect },
			),
		});

		await expect(
			client.lastMessageMarker("telegram:chat:9001"),
		).resolves.toBeUndefined();
		expect(request?.url).toBe(
			"https://hermes.internal/api/sessions/telegram%3Achat%3A9001/messages",
		);
	});

	test("parses the production Sessions API data envelope", async () => {
		const client = createHermesClient({
			baseUrl: "https://hermes.internal",
			apiServerKey: "server-key",
			fetch: Object.assign(
				async () =>
					Response.json({
						object: "list",
						session_id: "telegram:chat:9001",
						data: [
							{
								id: 101,
								timestamp: 1_791_000_000.125,
								role: "user",
								content: "question",
							},
							{
								id: 102,
								timestamp: 1_791_000_001.25,
								role: "tool",
								content: "evidence",
							},
							{
								id: 103,
								timestamp: 1_791_000_002.5,
								role: "assistant",
								content: "answer",
							},
						],
					}),
				{ preconnect: fetch.preconnect },
			),
		});

		const messages = await client.listMessages("telegram:chat:9001");

		expect(messages).toEqual([
			{
				id: "101",
				timestamp: "1791000000.125",
				role: "user",
				content: "question",
			},
			{
				id: "102",
				timestamp: "1791000001.25",
				role: "tool",
				content: "evidence",
			},
			{
				id: "103",
				timestamp: "1791000002.5",
				role: "assistant",
				content: "answer",
			},
		]);
		expect(
			findRecoveredAssistantMessage({
				messages,
				userInput: "question",
			}),
		).toMatchObject({ id: "103", content: "answer" });
	});

	test("classifies non-retryable and malformed Hermes responses", async () => {
		const client = createHermesClient({
			baseUrl: "https://hermes.internal",
			apiServerKey: "server-key",
			fetch: Object.assign(
				async () => Response.json({ error: "bad" }, { status: 422 }),
				{ preconnect: fetch.preconnect },
			),
		});

		const error = await client
			.chat({
				sessionId: "telegram:chat:9001",
				source: "telegram",
				input: "hi",
			})
			.catch((caught) => caught);

		expect(error).toBeInstanceOf(HermesApiError);
		expect(error.retryable).toBe(false);
		expect(error.ambiguous).toBe(false);
	});

	test("classifies post success parse failures and server failures as ambiguous", async () => {
		const malformedClient = createHermesClient({
			baseUrl: "https://hermes.internal",
			apiServerKey: "server-key",
			fetch: Object.assign(async () => Response.json({ ok: true }), {
				preconnect: fetch.preconnect,
			}),
		});
		const malformedError = await malformedClient
			.chat({
				sessionId: "telegram:chat:9001",
				source: "telegram",
				input: "hi",
			})
			.catch((caught) => caught);
		expect(malformedError).toBeInstanceOf(HermesApiError);
		expect(malformedError.retryable).toBe(true);
		expect(malformedError.ambiguous).toBe(true);

		const serverClient = createHermesClient({
			baseUrl: "https://hermes.internal",
			apiServerKey: "server-key",
			fetch: Object.assign(
				async () => Response.json({ error: "down" }, { status: 503 }),
				{ preconnect: fetch.preconnect },
			),
		});
		const serverError = await serverClient
			.chat({
				sessionId: "telegram:chat:9001",
				source: "telegram",
				input: "hi",
			})
			.catch((caught) => caught);
		expect(serverError).toBeInstanceOf(HermesApiError);
		expect(serverError.retryable).toBe(true);
		expect(serverError.ambiguous).toBe(true);
	});

	test("clears sessions through DELETE", async () => {
		let request: Request | undefined;
		const client = createHermesClient({
			baseUrl: "https://hermes.internal",
			apiServerKey: "server-key",
			fetch: Object.assign(
				async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
					request = new Request(input, init);
					return new Response(null, { status: 204 });
				},
				{ preconnect: fetch.preconnect },
			),
		});

		await client.clearSession("telegram:chat:9001");

		expect(request?.method).toBe("DELETE");
		expect(request?.url).toBe(
			"https://hermes.internal/api/sessions/telegram%3Achat%3A9001",
		);
		expect(request?.headers.get("authorization")).toBe("Bearer server-key");
	});

	test("recovers exactly one assistant response after the baseline", () => {
		const recovered = findRecoveredAssistantMessage({
			baseline: { id: "m1" },
			userInput: "question",
			messages: [
				{ id: "m1", role: "assistant", content: "old" },
				{ id: "m2", role: "user", content: "question" },
				{ id: "m3", role: "assistant", content: "answer" },
			],
		});

		expect(recovered?.content).toBe("answer");
		expect(
			findRecoveredAssistantMessage({
				userInput: "question",
				messages: [
					{ id: "m2", role: "user", content: "question" },
					{ id: "m3", role: "user", content: "later" },
					{ id: "m4", role: "assistant", content: "ambiguous" },
				],
			}),
		).toBeUndefined();
	});
});

async function requestJson(request: Request | undefined): Promise<unknown> {
	if (!request) {
		throw new Error("Expected request to be captured");
	}
	return request.json();
}
