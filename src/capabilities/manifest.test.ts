import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	assertValidCapabilityManifests,
	type CapabilityManifest,
	listCapabilityManifests,
	renderCapabilityList,
	validateCapabilityManifest,
	validateSkillMirrorInventory,
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
			maxOutputBytes: 1_000,
			verification: ["none"],
			failureBehavior: "unknown",
			demo: "/unsafe",
		};

		expect(validateCapabilityManifest(manifest)).toEqual([
			"unsafe-deploy mutates external state and must declare approval",
		]);
	});

	test("rejects unknown permissions, missing demos, and unbounded output", () => {
		const invalid = {
			...listCapabilityManifests()[0],
			demo: "",
			maxOutputBytes: 0,
			permissions: ["filesystem:write"],
		} as unknown as CapabilityManifest;
		expect(validateCapabilityManifest(invalid)).toEqual([
			"code-investigation is missing demo",
			"code-investigation declares unknown permission filesystem:write",
			"code-investigation must declare maxOutputBytes between 1 and 7500000",
		]);
	});

	test("keeps every source skill mirrored and non-empty in Hermes", async () => {
		const here = dirname(fileURLToPath(import.meta.url));
		const sourceDir = join(here, "..", "skills");
		const hermesDir = join(here, "..", "..", "hermes", "skills");
		const sourceNames = (await readdir(sourceDir))
			.filter((name) => name.endsWith(".md"))
			.map((name) => basename(name, ".md"))
			.sort();
		const hermesNames = (await readdir(hermesDir)).sort();
		expect(
			validateSkillMirrorInventory({
				sourceSkillNames: sourceNames,
				hermesSkillNames: hermesNames,
			}),
		).toEqual([]);
		for (const name of hermesNames) {
			const content = await readFile(join(hermesDir, name, "SKILL.md"), "utf8");
			expect(content.trim().length).toBeGreaterThan(40);
		}
	});
});
