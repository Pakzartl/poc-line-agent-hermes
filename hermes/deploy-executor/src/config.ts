export type DeployTarget = {
	id: string;
	repo: string;
	composeFile: string;
	sourceSubdir: string;
	appDir: string;
	backupDir: string;
	healthUrl: string;
};

export type DeployExecutorConfig = {
	port: number;
	token: string;
	stateDir: string;
	targets: readonly DeployTarget[];
};

const idPattern = /^[a-z0-9._-]+$/;
const shaPattern = /^[0-9a-f]{40}$/;

export function loadDeployExecutorConfig(
	env: Readonly<Record<string, string | undefined>>,
): DeployExecutorConfig {
	const port = Number(env.DEPLOY_EXECUTOR_PORT ?? "8790");
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error("DEPLOY_EXECUTOR_PORT must be a valid TCP port");
	}
	const token = env.DEPLOY_EXECUTOR_TOKEN?.trim() ?? "";
	if (token.length < 32) {
		throw new Error("DEPLOY_EXECUTOR_TOKEN must be at least 32 characters");
	}
	const stateDir = requireAbsoluteDirectory(
		env.DEPLOY_EXECUTOR_STATE_DIR ?? "/srv/hermes/deploy-executor",
		"DEPLOY_EXECUTOR_STATE_DIR",
	);
	return {
		port,
		token,
		stateDir,
		targets: parseDeployTargets(env.DEPLOY_EXECUTOR_TARGETS_JSON),
	};
}

export function parseDeployTargets(raw: string | undefined): DeployTarget[] {
	if (!raw?.trim()) {
		throw new Error("DEPLOY_EXECUTOR_TARGETS_JSON is required");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("DEPLOY_EXECUTOR_TARGETS_JSON must be valid JSON");
	}
	if (!Array.isArray(parsed) || parsed.length !== 1) {
		throw new Error(
			"DEPLOY_EXECUTOR_TARGETS_JSON must contain exactly one target",
		);
	}
	const seen = new Set<string>();
	return parsed.map((candidate, index) => {
		if (!candidate || typeof candidate !== "object") {
			throw new Error(`deploy target ${index} must be an object`);
		}
		const record = candidate as Record<string, unknown>;
		const id = requireString(record.id, `deploy target ${index} id`);
		if (!idPattern.test(id)) {
			throw new Error(`deploy target ${index} id is invalid`);
		}
		if (seen.has(id)) {
			throw new Error(`deploy target ${id} is duplicated`);
		}
		seen.add(id);
		const repo = parsePublicRepo(
			requireString(record.repo, `deploy target ${id} repo`),
		);
		const composeFile = requireRelativePath(
			record.composeFile ?? "hermes/compose.yaml",
			`deploy target ${id} composeFile`,
		);
		const sourceSubdir = requireRelativePath(
			record.sourceSubdir ?? "hermes",
			`deploy target ${id} sourceSubdir`,
		);
		const appDir = requireAbsoluteDirectory(
			record.appDir ?? "/srv/hermes/app",
			`deploy target ${id} appDir`,
		);
		const backupDir = requireAbsoluteDirectory(
			record.backupDir ?? "/srv/hermes/backups",
			`deploy target ${id} backupDir`,
		);
		const healthUrl = parseLocalHealthUrl(
			requireString(record.healthUrl, `deploy target ${id} healthUrl`),
			`deploy target ${id} healthUrl`,
		);
		return {
			id,
			repo,
			composeFile,
			sourceSubdir,
			appDir,
			backupDir,
			healthUrl,
		};
	});
}

export function isImmutableSha(candidate: string): boolean {
	return shaPattern.test(candidate);
}

function parsePublicRepo(raw: string): string {
	const url = new URL(raw);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.hash ||
		url.search
	) {
		throw new Error("deploy target repo must be credential-free HTTPS");
	}
	if (url.hostname !== "github.com") {
		throw new Error("deploy target repo must be hosted on github.com");
	}
	const parts = url.pathname.split("/").filter(Boolean);
	if (parts.length !== 2) {
		throw new Error("deploy target repo must be /owner/name");
	}
	const [owner, name] = parts as [string, string];
	return `https://github.com/${owner}/${name.replace(/\.git$/, "")}.git`;
}

function parseLocalHealthUrl(raw: string, field: string): string {
	const url = new URL(raw);
	if (url.protocol !== "http:") {
		throw new Error(`${field} must use http`);
	}
	if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
		throw new Error(`${field} must point to localhost`);
	}
	return url.toString();
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`${field} is required`);
	}
	return value.trim();
}

function requireRelativePath(value: unknown, field: string): string {
	const path = requireString(value, field);
	if (path.startsWith("/") || path.includes("..") || path.includes("\0")) {
		throw new Error(`${field} must be a safe relative path`);
	}
	return path.replace(/\/+$/, "");
}

function requireAbsoluteDirectory(value: unknown, field: string): string {
	const path = requireString(value, field).replace(/\/+$/, "");
	if (!path.startsWith("/") || path === "" || path === "/") {
		throw new Error(`${field} must be an absolute directory, not /`);
	}
	if (path.includes("\0")) {
		throw new Error(`${field} is invalid`);
	}
	return path;
}
