import { describe, expect, test } from "bun:test";
import { loadCapabilityAdapterConfig } from "./config";
import { createCapabilityAdapterHandler } from "./server";

const config = loadCapabilityAdapterConfig({
	CAPABILITY_ADAPTER_TOKEN: "a".repeat(32),
	CAPABILITY_ARTIFACT_TARGETS_JSON: JSON.stringify([
		{ id: "javis-health", url: "https://agent.example/health" },
	]),
});

describe("capability adapter", () => {
	test("serves health without authentication", async () => {
		const handler = createCapabilityAdapterHandler({
			config,
			render: async () => new Uint8Array([1]),
		});
		const response = await handler(new Request("http://adapter.test/health"));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			ok: true,
			service: "capability-adapter",
		});
	});

	test("rejects missing auth and arbitrary target ids", async () => {
		const handler = createCapabilityAdapterHandler({
			config,
			render: async () => new Uint8Array([1]),
		});
		const unauthenticated = await handler(
			new Request("http://adapter.test/artifact/render", {
				method: "POST",
				body: JSON.stringify({ targetId: "javis-health" }),
			}),
		);
		expect(unauthenticated.status).toBe(401);

		const unknownTarget = await handler(
			new Request("http://adapter.test/artifact/render", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${"a".repeat(32)}`,
				},
				body: JSON.stringify({ targetId: "https://internal.example" }),
			}),
		);
		expect(unknownTarget.status).toBe(404);
	});

	test("renders only the configured URL", async () => {
		const rendered: string[] = [];
		const handler = createCapabilityAdapterHandler({
			config,
			render: async (url) => {
				rendered.push(url);
				return new Uint8Array([137, 80, 78, 71]);
			},
		});
		const response = await handler(
			new Request("http://adapter.test/artifact/render", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${"a".repeat(32)}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ targetId: "javis-health" }),
			}),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("image/png");
		expect(rendered).toEqual(["https://agent.example/health"]);
	});

	test("renders an authenticated safe public HTTPS URL", async () => {
		const rendered: string[] = [];
		const handler = createCapabilityAdapterHandler({
			config,
			render: async (url) => {
				rendered.push(url);
				return new Uint8Array([137, 80, 78, 71]);
			},
		});
		const response = await handler(
			new Request("http://adapter.test/artifact/render", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${"a".repeat(32)}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ url: "https://example.com/docs" }),
			}),
		);

		expect(response.status).toBe(200);
		expect(rendered).toEqual(["https://example.com/docs"]);
	});

	test("rejects unsafe direct URLs before rendering", async () => {
		let renders = 0;
		const handler = createCapabilityAdapterHandler({
			config,
			render: async () => {
				renders += 1;
				return new Uint8Array([137, 80, 78, 71]);
			},
		});
		for (const url of [
			"http://example.com",
			"https://127.0.0.1/admin",
			"https://169.254.169.254/latest/meta-data",
			"https://service.internal/admin",
		]) {
			const response = await handler(
				new Request("http://adapter.test/artifact/render", {
					method: "POST",
					headers: {
						Authorization: `Bearer ${"a".repeat(32)}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ url }),
				}),
			);
			expect(response.status).toBe(400);
		}
		expect(renders).toBe(0);
	});

	test("rejects private or local artifact targets during config load", () => {
		for (const url of [
			"https://127.0.0.1/health",
			"https://10.0.0.8/admin",
			"https://169.254.169.254/latest/meta-data",
			"https://[::1]/health",
			"https://service.internal/health",
		]) {
			expect(() =>
				loadCapabilityAdapterConfig({
					CAPABILITY_ADAPTER_TOKEN: "a".repeat(32),
					CAPABILITY_ARTIFACT_TARGETS_JSON: JSON.stringify([
						{ id: "unsafe", url },
					]),
				}),
			).toThrow("public HTTPS host");
		}
	});
});
