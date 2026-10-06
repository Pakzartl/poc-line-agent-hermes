import { describe, expect, test } from "bun:test";
import { loadConfig } from "../config";
import { createGitHubTools } from "./github";

describe("GitHub tools", () => {
	test("code-reading tools require an explicit user-selected branch", () => {
		const tools = createGitHubTools({
			config: loadConfig({ GITHUB_TOKEN: "secret-token" }).github,
		});

		for (const name of ["search_code", "read_file"]) {
			const definition = tools.find(
				(tool) => tool.definition.name === name,
			)?.definition;
			expect(definition?.parameters.required).toContain("branch");
			expect(definition?.parameters.properties).toHaveProperty("branch");
			expect(definition?.parameters.properties).not.toHaveProperty("ref");
		}
	});

	test("lists repositories available to the token with bounded metadata", async () => {
		let request: Request | undefined;
		const tools = createGitHubTools({
			config: loadConfig({ GITHUB_TOKEN: "secret-token" }).github,
			fetch: async (input, init) => {
				request = new Request(input, init);
				return Response.json([
					{
						full_name: "acme/api",
						private: true,
						description: "API",
						default_branch: "main",
						html_url: "https://github.test/acme/api",
					},
				]);
			},
		});

		const result = await tools
			.find((tool) => tool.definition.name === "list_repositories")
			?.run("{}");

		expect(request?.method).toBe("GET");
		expect(request?.url).toContain("/user/repos?");
		expect(result).toEqual({
			ok: true,
			data: {
				repositories: [
					{
						name: "acme/api",
						private: true,
						description: "API",
						defaultBranch: "main",
						archived: false,
						url: "https://github.test/acme/api",
					},
				],
			},
		});
	});

	test("search_code scans the user-selected branch archive without exposing the token", async () => {
		const requestedHeaders: HeadersInit[] = [];
		const requestedUrls: string[] = [];
		const tools = createGitHubTools({
			config: loadConfig({
				GITHUB_OWNER: "superset",
				GITHUB_REPO: "repo",
				GITHUB_TOKEN: "secret-token",
				GITHUB_REF: "dev",
			}).github,
			fetch: async (url, init) => {
				requestedUrls.push(String(url));
				requestedHeaders.push(init?.headers ?? {});
				return tarGzipResponse({
					"superset-repo/src/auth/login.ts":
						"@Throttle({ default: { limit: 5, ttl: 60000 } })\nlogin() {}",
					"superset-repo/src/other.ts": "export const value = 1;",
				});
			},
		});

		const result = await tools
			.find((tool) => tool.definition.name === "search_code")
			?.run(
				'{"repository":"superset/repo","query":"Throttle|rate limit","branch":"chore/seed-pichya-user"}',
			);

		expect(result?.ok).toBe(true);
		expect(result?.data).toMatchObject({
			repository: "superset/repo",
			ref: "chore/seed-pichya-user",
			queries: ["Throttle", "rate limit"],
			matchedFiles: 1,
			files: [
				{
					path: "src/auth/login.ts",
					matchedQueries: ["Throttle"],
				},
			],
		});
		expect(requestedUrls[0]).toContain(
			"/repos/superset/repo/tarball/chore%2Fseed-pichya-user",
		);
		const secondResult = await tools
			.find((tool) => tool.definition.name === "search_code")
			?.run(
				'{"repository":"superset/repo","query":"export","branch":"chore/seed-pichya-user"}',
			);
		expect(secondResult?.data).toMatchObject({ indexReused: true });
		expect(requestedUrls).toHaveLength(1);
		expect(JSON.stringify(result)).not.toContain("secret-token");
		expect(JSON.stringify(requestedHeaders)).toContain("secret-token");
		expect(new Headers(requestedHeaders[0]).get("user-agent")).toBe(
			"poc-line-agent/0.1",
		);
	});

	test("read_file reads from the user-selected branch", async () => {
		let requestedUrl = "";
		const tools = createGitHubTools({
			config: loadConfig({
				GITHUB_TOKEN: "secret-token",
				GITHUB_REF: "dev",
			}).github,
			fetch: async (url) => {
				requestedUrl = String(url);
				return Response.json({
					path: "src/config.ts",
					size: 12,
					encoding: "base64",
					content: Buffer.from("export {};\n").toString("base64"),
				});
			},
		});

		const result = await tools
			.find((tool) => tool.definition.name === "read_file")
			?.run(
				'{"repository":"superset/repo","path":"src/config.ts","branch":"feature/arbitrary-branch"}',
			);

		expect(requestedUrl).toContain("?ref=feature%2Farbitrary-branch");
		expect(result?.data).toMatchObject({ ref: "feature/arbitrary-branch" });
	});

	test("blocks archive redirects outside the configured GitHub service", async () => {
		const tools = createGitHubTools({
			config: loadConfig({ GITHUB_TOKEN: "secret-token" }).github,
			fetch: async () =>
				new Response(null, {
					status: 302,
					headers: { Location: "https://example.com/archive.tar.gz" },
				}),
		});

		await expect(
			tools
				.find((tool) => tool.definition.name === "search_code")
				?.run(
					'{"repository":"superset/repo","query":"login","branch":"dev"}',
				) ?? Promise.resolve(),
		).rejects.toThrow("GitHub archive redirect was not trusted");
	});

	test("read_file limits large decoded content", async () => {
		const tools = createGitHubTools({
			config: loadConfig({
				GITHUB_OWNER: "superset",
				GITHUB_REPO: "repo",
				GITHUB_TOKEN: "secret-token",
			}).github,
			fetch: async () =>
				Response.json({
					path: "src/large.ts",
					size: 30_000,
					encoding: "base64",
					content: Buffer.from("x".repeat(25_000)).toString("base64"),
				}),
		});

		const result = await tools
			.find((tool) => tool.definition.name === "read_file")
			?.run(
				'{"repository":"superset/repo","path":"src/large.ts","branch":"dev"}',
			);

		expect(result?.ok).toBe(true);
		expect(JSON.stringify(result?.data).length).toBeLessThan(21_000);
		expect(JSON.stringify(result?.data)).toContain("[truncated]");
	});

	test("generic reads are GET-only and reject non-allowlisted paths", async () => {
		let method: string | undefined;
		const tools = createGitHubTools({
			config: loadConfig({ GITHUB_TOKEN: "secret-token" }).github,
			fetch: async (_input, init) => {
				method = init?.method;
				return Response.json({ default_branch: "main" });
			},
		});
		const githubGet = tools.find(
			(tool) => tool.definition.name === "github_get",
		);

		expect(await githubGet?.run('{"path":"/repos/acme/api/branches"}')).toEqual(
			{ ok: true, data: { default_branch: "main" } },
		);
		expect(method).toBe("GET");
		await expect(
			githubGet?.run('{"path":"https://example.com/private"}') ??
				Promise.resolve(),
		).rejects.toThrow("invalid GitHub GET path");
	});

	test("limits generic GitHub output before adding it to model context", async () => {
		const tools = createGitHubTools({
			config: loadConfig({ GITHUB_TOKEN: "secret-token" }).github,
			fetch: async () => Response.json({ content: "x".repeat(25_000) }),
		});
		const githubGet = tools.find(
			(tool) => tool.definition.name === "github_get",
		);

		const result = await githubGet?.run('{"path":"/repos/acme/api/tree"}');

		expect(result?.ok).toBe(true);
		expect(JSON.stringify(result?.data).length).toBeLessThan(20_100);
		expect(JSON.stringify(result?.data)).toContain("[truncated]");
	});

	test("does not expose mutation tools", () => {
		const tools = createGitHubTools({
			config: loadConfig({ GITHUB_TOKEN: "secret-token" }).github,
		});
		const names = tools.map((tool) => tool.definition.name);

		expect(names).toEqual([
			"list_repositories",
			"github_get",
			"search_code",
			"read_file",
			"get_commit",
		]);
		for (const tool of tools) {
			expect([...tool.definition.parameters.required].sort()).toEqual(
				Object.keys(tool.definition.parameters.properties).sort(),
			);
		}
	});
});

function tarGzipResponse(files: Record<string, string>): Response {
	const entries = Object.entries(files).flatMap(([path, content]) => {
		const body = new TextEncoder().encode(content);
		const header = new Uint8Array(512);
		writeTarText(header, 0, 100, path);
		writeTarText(header, 100, 8, "0000644");
		writeTarText(header, 108, 8, "0000000");
		writeTarText(header, 116, 8, "0000000");
		writeTarText(
			header,
			124,
			12,
			`${body.byteLength.toString(8).padStart(11, "0")}\0`,
		);
		writeTarText(header, 136, 12, "00000000000");
		header[156] = "0".charCodeAt(0);
		const padding = new Uint8Array((512 - (body.byteLength % 512)) % 512);
		return [header, body, padding];
	});
	entries.push(new Uint8Array(1024));
	const size = entries.reduce((total, entry) => total + entry.byteLength, 0);
	const tar = new Uint8Array(size);
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
