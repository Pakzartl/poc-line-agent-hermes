import { Buffer } from "node:buffer";
import type { RegisteredTool, ToolResult } from "../agent/tool-runner";
import type { AppConfig } from "../config";

const maxRepositories = 50;
const maxSearchResults = 50;
const maxFileChars = 20_000;
const maxCommitFiles = 20;
const maxGitHubResponseBytes = 750_000;
const maxGenericResultChars = 20_000;
const maxArchiveBytes = 96_000_000;
const maxIndexedCodeBytes = 16_000_000;
const maxSearchableFileBytes = 512_000;
const maxSearchQueries = 12;
const maxSnippetsPerFile = 3;
const githubUserAgent = "poc-line-agent/0.1";

type GitHubToolOptions = {
	config: AppConfig["github"];
	fetch?: FetchLike;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function createGitHubTools(
	options: GitHubToolOptions,
): RegisteredTool[] {
	const client = createGitHubClient(options.config, options.fetch ?? fetch);

	return [
		{
			definition: {
				type: "function",
				name: "list_repositories",
				description:
					"List repositories that the configured GitHub token can read. Use this before assuming a repository name.",
				strict: true,
				parameters: {
					type: "object",
					properties: {},
					required: [],
					additionalProperties: false,
				},
			},
			run: async () => client.listRepositories(),
		},
		{
			definition: {
				type: "function",
				name: "github_get",
				description:
					"Call an allowlisted GitHub REST GET endpoint. Paths may target /user/repos, /repos/{owner}/{repo}/..., /users/{user}/repos, /orgs/{org}/repos, or GitHub search. Mutations and external URLs are blocked.",
				strict: true,
				parameters: {
					type: "object",
					properties: {
						path: {
							type: "string",
							description:
								"GitHub REST path beginning with /, including an optional query string.",
						},
					},
					required: ["path"],
					additionalProperties: false,
				},
			},
			run: async (argumentsJson) =>
				client.get(getRequiredArg(argumentsJson, "path")),
		},
		{
			definition: {
				type: "function",
				name: "search_code",
				description:
					"Search source code on the repository and branch explicitly stated in the latest user message. Separate case-insensitive literal alternatives with | to scan the branch once.",
				strict: true,
				parameters: {
					type: "object",
					properties: {
						repository: {
							type: "string",
							description: "Repository in owner/name form.",
						},
						query: { type: "string", description: "Code search query." },
						branch: {
							type: "string",
							description:
								"Branch or Git ref explicitly stated in the latest user message. Never infer it from history or defaults.",
						},
					},
					required: ["repository", "query", "branch"],
					additionalProperties: false,
				},
			},
			run: async (argumentsJson) =>
				client.searchCode(
					getRequiredArg(argumentsJson, "repository"),
					getRequiredArg(argumentsJson, "query"),
					getRequiredArg(argumentsJson, "branch"),
				),
		},
		{
			definition: {
				type: "function",
				name: "read_file",
				description: "Read a text file from one readable GitHub repository.",
				strict: true,
				parameters: {
					type: "object",
					properties: {
						repository: {
							type: "string",
							description: "Repository in owner/name form.",
						},
						path: {
							type: "string",
							description: "Repository-relative file path.",
						},
						branch: {
							type: "string",
							description:
								"Branch or Git ref explicitly stated in the latest user message. Never infer it from history or defaults.",
						},
					},
					required: ["repository", "path", "branch"],
					additionalProperties: false,
				},
			},
			run: async (argumentsJson) =>
				client.readFile(
					getRequiredArg(argumentsJson, "repository"),
					getRequiredArg(argumentsJson, "path"),
					getRequiredArg(argumentsJson, "branch"),
				),
		},
		{
			definition: {
				type: "function",
				name: "get_commit",
				description:
					"Read commit metadata and touched files from one repository.",
				strict: true,
				parameters: {
					type: "object",
					properties: {
						repository: {
							type: "string",
							description: "Repository in owner/name form.",
						},
						sha: { type: "string", description: "Commit SHA or ref." },
					},
					required: ["repository", "sha"],
					additionalProperties: false,
				},
			},
			run: async (argumentsJson) =>
				client.getCommit(
					getRequiredArg(argumentsJson, "repository"),
					getRequiredArg(argumentsJson, "sha"),
				),
		},
	];
}

function createGitHubClient(config: AppConfig["github"], fetchImpl: FetchLike) {
	async function requestJson<T>(path: string): Promise<T> {
		validateConfig(config);
		const safePath = validateReadPath(path);
		const response = await fetchImpl(`${config.apiBaseUrl}${safePath}`, {
			method: "GET",
			redirect: "manual",
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${config.token}`,
				"User-Agent": githubUserAgent,
				"X-GitHub-Api-Version": "2022-11-28",
			},
		});

		if (response.status >= 300 && response.status < 400) {
			throw new Error("GitHub response redirect blocked");
		}
		if (!response.ok) {
			throw new Error(`GitHub request failed with status ${response.status}`);
		}

		const body = await readBoundedText(response, maxGitHubResponseBytes);
		try {
			return JSON.parse(body) as T;
		} catch {
			throw new Error("GitHub response was not JSON");
		}
	}

	async function requestArchive(
		repository: string,
		ref: string,
	): Promise<Response> {
		validateConfig(config);
		const archiveUrl = `${config.apiBaseUrl}/repos/${repository}/tarball/${encodeURIComponent(ref)}`;
		let response = await fetchImpl(archiveUrl, {
			method: "GET",
			redirect: "manual",
			headers: githubHeaders(config.token),
		});
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("location");
			if (!location) {
				throw new Error("GitHub archive redirect had no location");
			}
			const redirectUrl = new URL(location, archiveUrl);
			if (!isTrustedArchiveRedirect(config.apiBaseUrl, redirectUrl)) {
				throw new Error("GitHub archive redirect was not trusted");
			}
			response = await fetchImpl(redirectUrl.toString(), {
				method: "GET",
				redirect: "error",
				headers: githubHeaders(config.token),
			});
		}
		if (!response.ok) {
			throw new Error(
				`GitHub archive request failed with status ${response.status}`,
			);
		}
		return response;
	}

	const branchIndexCache = new Map<string, Promise<BranchCodeIndex>>();
	async function getBranchCodeIndex(
		repository: string,
		ref: string,
	): Promise<{ index: BranchCodeIndex; reused: boolean }> {
		const cacheKey = `${repository}@${ref}`;
		const reused = branchIndexCache.has(cacheKey);
		let indexPromise = branchIndexCache.get(cacheKey);
		if (!indexPromise) {
			indexPromise = requestArchive(repository, ref).then(buildBranchCodeIndex);
			branchIndexCache.set(cacheKey, indexPromise);
		}
		try {
			return { index: await indexPromise, reused };
		} catch (error) {
			branchIndexCache.delete(cacheKey);
			throw error;
		}
	}

	return {
		async listRepositories(): Promise<ToolResult> {
			const data = await requestJson<
				{
					full_name: string;
					private?: boolean;
					description?: string | null;
					default_branch?: string;
					html_url?: string;
					archived?: boolean;
				}[]
			>(
				`/user/repos?affiliation=owner%2Ccollaborator%2Corganization_member&sort=updated&per_page=${maxRepositories}`,
			);

			return {
				ok: true,
				data: {
					repositories: data.slice(0, maxRepositories).map((repository) => ({
						name: repository.full_name,
						private: repository.private ?? false,
						description: repository.description ?? undefined,
						defaultBranch: repository.default_branch,
						archived: repository.archived ?? false,
						url: repository.html_url,
					})),
				},
			};
		},
		async get(path: string): Promise<ToolResult> {
			const data = await requestJson<unknown>(path);
			const serialized = JSON.stringify(data);
			return {
				ok: true,
				data:
					serialized.length <= maxGenericResultChars
						? data
						: {
								truncated: true,
								json: `${serialized.slice(0, maxGenericResultChars)}...[truncated]`,
							},
			};
		},
		async searchCode(
			repository: string,
			query: string,
			branch: string,
		): Promise<ToolResult> {
			const repoPath = normalizeRepository(repository);
			const queries = parseSearchQueries(query);
			if (queries.length === 0) {
				return { ok: false, error: "query is required" };
			}
			const ref = normalizeGitRef(branch);
			const { index, reused } = await getBranchCodeIndex(repoPath, ref);
			const search = searchCodeIndex(index, queries);

			return {
				ok: true,
				data: {
					repository: repoPath,
					ref,
					queries,
					scannedFiles: search.scannedFiles,
					skippedLargeFiles: search.skippedLargeFiles,
					matchedFiles: search.matchedFiles,
					indexReused: reused,
					truncated: search.matchedFiles > search.files.length,
					files: search.files.map((file) => ({
						...file,
						url: githubBlobUrl(repoPath, ref, file.path),
					})),
				},
			};
		},
		async readFile(
			repository: string,
			path: string,
			branch: string,
		): Promise<ToolResult> {
			const repoPath = normalizeRepository(repository);
			const safePath = normalizeRepoFilePath(path);
			const ref = normalizeGitRef(branch);
			const data = await requestJson<{
				content?: string;
				encoding?: string;
				path?: string;
				size?: number;
			}>(
				`/repos/${repoPath}/contents/${encodeURIComponentPath(safePath)}?ref=${encodeURIComponent(ref)}`,
			);

			if (data.encoding !== "base64" || !data.content) {
				return { ok: false, error: "file content is not base64 text" };
			}

			const decoded = Buffer.from(
				data.content.replace(/\n/g, ""),
				"base64",
			).toString("utf8");

			return {
				ok: true,
				data: {
					repository: repoPath,
					ref,
					path: data.path ?? safePath,
					size: data.size,
					content: limitText(decoded, maxFileChars),
				},
			};
		},
		async getCommit(repository: string, sha: string): Promise<ToolResult> {
			const repoPath = normalizeRepository(repository);
			const safeSha = sha.trim().slice(0, 100);
			if (!safeSha) {
				return { ok: false, error: "sha is required" };
			}

			const data = await requestJson<{
				sha: string;
				html_url?: string;
				commit?: {
					message?: string;
					author?: { name?: string; date?: string };
				};
				files?: {
					filename: string;
					status?: string;
					additions?: number;
					deletions?: number;
				}[];
			}>(`/repos/${repoPath}/commits/${encodeURIComponent(safeSha)}`);

			return {
				ok: true,
				data: {
					repository: repoPath,
					sha: data.sha,
					url: data.html_url,
					message: limitText(data.commit?.message ?? "", 2_000),
					author: data.commit?.author,
					files: (data.files ?? []).slice(0, maxCommitFiles).map((file) => ({
						path: file.filename,
						status: file.status,
						additions: file.additions,
						deletions: file.deletions,
					})),
				},
			};
		},
	};
}

function githubHeaders(token: string): HeadersInit {
	return {
		Accept: "application/vnd.github+json",
		Authorization: `Bearer ${token}`,
		"User-Agent": githubUserAgent,
		"X-GitHub-Api-Version": "2022-11-28",
	};
}

function isTrustedArchiveRedirect(
	apiBaseUrl: string,
	redirectUrl: URL,
): boolean {
	if (redirectUrl.protocol !== "https:") {
		return false;
	}
	const apiHost = new URL(apiBaseUrl).hostname;
	return (
		redirectUrl.hostname === apiHost ||
		(apiHost === "api.github.com" &&
			redirectUrl.hostname === "codeload.github.com")
	);
}

type SearchMatch = {
	path: string;
	matchedQueries: string[];
	snippets: { line: number; text: string }[];
};

type BranchCodeIndex = {
	scannedFiles: number;
	skippedLargeFiles: number;
	files: { path: string; text: string }[];
};

async function buildBranchCodeIndex(
	response: Response,
): Promise<BranchCodeIndex> {
	if (!response.body) {
		throw new Error("GitHub archive response had no body");
	}

	const stream = await maybeDecompressGzip(response.body);
	const reader = new BoundedStreamReader(stream, maxArchiveBytes);
	const files: { path: string; text: string }[] = [];
	let scannedFiles = 0;
	let skippedLargeFiles = 0;
	let indexedCodeBytes = 0;
	let pendingPath = "";

	try {
		while (true) {
			const header = await reader.readExactly(512);
			if (!header || isZeroBlock(header)) {
				break;
			}

			const size = parseTarSize(header);
			const type = String.fromCharCode(header[156] ?? 0);
			const headerPath = tarHeaderPath(header);
			const archivePath = pendingPath || headerPath;
			pendingPath = "";
			const shouldCapture =
				size <= maxSearchableFileBytes &&
				(type === "0" || type === "\0" || type === "x" || type === "L");
			const body = shouldCapture
				? await reader.readExactly(size)
				: (await reader.skipExactly(size), null);
			await reader.skipExactly((512 - (size % 512)) % 512);

			if (type === "x" && body) {
				pendingPath = parsePaxPath(body);
				continue;
			}
			if (type === "L" && body) {
				pendingPath = decodeTarText(body);
				continue;
			}
			if (type !== "0" && type !== "\0") {
				continue;
			}

			const repositoryPath = stripArchiveRoot(archivePath);
			if (!isSearchableCodePath(repositoryPath)) {
				continue;
			}
			if (!body) {
				skippedLargeFiles += 1;
				continue;
			}
			if (body.includes(0)) {
				continue;
			}

			indexedCodeBytes += body.byteLength;
			if (indexedCodeBytes > maxIndexedCodeBytes) {
				throw new Error(
					"Repository code exceeded the branch search index limit",
				);
			}
			scannedFiles += 1;
			files.push({
				path: repositoryPath,
				text: new TextDecoder().decode(body),
			});
		}
	} finally {
		await reader.cancel();
	}

	return { scannedFiles, skippedLargeFiles, files };
}

function searchCodeIndex(
	index: BranchCodeIndex,
	queries: string[],
): {
	scannedFiles: number;
	skippedLargeFiles: number;
	matchedFiles: number;
	files: SearchMatch[];
} {
	const files: SearchMatch[] = [];
	let matchedFiles = 0;
	for (const file of index.files) {
		const match = matchFile(file.path, file.text, queries);
		if (!match) {
			continue;
		}
		matchedFiles += 1;
		if (files.length < maxSearchResults) {
			files.push(match);
		}
	}
	return {
		scannedFiles: index.scannedFiles,
		skippedLargeFiles: index.skippedLargeFiles,
		matchedFiles,
		files,
	};
}

class BoundedStreamReader {
	private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
	private chunk: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
	private chunkOffset = 0;
	private totalBytes = 0;

	constructor(
		stream: ReadableStream<Uint8Array>,
		private readonly maxBytes: number,
	) {
		this.reader = stream.getReader();
	}

	async readExactly(length: number): Promise<Uint8Array | null> {
		if (length === 0) {
			return new Uint8Array(0);
		}
		const result = new Uint8Array(length);
		let written = 0;
		while (written < length) {
			if (this.chunkOffset >= this.chunk.byteLength) {
				const next = await this.reader.read();
				if (next.done) {
					if (written === 0) {
						return null;
					}
					throw new Error("GitHub archive ended unexpectedly");
				}
				this.chunk = next.value;
				this.chunkOffset = 0;
				this.totalBytes += next.value.byteLength;
				if (this.totalBytes > this.maxBytes) {
					throw new Error("GitHub archive exceeded the scan size limit");
				}
			}
			const available = this.chunk.byteLength - this.chunkOffset;
			const take = Math.min(available, length - written);
			result.set(
				this.chunk.subarray(this.chunkOffset, this.chunkOffset + take),
				written,
			);
			this.chunkOffset += take;
			written += take;
		}
		return result;
	}

	async skipExactly(length: number): Promise<void> {
		let remaining = length;
		while (remaining > 0) {
			const chunk = await this.readExactly(Math.min(remaining, 64_000));
			if (!chunk) {
				throw new Error("GitHub archive ended unexpectedly");
			}
			remaining -= chunk.byteLength;
		}
	}

	async cancel(): Promise<void> {
		await this.reader.cancel().catch(() => undefined);
	}
}

async function maybeDecompressGzip(
	stream: ReadableStream<Uint8Array>,
): Promise<ReadableStream<Uint8Array>> {
	const reader = stream.getReader();
	const first = await reader.read();
	if (first.done) {
		return new ReadableStream<Uint8Array>({
			start: (controller) => controller.close(),
		});
	}
	const replay = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(first.value);
		},
		async pull(controller) {
			const next = await reader.read();
			if (next.done) {
				controller.close();
				return;
			}
			controller.enqueue(next.value);
		},
		async cancel(reason) {
			await reader.cancel(reason);
		},
	});
	if (first.value[0] !== 0x1f || first.value[1] !== 0x8b) {
		return replay;
	}
	const gzip = new DecompressionStream("gzip");
	return replay.pipeThrough({
		readable: gzip.readable as ReadableStream<Uint8Array>,
		writable: gzip.writable as WritableStream<Uint8Array>,
	});
}

function matchFile(
	path: string,
	text: string,
	queries: string[],
): SearchMatch | null {
	const lower = text.toLowerCase();
	const matchedQueries = queries.filter((query) =>
		lower.includes(query.toLowerCase()),
	);
	if (matchedQueries.length === 0) {
		return null;
	}

	const snippets: { line: number; text: string }[] = [];
	const lowerQueries = matchedQueries.map((query) => query.toLowerCase());
	for (const [index, line] of text.split(/\r?\n/).entries()) {
		const lowerLine = line.toLowerCase();
		if (lowerQueries.some((query) => lowerLine.includes(query))) {
			snippets.push({ line: index + 1, text: limitText(line.trim(), 300) });
			if (snippets.length >= maxSnippetsPerFile) {
				break;
			}
		}
	}
	return { path, matchedQueries, snippets };
}

function parseSearchQueries(query: string): string[] {
	return [
		...new Set(
			query
				.split("|")
				.map((item) => item.trim())
				.filter(Boolean),
		),
	]
		.slice(0, maxSearchQueries)
		.map((item) => item.slice(0, 100));
}

function parseTarSize(header: Uint8Array): number {
	const raw = decodeTarText(header.subarray(124, 136)).trim();
	const size = Number.parseInt(raw || "0", 8);
	if (!Number.isSafeInteger(size) || size < 0) {
		throw new Error("GitHub archive contained an invalid file size");
	}
	return size;
}

function tarHeaderPath(header: Uint8Array): string {
	const name = decodeTarText(header.subarray(0, 100));
	const prefix = decodeTarText(header.subarray(345, 500));
	return prefix ? `${prefix}/${name}` : name;
}

function decodeTarText(value: Uint8Array): string {
	return new TextDecoder().decode(value).replace(/\0.*$/s, "").trim();
}

function parsePaxPath(body: Uint8Array): string {
	for (const line of new TextDecoder().decode(body).split("\n")) {
		const match = line.match(/^\d+ path=(.*)$/);
		if (match?.[1]) {
			return match[1];
		}
	}
	return "";
}

function stripArchiveRoot(path: string): string {
	const separator = path.indexOf("/");
	return separator >= 0 ? path.slice(separator + 1) : path;
}

function isZeroBlock(block: Uint8Array): boolean {
	return block.every((byte) => byte === 0);
}

function isSearchableCodePath(path: string): boolean {
	if (
		!path ||
		/(^|\/)(?:node_modules|dist|build|coverage|vendor|\.git)(?:\/|$)/.test(path)
	) {
		return false;
	}
	return /(?:^|\/)(?:Dockerfile|Makefile)$|\.(?:[cm]?[jt]sx?|json|ya?ml|toml|md|go|py|rb|java|kt|cs|php|rs|sh|graphql|gql|xml|conf|ini|env|tf|hcl|properties)$/i.test(
		path,
	);
}

function githubBlobUrl(repository: string, ref: string, path: string): string {
	return `https://github.com/${repository}/blob/${encodeURIComponent(ref)}/${encodeURIComponentPath(path)}`;
}

function parseArgs(argumentsJson: string): Record<string, string> {
	try {
		const parsed = JSON.parse(argumentsJson) as Record<string, unknown>;
		return Object.fromEntries(
			Object.entries(parsed).map(([key, value]) => [key, String(value ?? "")]),
		);
	} catch {
		return {};
	}
}

function getRequiredArg(argumentsJson: string, name: string): string {
	const value = parseArgs(argumentsJson)[name];
	if (!value) {
		throw new Error(`${name} is required`);
	}
	return value;
}

function validateConfig(config: AppConfig["github"]): void {
	if (!config.token) {
		throw new Error("GitHub token is required");
	}
}

function validateReadPath(path: string): string {
	const trimmed = path.trim();
	if (
		!trimmed.startsWith("/") ||
		trimmed.startsWith("//") ||
		trimmed.includes("\\") ||
		trimmed.includes("#")
	) {
		throw new Error("invalid GitHub GET path");
	}

	const url = new URL(trimmed, "https://github.invalid");
	const allowed = [
		/^\/user\/repos$/,
		/^\/repos\/[^/]+\/[^/]+(?:\/.*)?$/,
		/^\/(?:users|orgs)\/[^/]+\/repos$/,
		/^\/search\/(?:code|issues|commits)$/,
	].some((pattern) => pattern.test(url.pathname));
	if (!allowed) {
		throw new Error("GitHub GET path is not allowlisted");
	}

	const perPage = Number(url.searchParams.get("per_page"));
	if (Number.isFinite(perPage) && perPage > 100) {
		url.searchParams.set("per_page", "100");
	}
	return `${url.pathname}${url.search}`;
}

function normalizeRepository(repository: string): string {
	const trimmed = repository.trim();
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed)) {
		throw new Error("repository must use owner/name format");
	}
	return trimmed;
}

function normalizeGitRef(ref: string): string {
	const trimmed = ref.trim().slice(0, 200);
	if (
		!trimmed ||
		trimmed.startsWith("/") ||
		trimmed.endsWith("/") ||
		trimmed.includes("..") ||
		trimmed.includes("@{") ||
		trimmed.includes("\\") ||
		/[\u0000-\u0020~^:?*[\]]/.test(trimmed)
	) {
		throw new Error("invalid GitHub ref");
	}
	return trimmed;
}

function normalizeRepoFilePath(path: string): string {
	const trimmed = path.trim().replace(/^\/+/, "");
	if (!trimmed || trimmed.split("/").includes("..")) {
		throw new Error("invalid repository file path");
	}
	return trimmed;
}

function encodeURIComponentPath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}

async function readBoundedText(
	response: Response,
	maxBytes: number,
): Promise<string> {
	const contentLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(contentLength) && contentLength > maxBytes) {
		throw new Error("GitHub response exceeded the size limit");
	}
	if (!response.body) {
		return "";
	}

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			totalBytes += value.byteLength;
			if (totalBytes > maxBytes) {
				throw new Error("GitHub response exceeded the size limit");
			}
			chunks.push(value);
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}

	const body = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(body);
}

function limitText(text: string, maxChars: number): string {
	if (text.length <= maxChars) {
		return text;
	}
	return `${text.slice(0, maxChars)}\n[truncated]`;
}
