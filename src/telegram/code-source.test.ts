import { describe, expect, test } from "bun:test";
import { loadConfig } from "../config";
import { createTelegramCodeSourceClient } from "./code-source";

describe("Telegram code source client", () => {
	test("lists every repository visible to the token across GitHub pages", async () => {
		const requests: string[] = [];
		const firstPage = Array.from({ length: 100 }, (_, index) => ({
			full_name: `example/repository-${String(index).padStart(3, "0")}`,
		}));
		const client = createTelegramCodeSourceClient({
			config: loadConfig({
				GITHUB_TOKEN: "secret-token",
				GITHUB_API_BASE_URL: "https://github.example",
			}).github,
			fetch: async (input) => {
				requests.push(input);
				const page = new URL(input).searchParams.get("page");
				return Response.json(
					page === "1"
						? firstPage
						: [{ full_name: "another/private-repository" }],
				);
			},
		});
		const repositories = await client.listRepositories();

		expect(repositories).toHaveLength(101);
		expect(repositories).toContain("another/private-repository");
		expect(requests).toEqual([
			"https://github.example/user/repos?affiliation=owner%2Ccollaborator%2Corganization_member&sort=full_name&direction=asc&per_page=100&page=1",
			"https://github.example/user/repos?affiliation=owner%2Ccollaborator%2Corganization_member&sort=full_name&direction=asc&per_page=100&page=2",
		]);
	});

	test("lists valid branches with common branches first", async () => {
		let request: Request | undefined;
		const client = createTelegramCodeSourceClient({
			config: loadConfig({
				GITHUB_TOKEN: "secret-token",
				GITHUB_API_BASE_URL: "https://github.example",
			}).github,
			fetch: async (input, init) => {
				request = new Request(input, init);
				return Response.json([
					{ name: "feature/z" },
					{ name: "main" },
					{ name: "dev" },
					{ name: "bad branch" },
				]);
			},
		});

		expect(await client.listBranches("codemonday-dev/lms-backend")).toEqual([
			"dev",
			"main",
			"feature/z",
		]);
		expect(request?.url).toBe(
			"https://github.example/repos/codemonday-dev/lms-backend/branches?per_page=100&page=1",
		);
		expect(request?.headers.get("authorization")).toBe("Bearer secret-token");
	});

	test("checks a custom branch without following redirects", async () => {
		let request: Request | undefined;
		const client = createTelegramCodeSourceClient({
			config: loadConfig({
				GITHUB_TOKEN: "secret-token",
				GITHUB_API_BASE_URL: "https://github.example",
			}).github,
			fetch: async (input, init) => {
				request = new Request(input, init);
				return new Response(null, { status: 404 });
			},
		});

		expect(
			await client.branchExists(
				"codemonday-dev/lms-backend",
				"feature/source-picker",
			),
		).toBe(false);
		expect(request?.url).toBe(
			"https://github.example/repos/codemonday-dev/lms-backend/branches/feature%2Fsource-picker",
		);
		expect(request?.redirect).toBe("manual");
	});
});
