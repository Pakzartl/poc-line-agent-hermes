import { describe, expect, test } from "bun:test";
import { createDeployPlan, parseDeployTargets } from "./plan";

const sha = "a".repeat(40);

describe("deploy plan", () => {
	test("binds approval to an immutable allowlisted operation", async () => {
		const targets = parseDeployTargets(
			JSON.stringify([
				{
					id: "worker-prod",
					displayName: "Worker production",
					environment: "production",
					allowedRepositories: ["Pakzartl/poc-line-agent-hermes"],
					executorUrl: "https://deploy.pakzartl.xyz/v1/execute",
					healthcheckUrl: "https://agent.pakzartl.xyz/health",
				},
			]),
		);
		const plan = await createDeployPlan(
			{
				targetId: "worker-prod",
				repository: "Pakzartl/poc-line-agent-hermes",
				commitSha: sha,
				requestedBy: "discord-user-1",
				now: new Date("2026-10-04T00:00:00.000Z"),
			},
			targets,
		);
		expect(plan.id).toStartWith("deploy_");
		expect(plan.digest).toHaveLength(64);
		expect(plan.commitSha).toBe(sha);
		expect(plan.environment).toBe("production");
		expect(plan.rollback.requiresSeparateApproval).toBe(true);
	});

	test("defaults to no targets when deploy is not configured", () => {
		expect(parseDeployTargets(undefined)).toEqual([]);
	});

	test("rejects mutable refs and non-allowlisted repositories", async () => {
		const targets = parseDeployTargets(
			JSON.stringify([
				{
					id: "staging",
					displayName: "Staging",
					environment: "staging",
					allowedRepositories: ["owner/allowed"],
					executorUrl: "https://deploy.example.com/run",
				},
			]),
		);
		await expect(
			createDeployPlan(
				{
					targetId: "staging",
					repository: "owner/other",
					commitSha: "main",
					requestedBy: "user",
				},
				targets,
			),
		).rejects.toThrow();
	});
});
