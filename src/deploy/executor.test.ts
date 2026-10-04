import { describe, expect, test } from "bun:test";
import { executeApprovedDeploy } from "./executor";
import { createDeployPlan, type DeployTarget } from "./plan";

const targets: DeployTarget[] = [
	{
		id: "staging",
		displayName: "Staging",
		environment: "staging",
		allowedRepositories: ["owner/repo"],
		executorUrl: "https://deploy.example.com/run",
		requiresApproval: true,
	},
];

describe("approved deploy executor", () => {
	test("sends only the finite plan after matching approval", async () => {
		const plan = await createDeployPlan(
			{
				targetId: "staging",
				repository: "owner/repo",
				commitSha: "b".repeat(40),
				requestedBy: "requester",
				now: new Date(Date.now()),
			},
			targets,
		);
		let request: Request | undefined;
		const result = await executeApprovedDeploy({
			plan,
			targets,
			approvedBy: "approver",
			approvedDigest: plan.digest,
			executorToken: "secret",
			fetch: async (input, init) => {
				request = new Request(input, init);
				return Response.json({ executionId: "exec-1" });
			},
		});
		expect(result.executionId).toBe("exec-1");
		expect(request?.headers.get("Idempotency-Key")).toBe(plan.id);
		const body = (await request?.json()) as Record<string, unknown>;
		expect(body.commitSha).toBe("b".repeat(40));
		expect(body).not.toHaveProperty("command");
	});

	test("blocks missing, expired, or mismatched approval", async () => {
		const plan = await createDeployPlan(
			{
				targetId: "staging",
				repository: "owner/repo",
				commitSha: "c".repeat(40),
				requestedBy: "requester",
				now: new Date("2020-01-01T00:00:00.000Z"),
			},
			targets,
		);
		await expect(
			executeApprovedDeploy({
				plan,
				targets,
				approvedBy: "approver",
				approvedDigest: "wrong",
				executorToken: "secret",
			}),
		).rejects.toThrow("does not match");
	});
});
