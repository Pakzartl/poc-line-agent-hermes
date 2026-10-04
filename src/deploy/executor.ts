import type { DeployPlan, DeployTarget } from "./plan";

type FetchLike = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

export type DeployExecutionResult = {
	executionId: string;
	status: "succeeded" | "failed";
	replayed: boolean;
	artifact: Record<string, unknown>;
	statusUrl?: string;
};

export class DeployExecutionUncertainError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DeployExecutionUncertainError";
	}
}

export async function executeApprovedDeploy(input: {
	plan: DeployPlan;
	targets: readonly DeployTarget[];
	approvedBy: string;
	approvedDigest: string;
	executorToken: string;
	fetch?: FetchLike;
}): Promise<DeployExecutionResult> {
	if (!input.approvedBy.trim()) {
		throw new Error("Deploy approver is required");
	}
	if (input.approvedDigest !== input.plan.digest) {
		throw new Error("Deploy approval does not match the immutable plan");
	}
	if (Date.parse(input.plan.expiresAt) <= Date.now()) {
		throw new Error("Deploy approval has expired");
	}
	const target = input.targets.find(
		(candidate) => candidate.id === input.plan.targetId,
	);
	if (!target || !target.allowedRepositories.includes(input.plan.repository)) {
		throw new Error("Deploy target is no longer allowlisted");
	}
	if (!input.executorToken.trim()) {
		throw new Error("Deploy executor is not configured");
	}

	let response: Response;
	try {
		response = await (input.fetch ?? fetch)(target.executorUrl, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${input.executorToken}`,
				"Content-Type": "application/json",
				"Idempotency-Key": input.plan.id,
			},
			body: JSON.stringify({
				version: input.plan.version,
				planId: input.plan.id,
				digest: input.plan.digest,
				repository: input.plan.repository,
				commitSha: input.plan.commitSha,
				targetId: input.plan.targetId,
				environment: input.plan.environment,
				requestedBy: input.plan.requestedBy,
				approvedBy: input.approvedBy,
			}),
		});
	} catch (error) {
		throw new DeployExecutionUncertainError(
			`Deploy executor could not be reached after submission: ${error instanceof Error ? error.message : "network error"}`,
		);
	}
	let raw: Record<string, unknown>;
	try {
		raw = (await response.json()) as Record<string, unknown>;
	} catch {
		throw new DeployExecutionUncertainError(
			`Deploy executor returned an unreadable response (${response.status})`,
		);
	}
	const artifact = isRecord(raw.artifact) ? raw.artifact : undefined;
	const executionId =
		typeof raw.executionId === "string" && raw.executionId.trim()
			? raw.executionId
			: undefined;
	const status =
		artifact?.status === "succeeded" || artifact?.status === "failed"
			? artifact.status
			: undefined;
	if (artifact && executionId && status) {
		return {
			executionId,
			status,
			replayed: raw.replayed === true,
			artifact,
			...(typeof raw.statusUrl === "string" && raw.statusUrl.trim()
				? { statusUrl: raw.statusUrl }
				: {}),
		};
	}
	if (response.status >= 500) {
		throw new DeployExecutionUncertainError(
			`Deploy executor state is uncertain (${response.status})`,
		);
	}
	if (!response.ok) {
		throw new Error(`Deploy executor rejected the plan (${response.status})`);
	}
	throw new DeployExecutionUncertainError(
		"Deploy executor returned a success response without a verifiable artifact",
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
