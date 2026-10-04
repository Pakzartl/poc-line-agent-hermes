import { describe, expect, test } from "bun:test";
import { createArtifact, parseScreenshotTargets } from "./request";

describe("artifact requests", () => {
	test("creates bounded markdown, JSON, and CSV files", async () => {
		const markdown = await createArtifact({
			kind: "markdown",
			name: "risk report",
			content: "# Risk\nSafe",
		});
		expect(markdown.filename).toBe("risk-report.md");
		expect(new TextDecoder().decode(markdown.data)).toContain("# Risk");

		const json = await createArtifact({
			kind: "json",
			name: "evidence",
			content: { ok: true },
		});
		expect(json.contentType).toContain("application/json");

		const csv = await createArtifact({
			kind: "csv",
			name: "rows",
			content: [{ name: "A, B", count: 2 }],
		});
		expect(new TextDecoder().decode(csv.data)).toBe('name,count\n"A, B",2');
	});

	test("screenshot requires a configured allowlisted target", async () => {
		await expect(
			createArtifact({ kind: "screenshot", name: "home", targetId: "home" }),
		).rejects.toThrow("not configured");
		const targets = parseScreenshotTargets(
			JSON.stringify([{ id: "home", url: "https://example.com/home" }]),
		);
		const file = await createArtifact({
			kind: "screenshot",
			name: "home page",
			targetId: "home",
			renderer: {
				endpoint: "https://renderer.example.com/capture",
				token: "secret",
				targets,
			},
			fetch: async (_input, init) => {
				const body = JSON.parse(String(init?.body));
				expect(body).toEqual({ targetId: "home" });
				return new Response(new Uint8Array([1, 2, 3]), {
					headers: { "Content-Type": "image/png" },
				});
			},
		});
		expect(file.filename).toBe("home-page.png");
	});

	test("rejects arbitrary or unsafe screenshot URLs", () => {
		expect(() =>
			parseScreenshotTargets(
				JSON.stringify([{ id: "internal", url: "http://127.0.0.1:3000" }]),
			),
		).toThrow("credential-free HTTPS");
	});
});
