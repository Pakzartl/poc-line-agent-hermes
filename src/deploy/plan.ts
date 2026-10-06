export type DeployEnvironment = "development" | "staging" | "production";

export type DeployTarget = {
	id: string;
	displayName: string;
	environment: DeployEnvironment;
	allowedRepositories: readonly string[];
	executorUrl: string;
	healthcheckUrl?: string;
	requiresApproval: true;
};

export type DeployPlan = {
	version: "DEPLOY_PLAN_V1";
	id: string;
	targetId: string;
	targetName: string;
	environment: DeployEnvironment;
	repository: string;
	commitSha: string;
	requestedBy: string;
	createdAt: string;
	expiresAt: string;
	digest: string;
	healthcheckUrl?: string;
	rollback: {
		strategy: "redeploy-previous-known-good";
		requiresSeparateApproval: true;
	};
};

export type DeployPlanInput = {
	targetId: string;
	repository: string;
	commitSha: string;
	requestedBy: string;
	now?: Date;
	ttlSeconds?: number;
};

const commitShaPattern = /^[0-9a-f]{40}$/i;
const targetIdPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const maxApprovalTtlSeconds = 30 * 60;

export async function createDeployPlan(
	input: DeployPlanInput,
	targets: readonly DeployTarget[],
): Promise<DeployPlan> {
	const target = targets.find((candidate) => candidate.id === input.targetId);
	if (!target || !targetIdPattern.test(input.targetId)) {
		throw new Error("Deploy target is not allowlisted");
	}
	if (!target.allowedRepositories.includes(input.repository)) {
		throw new Error("Repository is not allowlisted for this deploy target");
	}
	if (!commitShaPattern.test(input.commitSha)) {
		throw new Error("Deploy commit must be an immutable 40-character SHA");
	}
	if (!input.requestedBy.trim()) {
		throw new Error("Deploy requester is required");
	}
	assertHttpsUrl(target.executorUrl, "executor");
	if (target.healthcheckUrl) {
		assertHttpsUrl(target.healthcheckUrl, "healthcheck");
	}

	const now = input.now ?? new Date();
	const ttlSeconds = Math.min(
		Math.max(60, input.ttlSeconds ?? 10 * 60),
		maxApprovalTtlSeconds,
	);
	const createdAt = now.toISOString();
	const expiresAt = new Date(now.getTime() + ttlSeconds * 1_000).toISOString();
	const canonical = [
		"DEPLOY_PLAN_V1",
		target.id,
		target.environment,
		input.repository,
		input.commitSha.toLowerCase(),
		input.requestedBy,
		createdAt,
		expiresAt,
	].join("\n");
	const digest = await sha256(canonical);

	return {
		version: "DEPLOY_PLAN_V1",
		id: `deploy_${digest.slice(0, 24)}`,
		targetId: target.id,
		targetName: target.displayName,
		environment: target.environment,
		repository: input.repository,
		commitSha: input.commitSha.toLowerCase(),
		requestedBy: input.requestedBy,
		createdAt,
		expiresAt,
		digest,
		...(target.healthcheckUrl ? { healthcheckUrl: target.healthcheckUrl } : {}),
		rollback: {
			strategy: "redeploy-previous-known-good",
			requiresSeparateApproval: true,
		},
	};
}

export function parseDeployTargets(raw: string | undefined): DeployTarget[] {
	if (!raw?.trim()) {
		return [];
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Error("DEPLOY_TARGETS_JSON must contain valid JSON");
	}
	if (!Array.isArray(value)) {
		throw new Error("DEPLOY_TARGETS_JSON must be an array");
	}
	return value.map((candidate, index) => parseDeployTarget(candidate, index));
}

function parseDeployTarget(candidate: unknown, index: number): DeployTarget {
	if (!candidate || typeof candidate !== "object") {
		throw new Error(`Deploy target ${index} must be an object`);
	}
	const record = candidate as Record<string, unknown>;
	const id = requiredString(record.id, `Deploy target ${index} id`);
	if (!targetIdPattern.test(id)) {
		throw new Error(`Deploy target ${index} id is invalid`);
	}
	const environment = record.environment;
	if (
		environment !== "development" &&
		environment !== "staging" &&
		environment !== "production"
	) {
		throw new Error(`Deploy target ${index} environment is invalid`);
	}
	const repositories = record.allowedRepositories;
	if (
		!Array.isArray(repositories) ||
		repositories.length === 0 ||
		repositories.some((item) => typeof item !== "string" || !item.trim())
	) {
		throw new Error(`Deploy target ${index} requires allowedRepositories`);
	}
	const executorUrl = requiredString(
		record.executorUrl,
		`Deploy target ${index} executorUrl`,
	);
	assertHttpsUrl(executorUrl, "executor");
	const healthcheckUrl = optionalString(record.healthcheckUrl);
	if (healthcheckUrl) {
		assertHttpsUrl(healthcheckUrl, "healthcheck");
	}
	return {
		id,
		displayName: requiredString(
			record.displayName,
			`Deploy target ${index} displayName`,
		),
		environment,
		allowedRepositories: repositories.map((item) => (item as string).trim()),
		executorUrl,
		...(healthcheckUrl ? { healthcheckUrl } : {}),
		requiresApproval: true,
	};
}

function assertHttpsUrl(value: string, kind: string): void {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`Deploy ${kind} URL is invalid`);
	}
	if (url.protocol !== "https:" || url.username || url.password) {
		throw new Error(`Deploy ${kind} URL must be credential-free HTTPS`);
	}
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`${name} is required`);
	}
	return value.trim();
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}
