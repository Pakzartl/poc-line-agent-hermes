import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { skillNames } from "../agent/skill-manager";
import { validateSkillMirrorInventory } from "./manifest";
import {
	assertValidSkillContractManifests,
	renderSkillContractInventory,
	skillContractManifests,
	skillContractVersion,
	validateSkillContractManifest,
} from "./skill-contract";

describe("runtime skill contracts", () => {
	test("every enabled skill has a bounded versioned contract", () => {
		assertValidSkillContractManifests();
		expect(skillContractManifests.map((manifest) => manifest.id)).toEqual([
			...skillNames,
		]);
		for (const manifest of skillContractManifests) {
			expect(manifest.version).toBe(skillContractVersion);
			expect(manifest.permissions.length).toBeGreaterThan(0);
			expect(manifest.outputArtifact.length).toBeGreaterThan(0);
			expect(manifest.verification.length).toBeGreaterThan(0);
			expect(manifest.failureBehavior.length).toBeGreaterThan(0);
			expect(manifest.demo.length).toBeGreaterThan(0);
			expect(manifest.maxOutputBytes).toBeGreaterThan(0);
		}
	});

	test("every contract has both source and Hermes skill content", async () => {
		const here = dirname(fileURLToPath(import.meta.url));
		const sourceNames = (await readdir(join(here, "..", "skills")))
			.filter((name) => name.endsWith(".md"))
			.map((name) => name.slice(0, -3));
		const hermesNames = (
			await readdir(join(here, "..", "..", "hermes", "skills"), {
				withFileTypes: true,
			})
		)
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);

		expect(
			validateSkillMirrorInventory({
				sourceSkillNames: sourceNames,
				hermesSkillNames: hermesNames,
			}),
		).toEqual([]);
		expect(new Set(sourceNames)).toEqual(new Set(skillNames));
		expect(new Set(hermesNames)).toEqual(new Set(skillNames));
	});

	test("rejects unknown permission, missing verifier, mutation without approval, and unbounded output", () => {
		const base = skillContractManifests[0];
		if (!base) throw new Error("missing skill fixture");
		const errors = validateSkillContractManifest({
			...base,
			permissions: ["shell:write" as never],
			verification: [],
			maxOutputBytes: Number.MAX_SAFE_INTEGER,
		});
		expect(errors.join(" ")).toContain("unknown permission");
		expect(errors.join(" ")).toContain("verification");
		expect(errors.join(" ")).toContain("maxOutputBytes");

		const deploy = skillContractManifests.find(
			(manifest) => manifest.id === "deploy",
		);
		if (!deploy) throw new Error("missing deploy fixture");
		expect(
			validateSkillContractManifest({
				...deploy,
				requiresApproval: false,
				approvalDeclaration: "",
			}).join(" "),
		).toContain("must declare approval");
	});

	test("renders a compact Discord inventory", () => {
		const rendered = renderSkillContractInventory();
		expect(rendered).toContain(skillContractVersion);
		expect(rendered).toContain("`risk-assessment`");
		expect(rendered).toContain("approval-gated deploy");
		expect(rendered.length).toBeLessThan(600);
	});
});
