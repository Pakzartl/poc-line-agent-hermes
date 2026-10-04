import type { AppConfig } from "../config";
import { isValidGitRef, isValidRepository } from "./source-scope";

export type CodeSourceClient = {
	listRepositories(): Promise<readonly string[]>;
	listBranches(repository: string): Promise<readonly string[]>;
	branchExists(repository: string, branch: string): Promise<boolean>;
};

export type TelegramCodeSourceClient = CodeSourceClient;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const maxGitHubResponseBytes = 1_500_000;
const githubPageSize = 100;
const maxGitHubPages = 20;
const githubUserAgent = "poc-line-agent/0.1 telegram-source-picker/0.1";

export function createTelegramCodeSourceClient(options: {
	config: AppConfig["github"];
	fetch?: FetchLike;
}): TelegramCodeSourceClient {
	const fetchImpl = options.fetch ?? fetch;

	return {
		async listRepositories() {
			const repositories = await listAllPages(
				(page) =>
					`/user/repos?affiliation=owner%2Ccollaborator%2Corganization_member&sort=full_name&direction=asc&per_page=${githubPageSize}&page=${page}`,
				(item) => {
					if (!item || typeof item !== "object") {
						return undefined;
					}
					const fullName = (item as { full_name?: unknown }).full_name;
					return typeof fullName === "string" && isValidRepository(fullName)
						? fullName
						: undefined;
				},
			);
			return [...new Set(repositories)].sort((left, right) =>
				left.localeCompare(right),
			);
		},
		async listBranches(repository) {
			const repo = normalizeRepository(repository);
			const branches = await listAllPages(
				(page) =>
					`/repos/${repo}/branches?per_page=${githubPageSize}&page=${page}`,
				(item) => {
					if (!item || typeof item !== "object") {
						return undefined;
					}
					const name = (item as { name?: unknown }).name;
					return typeof name === "string" && isValidGitRef(name)
						? name
						: undefined;
				},
			);
			return [...new Set(branches)].sort(compareBranches);
		},
		async branchExists(repository, branch) {
			const repo = normalizeRepository(repository);
			if (!isValidGitRef(branch)) {
				return false;
			}
			const response = await githubGet(
				`/repos/${repo}/branches/${encodeURIComponent(branch)}`,
				[404],
			);
			return response.status !== 404;
		},
	};

	async function githubGet(
		path: string,
		acceptedStatuses: readonly number[] = [],
	): Promise<Response> {
		if (!options.config.token.trim()) {
			throw new Error("GITHUB_TOKEN is required for Telegram code selection");
		}
		const response = await fetchImpl(`${options.config.apiBaseUrl}${path}`, {
			method: "GET",
			redirect: "manual",
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${options.config.token}`,
				"User-Agent": githubUserAgent,
				"X-GitHub-Api-Version": "2022-11-28",
			},
		});
		if (response.status >= 300 && response.status < 400) {
			throw new Error("GitHub response redirect blocked");
		}
		if (!response.ok && !acceptedStatuses.includes(response.status)) {
			throw new Error(`GitHub request failed with status ${response.status}`);
		}
		return response;
	}

	async function listAllPages(
		pathForPage: (page: number) => string,
		mapItem: (item: unknown) => string | undefined,
	): Promise<string[]> {
		const values: string[] = [];
		for (let page = 1; page <= maxGitHubPages; page += 1) {
			const response = await githubGet(pathForPage(page));
			const text = await readBoundedText(response, maxGitHubResponseBytes);
			let body: unknown;
			try {
				body = JSON.parse(text);
			} catch {
				throw new Error("GitHub list response was not JSON");
			}
			if (!Array.isArray(body)) {
				throw new Error("GitHub list response was invalid");
			}
			for (const item of body) {
				const value = mapItem(item);
				if (value) {
					values.push(value);
				}
			}
			if (body.length < githubPageSize) {
				return values;
			}
		}
		throw new Error(
			`GitHub list exceeded the ${maxGitHubPages * githubPageSize} item safety limit`,
		);
	}
}

function normalizeRepository(repository: string): string {
	const value = repository.trim();
	if (!isValidRepository(value)) {
		throw new Error("repository must use owner/name format");
	}
	return value;
}

function compareBranches(left: string, right: string): number {
	const preferred = ["dev", "main", "master", "prod", "production"];
	const leftRank = preferred.indexOf(left);
	const rightRank = preferred.indexOf(right);
	if (leftRank >= 0 || rightRank >= 0) {
		return (
			(leftRank < 0 ? preferred.length : leftRank) -
			(rightRank < 0 ? preferred.length : rightRank)
		);
	}
	return left.localeCompare(right);
}

async function readBoundedText(
	response: Response,
	maxBytes: number,
): Promise<string> {
	const contentLength = Number(response.headers.get("content-length") ?? "0");
	if (contentLength > maxBytes) {
		throw new Error("GitHub response exceeded the size limit");
	}
	const reader = response.body?.getReader();
	if (!reader) {
		return "";
	}
	const decoder = new TextDecoder();
	let bytes = 0;
	let text = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		bytes += value.byteLength;
		if (bytes > maxBytes) {
			await reader.cancel();
			throw new Error("GitHub response exceeded the size limit");
		}
		text += decoder.decode(value, { stream: true });
	}
	return text + decoder.decode();
}
