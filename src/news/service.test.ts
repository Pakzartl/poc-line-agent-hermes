import { describe, expect, test } from "bun:test";
import type { HermesChatInput, HermesClient } from "../hermes/client";
import { runNewsRequest } from "./service";

describe("Hermes web research service", () => {
	test("runs one isolated Hermes research turn with a runtime scope envelope", async () => {
		const chats: HermesChatInput[] = [];
		const result = await runNewsRequest({
			question: "ถ้าจะเดินทางไปน่านวันที่ 10/10/2026 มีความเสี่ยงน้ำท่วมไหม",
			requestId: "req-1",
			hermesClient: mockHermesClient(chats, [
				{
					text: "ควรติดตามประกาศล่าสุดจาก [กรมอุตุนิยมวิทยา](https://www.tmd.go.th/) ครับ",
				},
			]),
			now: new Date("2026-10-06T11:00:00.000Z"),
		});

		expect(chats).toHaveLength(1);
		expect(chats[0]?.sessionId).toBe("discord:research:req-1");
		expect(chats[0]?.source).toBe("discord");
		expect(chats[0]?.input).toStartWith(
			'POC_WEB_RESEARCH_SCOPE_V1 {"requestId":"req-1"}\n\n',
		);
		expect(chats[0]?.input).toContain("This is not limited to news headlines");
		expect(chats[0]?.input).toContain(
			"Never search for articles published in the future",
		);
		expect(chats[0]?.input).toContain("2026-10-06");
		expect(result.text).toContain("https://www.tmd.go.th/");
	});

	test("requires grounded public HTTPS citations", async () => {
		for (const text of [
			"สรุปโดยไม่มีแหล่งอ้างอิง",
			"อ้างอิง http://example.com/insecure",
			"อ้างอิง https://user:password@example.com/private",
		]) {
			await expect(
				runNewsRequest({
					question: "สถานการณ์น้ำท่วม",
					requestId: "grounding",
					hermesClient: mockHermesClient([], [{ text }]),
				}),
			).rejects.toThrow("News research failed");
		}
	});

	test("fails closed when Hermes fails or returns an oversized answer", async () => {
		await expect(
			runNewsRequest({
				question: "ข่าว",
				requestId: "failed",
				hermesClient: mockHermesClient([], []),
			}),
		).rejects.toThrow("News research failed");

		await expect(
			runNewsRequest({
				question: "ข่าว",
				requestId: "large",
				hermesClient: mockHermesClient(
					[],
					[{ text: `${"x".repeat(12_001)} https://example.com` }],
				),
			}),
		).rejects.toThrow("News research failed");
	});

	test("validates question and request id before inference", async () => {
		const chats: HermesChatInput[] = [];
		const client = mockHermesClient(chats, []);
		await expect(
			runNewsRequest({ question: "", requestId: "req", hermesClient: client }),
		).rejects.toThrow("News question is required");
		await expect(
			runNewsRequest({
				question: "news",
				requestId: "bad/request",
				hermesClient: client,
			}),
		).rejects.toThrow("News requestId is invalid");
		expect(chats).toHaveLength(0);
	});
});

function mockHermesClient(
	chats: HermesChatInput[],
	results: { text: string }[],
): HermesClient {
	let index = 0;
	return {
		async chat(input) {
			chats.push(input);
			const result = results[index];
			index += 1;
			if (!result) throw new Error("unexpected Hermes chat call");
			return result;
		},
		async listMessages() {
			return [];
		},
		async lastMessageMarker() {
			return undefined;
		},
		async clearSession() {},
	};
}
