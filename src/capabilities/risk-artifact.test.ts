import { describe, expect, test } from "bun:test";
import { buildRiskAssessmentArtifact } from "./risk-artifact";

describe("risk assessment artifact", () => {
	test("turns the required Hermes sections into deterministic HIL fields", () => {
		const artifact = buildRiskAssessmentArtifact({
			artifactId: "artifact-risk-1",
			objective: "Release checkout retries",
			repository: "owner/repo",
			branch: "feature/retry",
			baseRef: "main",
			createdAt: "2026-10-05T00:00:00.000Z",
			answer: `## Summary
Checkout retry behavior changes.

## Blast Radius
- Checkout API: retry decisions change.
- Payment worker: receives fewer retries.

## Evidence
- \`apps/api/checkout.ts:42\` changes the retry branch.
- \`apps/worker/payment.ts:18\` consumes the event.

## Risks
- [high] Lost retries: transient payment failures may become final.
- [low] Metrics drift: retry counters will decrease.

## Human Test Plan
- Run successful payment checkout.
- Simulate one transient failure and verify recovery.

## Evidence Gaps
- Production payment-provider retry policy is not stored in this repository.

## Recommended Action
Approve only after both payment tests pass.`,
		});

		expect(artifact.artifactId).toBe("artifact-risk-1");
		expect(artifact.evidence.map((item) => item.path)).toEqual([
			"apps/api/checkout.ts:42",
			"apps/worker/payment.ts:18",
		]);
		expect(artifact.findings).toHaveLength(4);
		expect(artifact.risks).toMatchObject([
			{ title: "Lost retries", severity: "high", likelihood: "high" },
			{ title: "Metrics drift", severity: "low", likelihood: "low" },
		]);
		expect(artifact.humanActions).toHaveLength(2);
		expect(artifact.humanActions.every((item) => item.required)).toBe(true);
		expect(artifact.recommendedAction).toBe(
			"Approve only after both payment tests pass.",
		);
	});

	test("fails visibly closed when the model omits the structured contract", () => {
		const artifact = buildRiskAssessmentArtifact({
			artifactId: "artifact-risk-2",
			objective: "Unknown change",
			repository: "owner/repo",
			branch: "dev",
			createdAt: "2026-10-05T00:00:00.000Z",
			answer: "Looks fine.",
		});

		expect(artifact.evidence[0]?.label).toBe("Evidence gap");
		expect(artifact.risks[0]?.title).toBe("Structured risk evidence missing");
		expect(artifact.humanActions[0]?.label).toBe("Create a Human Test Plan");
		expect(artifact.recommendedAction).toContain("Do not approve release");
	});
});
