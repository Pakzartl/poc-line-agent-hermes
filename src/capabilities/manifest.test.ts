import { describe, expect, test } from "bun:test";
import {
	assertValidCapabilityManifests,
	listCapabilityManifests,
	renderCapabilityList,
	validateCapabilityManifest,
	type CapabilityManifest,
} from "./manifest";

describe("capability manifest", () => {
	test("publishes deterministic demoable capabilities", () => {
		assertValidCapabilityManifests();

		expect(listCapabilityManifests().map((manifest) => manifest.id)).toEqual([
			"code-investigation",
			"risk-assessment",
			"queue-failure",
			"db-read",
			"artifact",
			"deploy",
		]);
		expect(renderCapabilityList()).toContain("**/code**");
		expect(renderCapabilityList()).toContain("**/deploy**");
		expect(renderCapabilityList()).toContain("approval-gated");
	});

	test("rejects mutation capabilities without explicit approval declaration", () => {
		const manifest: CapabilityManifest = {
			id: "unsafe-deploy",
			name: "/unsafe",
			description: "unsafe",
			inputContract: "target",
			permissions: ["deploy:mutate"],
			steps: ["deploy"],
			outputArtifact: "none",
			verification: ["none"],
			failureBehavior: "unknown",
			demo: "/unsafe",
		};

		expect(validateCapabilityManifest(manifest)).toEqual([
			"unsafe-deploy mutates external state and must declare approval",
		]);
	});
});
