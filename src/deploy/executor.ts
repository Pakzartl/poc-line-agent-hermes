import type { DeployPlan, DeployTarget } from "./plan";

type FetchLike = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

export type DeployExecutionResult = {
	executionId: string;
	status: "accepted";
	statusUrl?: string;
};

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

	const response = await (input.fetch ?? fetch)(target.executorUrl, {
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
	if (!response.ok) {
		throw new Error(`Deploy executor rejected the plan (${response.status})`);
	}
	const raw = (await response.json()) as Record<string, unknown>;
	if (typeof raw.executionId !== "string" || !raw.executionId.trim()) {
		throw new Error("Deploy executor returned an invalid execution id");
	}
	return {
		executionId: raw.executionId,
		status: "accepted",
		...(typeof raw.statusUrl === "string" && raw.statusUrl.trim()
			? { statusUrl: raw.statusUrl }
			: {}),
	};
}
