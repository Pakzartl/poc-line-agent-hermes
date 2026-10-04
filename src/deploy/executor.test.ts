import { describe, expect, test } from "bun:test";
import {
	DeployExecutionRejectedError,
	DeployExecutionUncertainError,
	executeApprovedDeploy,
} from "./executor";
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
				return Response.json({
					executionId: "exec-1",
					status: "succeeded",
					replayed: false,
					artifact: { id: "exec-1", status: "succeeded" },
				});
			},
		});
		expect(result.executionId).toBe("exec-1");
		expect(request?.headers.get("Idempotency-Key")).toBe(plan.id);
		const body = (await request?.json()) as Record<string, unknown>;
		expect(body.commitSha).toBe("b".repeat(40));
		expect(body.digest).toBe(plan.digest);
		expect(body.targetId).toBe("staging");
		expect(body.approvedBy).toBe("approver");
		expect(body).not.toHaveProperty("command");
	});

	test("returns a failed executor artifact so callers can show rollback guidance", async () => {
		const plan = await createDeployPlan(
			{
				targetId: "staging",
				repository: "owner/repo",
				commitSha: "d".repeat(40),
				requestedBy: "requester",
			},
			targets,
		);
		const result = await executeApprovedDeploy({
			plan,
			targets,
			approvedBy: "approver",
			approvedDigest: plan.digest,
			executorToken: "secret",
			fetch: async () =>
				Response.json(
					{
						executionId: "exec-failed",
						replayed: false,
						artifact: {
							id: "exec-failed",
							status: "failed",
							rollbackGuidance: {
								requiresSeparateApproval: true,
								reason: "health failed",
							},
						},
					},
					{ status: 502 },
				),
		});
		expect(result.status).toBe("failed");
		expect(result.artifact.rollbackGuidance).toBeDefined();
	});

	test("marks transport failure and invalid success responses as uncertain", async () => {
		const plan = await createDeployPlan(
			{
				targetId: "staging",
				repository: "owner/repo",
				commitSha: "e".repeat(40),
				requestedBy: "requester",
			},
			targets,
		);
		await expect(
			executeApprovedDeploy({
				plan,
				targets,
				approvedBy: "approver",
				approvedDigest: plan.digest,
				executorToken: "secret",
				fetch: async () => {
					throw new Error("socket closed");
				},
			}),
		).rejects.toBeInstanceOf(DeployExecutionUncertainError);

		await expect(
			executeApprovedDeploy({
				plan,
				targets,
				approvedBy: "approver",
				approvedDigest: plan.digest,
				executorToken: "secret",
				fetch: async () => Response.json({ ok: true }),
			}),
		).rejects.toBeInstanceOf(DeployExecutionUncertainError);
	});

	test("treats executor 4xx rejection as non-retryable", async () => {
		const plan = await createDeployPlan(
			{
				targetId: "staging",
				repository: "owner/repo",
				commitSha: "f".repeat(40),
				requestedBy: "requester",
			},
			targets,
		);
		let error: unknown;
		try {
			await executeApprovedDeploy({
				plan,
				targets,
				approvedBy: "approver",
				approvedDigest: plan.digest,
				executorToken: "secret",
				fetch: async () =>
					Response.json({ error: "invalid target" }, { status: 400 }),
			});
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(DeployExecutionRejectedError);
		expect((error as DeployExecutionRejectedError).retryable).toBe(false);
		expect((error as DeployExecutionRejectedError).status).toBe(400);
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
