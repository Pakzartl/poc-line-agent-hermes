export type ArtifactKind = "markdown" | "json" | "csv" | "screenshot";

export type ArtifactFile = {
	filename: string;
	contentType: string;
	data: Uint8Array;
	bytes: number;
};

export type ScreenshotTarget = {
	id: string;
	url: string;
};

export type ScreenshotRendererConfig = {
	endpoint: string;
	token: string;
	targets: readonly ScreenshotTarget[];
};

type FetchLike = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

const maxArtifactBytes = 7_500_000;
const safeNamePattern = /[^a-zA-Z0-9._-]+/g;

export async function createArtifact(input: {
	kind: ArtifactKind;
	name: string;
	content?: unknown;
	targetId?: string;
	renderer?: ScreenshotRendererConfig;
	fetch?: FetchLike;
}): Promise<ArtifactFile> {
	const baseName = safeBaseName(input.name);
	if (input.kind === "screenshot") {
		return captureKnownTarget({
			name: baseName,
			targetId: input.targetId,
			renderer: input.renderer,
			fetch: input.fetch,
		});
	}
	if (input.content === undefined) {
		throw new Error("Artifact content is required");
	}

	const encoded = new TextEncoder().encode(
		input.kind === "json"
			? JSON.stringify(input.content, null, 2)
			: input.kind === "csv"
				? renderCsv(input.content)
				: renderMarkdown(input.content),
	);
	assertSize(encoded.byteLength);
	return {
		filename: `${baseName}.${extension(input.kind)}`,
		contentType: contentType(input.kind),
		data: encoded,
		bytes: encoded.byteLength,
	};
}

export function parseScreenshotTargets(
	raw: string | undefined,
): ScreenshotTarget[] {
	if (!raw?.trim()) {
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("ARTIFACT_SCREENSHOT_TARGETS_JSON must be valid JSON");
	}
	if (!Array.isArray(parsed)) {
		throw new Error("ARTIFACT_SCREENSHOT_TARGETS_JSON must be an array");
	}
	return parsed.map((candidate, index) => {
		if (!candidate || typeof candidate !== "object") {
			throw new Error(`Screenshot target ${index} must be an object`);
		}
		const record = candidate as Record<string, unknown>;
		if (typeof record.id !== "string" || !/^[a-z0-9._-]+$/.test(record.id)) {
			throw new Error(`Screenshot target ${index} id is invalid`);
		}
		if (typeof record.url !== "string") {
			throw new Error(`Screenshot target ${index} URL is required`);
		}
		const url = new URL(record.url);
		if (url.protocol !== "https:" || url.username || url.password) {
			throw new Error(
				`Screenshot target ${index} must use credential-free HTTPS`,
			);
		}
		return { id: record.id, url: url.toString() };
	});
}

async function captureKnownTarget(input: {
	name: string;
	targetId?: string;
	renderer?: ScreenshotRendererConfig;
	fetch?: FetchLike;
}): Promise<ArtifactFile> {
	if (!input.renderer?.endpoint || !input.renderer.token.trim()) {
		throw new Error("Screenshot renderer is not configured");
	}
	const target = input.renderer.targets.find(
		(candidate) => candidate.id === input.targetId,
	);
	if (!target) {
		throw new Error("Screenshot target is not allowlisted");
	}
	const endpoint = new URL(input.renderer.endpoint);
	if (endpoint.protocol !== "https:") {
		throw new Error("Screenshot renderer endpoint must use HTTPS");
	}
	const response = await (input.fetch ?? fetch)(endpoint, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${input.renderer.token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ targetId: target.id }),
	});
	if (!response.ok) {
		throw new Error(`Screenshot renderer failed (${response.status})`);
	}
	const contentType = response.headers.get("content-type")?.split(";")[0];
	if (contentType !== "image/png" && contentType !== "image/jpeg") {
		throw new Error("Screenshot renderer returned an unsupported content type");
	}
	const data = new Uint8Array(await response.arrayBuffer());
	assertSize(data.byteLength);
	return {
		filename: `${input.name}.${contentType === "image/png" ? "png" : "jpg"}`,
		contentType,
		data,
		bytes: data.byteLength,
	};
}

function renderMarkdown(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	return `\`\`\`json\n${JSON.stringify(content, null, 2)}\n\`\`\`\n`;
}

function renderCsv(content: unknown): string {
	if (!Array.isArray(content)) {
		throw new Error("CSV artifact content must be an array of objects");
	}
	if (content.length === 0) {
		return "";
	}
	if (
		content.some((row) => !row || typeof row !== "object" || Array.isArray(row))
	) {
		throw new Error("CSV artifact rows must be objects");
	}
	const rows = content as Record<string, unknown>[];
	const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
	return [
		headers.map(csvCell).join(","),
		...rows.map((row) =>
			headers.map((header) => csvCell(row[header])).join(","),
		),
	].join("\n");
}

function csvCell(value: unknown): string {
	const text = value === undefined || value === null ? "" : String(value);
	return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function safeBaseName(value: string): string {
	const safe = value
		.trim()
		.replace(safeNamePattern, "-")
		.replace(/^-+|-+$/g, "");
	return (safe || "artifact").slice(0, 80);
}

function assertSize(bytes: number): void {
	if (bytes > maxArtifactBytes) {
		throw new Error("Artifact exceeds the Discord upload safety limit");
	}
}

function extension(kind: Exclude<ArtifactKind, "screenshot">): string {
	return kind === "markdown" ? "md" : kind;
}

function contentType(kind: Exclude<ArtifactKind, "screenshot">): string {
	if (kind === "markdown") return "text/markdown; charset=utf-8";
	if (kind === "csv") return "text/csv; charset=utf-8";
	return "application/json; charset=utf-8";
}
