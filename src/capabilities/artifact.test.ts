import { describe, expect, test } from "bun:test";
import {
	type HilArtifactV1,
	hilArtifactVersion,
	renderHilArtifactMarkdown,
	safeArtifactFilename,
} from "./artifact";

const artifact: HilArtifactV1 = {
	version: hilArtifactVersion,
	artifactId: "artifact_test_1",
	title: "Risk Assessment: checkout deploy",
	capability: "risk-assessment",
	status: "waiting_approval",
	objective: "Review the checkout deployment before release.",
	source: {
		kind: "code",
		repository: "codemonday-dev/lms-backend",
		branch: "dev",
		commit: "abc123",
	},
	evidence: [
		{
			label: "Changed route",
			summary: "Checkout controller updates payment retry behavior.",
			path: "apps/api/src/checkout.ts",
			line: 42,
		},
	],
	findings: [
		{
			title: "Payment retry behavior changed",
			summary: "A failed retry now returns immediately.",
			severity: "medium",
			evidence: ["apps/api/src/checkout.ts:42"],
		},
	],
	risks: [
		{
			title: "Checkout conversion",
			impact: "Users may see payment failures earlier.",
			likelihood: "medium",
			mitigation: "Test failed payment and retry paths.",
		},
	],
	humanActions: [
		{
			label: "Run smoke test",
			description: "Verify successful and failed payment paths.",
			required: true,
		},
	],
	recommendedAction: "Approve only after checkout smoke tests pass.",
	metadata: {
		createdAt: "2026-10-04T14:30:00.000Z",
		correlationId: "job-123",
		owner: "Game",
		tags: ["release", "checkout"],
		inputs: { pr: 42 },
	},
};

describe("HIL artifact", () => {
	test("renders deterministic markdown with evidence and human actions", () => {
		expect(
			renderHilArtifactMarkdown(artifact),
		).toBe(`# Risk Assessment: checkout deploy

- Version: hil-artifact/v1
- Artifact ID: artifact_test_1
- Capability: risk-assessment
- Status: waiting_approval
- Created: 2026-10-04T14:30:00.000Z
- Correlation ID: job-123

## Objective

Review the checkout deployment before release.

## Source

- Kind: code
- Repository: codemonday-dev/lms-backend
- Branch: dev
- Commit: abc123

## Evidence

- Changed route: Checkout controller updates payment retry behavior.
  - Path: apps/api/src/checkout.ts:42

## Findings

- [medium] Payment retry behavior changed: A failed retry now returns immediately.
  - Evidence: apps/api/src/checkout.ts:42

## Risks

- Checkout conversion: Users may see payment failures earlier.
  - Likelihood: medium
  - Mitigation: Test failed payment and retry paths.

## Human Actions

- [required] Run smoke test: Verify successful and failed payment paths.

## Recommended Action

Approve only after checkout smoke tests pass.

## Metadata

- Owner: Game
- Tags: release, checkout
- Input pr: 42
`);
	});

	test("creates safe deterministic filenames", () => {
		expect(
			safeArtifactFilename({
				title: "../../Risk: ชำระเงิน? * deploy",
				capability: "risk assessment",
				createdAt: "2026-10-04T14:30:00.000Z",
				extension: ".md",
			}),
		).toBe("risk-assessment-risk-deploy-20261004143000.md");
	});
});
