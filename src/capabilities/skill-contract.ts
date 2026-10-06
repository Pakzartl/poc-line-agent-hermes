import { type SkillName, skillNames } from "../agent/skill-manager";
import type { CapabilityPermission } from "./manifest";

export const skillContractVersion = "skill-contract/v1" as const;

export type SkillContractManifest = {
	version: typeof skillContractVersion;
	id: SkillName;
	name: string;
	description: string;
	inputContract: string;
	permissions: readonly CapabilityPermission[];
	steps: readonly string[];
	outputArtifact: string;
	maxOutputBytes: number;
	verification: readonly string[];
	failureBehavior: string;
	demo: string;
	requiresApproval?: boolean;
	approvalDeclaration?: string;
};

type SkillDefinition = Omit<
	SkillContractManifest,
	"version" | "id" | "permissions" | "steps" | "maxOutputBytes"
> & {
	permissions?: readonly CapabilityPermission[];
	steps?: readonly string[];
	maxOutputBytes?: number;
};

const skillDefinitions: Record<SkillName, SkillDefinition> = {
	"repo-overview": {
		name: "Repository overview",
		description:
			"Map the selected repository's purpose, layout, and entry points.",
		inputContract: "explicit repository and Git ref plus an overview question",
		outputArtifact: "Repository overview HIL artifact",
		verification: ["Cites entry points and repository-relative paths"],
		failureBehavior: "State which repository evidence could not be inspected.",
		demo: "Summarize this repository and its main entry points.",
	},
	"find-code": {
		name: "Find code",
		description: "Locate concrete files, symbols, routes, or configuration.",
		inputContract:
			"explicit repository and Git ref plus a bounded search objective",
		outputArtifact: "Code-location HIL artifact",
		verification: ["Reports exact paths or an explicit no-match result"],
		failureBehavior: "Return no-match evidence instead of guessing a location.",
		demo: "Find where request throttling is configured.",
	},
	"code-scan": {
		name: "Code scan",
		description:
			"Search the selected source broadly for an implementation concern.",
		inputContract: "explicit repository and Git ref plus a repo-wide concern",
		outputArtifact: "Repository scan HIL artifact",
		verification: [
			"Distinguishes registered behavior from dead, example, and dependency code",
		],
		failureBehavior:
			"Report incomplete coverage and evidence gaps without inferring absence.",
		demo: "Scan every gateway for active rate limiting.",
	},
	"explain-code": {
		name: "Explain code",
		description: "Explain selected source behavior using repository evidence.",
		inputContract:
			"explicit repository and Git ref plus file, symbol, or behavior",
		outputArtifact: "Code explanation HIL artifact",
		verification: ["Connects claims to cited files or symbols"],
		failureBehavior:
			"Mark ambiguous control flow and missing runtime evidence.",
		demo: "Explain how authentication is enforced in the learner gateway.",
	},
	"trace-feature": {
		name: "Trace feature",
		description: "Trace a request, data, or call path across modules.",
		inputContract: "explicit repository and Git ref plus a named flow",
		outputArtifact: "Feature trace HIL artifact",
		verification: ["Includes ordered hops with cited paths or symbols"],
		failureBehavior: "Stop at the last evidenced hop and label the gap.",
		demo: "Trace the video-stamp request from gateway to persistence.",
	},
	"recent-changes": {
		name: "Recent changes",
		description: "Summarize bounded recent Git history for the selected ref.",
		inputContract:
			"explicit repository and Git ref plus a bounded time or commit range",
		outputArtifact: "Recent-change HIL artifact",
		verification: ["Names commits and affected repository-relative paths"],
		failureBehavior:
			"State when history depth or source access is insufficient.",
		demo: "Summarize changes from the last 10 commits.",
	},
	"commit-review": {
		name: "Commit review",
		description: "Review one immutable commit and its bounded impact.",
		inputContract: "explicit repository, Git ref, and immutable commit SHA",
		outputArtifact: "Commit review HIL artifact",
		verification: ["Binds findings to the requested commit SHA"],
		failureBehavior: "Reject missing or ambiguous commit identity.",
		demo: "Review commit 0123456789abcdef0123456789abcdef01234567.",
	},
	"pr-review": {
		name: "Pull request review",
		description: "Review a pull-request diff and relevant callers and tests.",
		inputContract:
			"explicit repository and pull request or immutable head/base refs",
		outputArtifact: "Pull-request review HIL artifact",
		verification: ["Separates diff evidence from repository context"],
		failureBehavior:
			"Reject origin mismatch or unavailable comparison evidence.",
		demo: "Review PR 123 and identify correctness risks.",
	},
	"bug-investigator": {
		name: "Bug investigator",
		description:
			"Investigate a reported failure and rank evidence-backed causes.",
		inputContract:
			"explicit repository and Git ref plus symptom and available evidence",
		outputArtifact: "Bug investigation HIL artifact",
		verification: ["Separates observed evidence, hypotheses, and next checks"],
		failureBehavior:
			"Lower confidence when reproduction or runtime evidence is absent.",
		demo: "Investigate why learner login returns HTTP 500.",
	},
	"test-finder": {
		name: "Test finder",
		description: "Locate tests that cover a selected behavior.",
		inputContract: "explicit repository and Git ref plus behavior or symbol",
		outputArtifact: "Related-test HIL artifact",
		verification: ["Cites test files and the behavior each assertion covers"],
		failureBehavior:
			"Return an explicit no-test-found result with search scope.",
		demo: "Find tests for rate-limit rejection behavior.",
	},
	"missing-tests": {
		name: "Missing tests",
		description:
			"Identify important untested paths and propose executable cases.",
		inputContract:
			"explicit repository and Git ref plus target behavior or change",
		outputArtifact: "Test-gap HIL artifact",
		verification: ["Maps each proposed test to a concrete uncovered branch"],
		failureBehavior: "Do not claim coverage from filenames alone.",
		demo: "Identify missing tests for the queue retry flow.",
	},
	"dependency-check": {
		name: "Dependency check",
		description: "Inspect how a dependency is declared and used in source.",
		inputContract:
			"explicit repository and Git ref plus dependency name or concern",
		outputArtifact: "Dependency inspection HIL artifact",
		verification: [
			"Cites manifest, lockfile, and relevant imports when present",
		],
		failureBehavior:
			"Distinguish source evidence from external package assumptions.",
		demo: "Check where @nestjs/throttler is declared and used.",
	},
	"security-review": {
		name: "Security review",
		description: "Inspect bounded source for concrete security risks.",
		inputContract: "explicit repository and Git ref plus security objective",
		outputArtifact: "Security review HIL artifact",
		verification: [
			"Ranks findings by severity and cites exploit-relevant evidence",
		],
		failureBehavior:
			"Do not claim safety when the inspected surface is incomplete.",
		demo: "Review authorization boundaries for the admin gateway.",
	},
	"config-explainer": {
		name: "Configuration explainer",
		description: "Trace configuration declarations to their runtime consumers.",
		inputContract:
			"explicit repository and Git ref plus config key or behavior",
		outputArtifact: "Configuration trace HIL artifact",
		verification: ["Cites declarations, defaults, and consumers"],
		failureBehavior:
			"Never expose secret values; report only names and behavior.",
		demo: "Explain how Redis configuration reaches the learner gateway.",
	},
	"api-catalog": {
		name: "API catalog",
		description: "Catalog registered HTTP endpoints and their handlers.",
		inputContract: "explicit repository and Git ref plus optional module scope",
		outputArtifact: "API catalog HIL artifact",
		verification: [
			"Separates registered routes from unregistered example code",
		],
		failureBehavior: "Label routes whose registration cannot be proven.",
		demo: "Catalog learner-gateway routes and handlers.",
	},
	"database-map": {
		name: "Database map",
		description:
			"Map source-defined schemas, entities, migrations, and repositories.",
		inputContract: "explicit repository and Git ref plus optional domain scope",
		outputArtifact: "Source database-map HIL artifact",
		verification: [
			"Cites schema or entity declarations without querying live data",
		],
		failureBehavior:
			"State that source structure is not proof of production state.",
		demo: "Map course entities and their relations from source.",
	},
	"architecture-map": {
		name: "Architecture map",
		description: "Build an evidence-backed map of components and dependencies.",
		inputContract:
			"explicit repository and Git ref plus architecture objective",
		outputArtifact: "Architecture map HIL artifact",
		verification: ["Every major edge cites a source file or configuration"],
		failureBehavior: "Mark inferred or runtime-only edges as unverified.",
		demo: "Map gateways, services, queues, and databases.",
	},
	"onboarding-guide": {
		name: "Onboarding guide",
		description: "Create an evidence-backed developer onboarding path.",
		inputContract: "explicit repository and Git ref plus audience or task",
		outputArtifact: "Developer onboarding HIL artifact",
		verification: ["Cites actual setup scripts, entry points, and tests"],
		failureBehavior:
			"Flag missing setup evidence instead of inventing commands.",
		demo: "Create a first-day guide for a backend developer.",
	},
	"release-summary": {
		name: "Release summary",
		description:
			"Summarize a bounded comparison into human-visible release impact.",
		inputContract: "explicit repository plus immutable base and head refs",
		outputArtifact: "Release summary HIL artifact",
		verification: ["Binds summary to the compared refs and changed paths"],
		failureBehavior: "Reject ambiguous or unavailable comparison refs.",
		demo: "Summarize changes between v1.2.0 and v1.3.0.",
	},
	"incident-triage": {
		name: "Incident triage",
		description: "Correlate supplied incident evidence with selected source.",
		inputContract:
			"explicit repository and Git ref plus sanitized incident evidence",
		outputArtifact: "Incident triage HIL artifact",
		verification: [
			"Separates symptoms, likely categories, evidence gaps, and checks",
		],
		failureBehavior: "Do not claim root cause without sufficient evidence.",
		demo: "Triage repeated queue timeouts after the latest release.",
	},
	"repo-comparison": {
		name: "Repository comparison",
		description:
			"Compare bounded implementations across explicit repositories and refs.",
		inputContract:
			"two explicit repositories and Git refs plus comparison objective",
		outputArtifact: "Repository comparison HIL artifact",
		verification: [
			"Attributes every difference to the correct repository and ref",
		],
		failureBehavior: "Stop if either source scope cannot be verified.",
		demo: "Compare authentication setup between backend repositories.",
	},
	"risk-assessment": {
		name: "Risk assessment",
		description:
			"Assess blast radius and produce a Human Test Plan before release.",
		inputContract:
			"explicit repository, head ref, optional base ref, and release intent",
		outputArtifact: "Risk assessment HIL artifact with Human Test Plan",
		verification: [
			"Includes severity, blast radius, evidence gaps, and human tests",
		],
		failureBehavior: "Never infer deployment state from source alone.",
		demo: "Assess risk of deploying learner-gateway throttling changes.",
	},
	deploy: {
		name: "Deploy",
		description:
			"Prepare and execute one allowlisted immutable deployment after approval.",
		inputContract:
			"allowlisted repository, target, and immutable 40-character commit SHA",
		permissions: ["github:read", "deploy:mutate"],
		steps: [
			"Verify the immutable source and allowlisted target",
			"Create preflight, risk, and rollback guidance",
			"Require a fresh single-use approval bound to the operation digest",
			"Invoke only the narrow deployment adapter and report health evidence",
		],
		outputArtifact: "Deployment result HIL artifact with rollback guidance",
		maxOutputBytes: 1_000_000,
		verification: [
			"Approval, exact commit, target, executor result, and health are auditable",
		],
		failureBehavior:
			"Fail closed on ambiguous source, stale approval, or uncertain execution.",
		demo: "/deploy repository:owner/repo commit_sha:<40-char-sha> target:hermes-ovh",
		requiresApproval: true,
		approvalDeclaration:
			"Deployment mutates external state and requires fresh human approval.",
	},
};

const defaultSteps = [
	"Validate the explicit repository and Git ref",
	"Inspect bounded source through read-only GitHub tools",
	"Produce cited findings and a downloadable HIL artifact",
] as const;

export const skillContractManifests: readonly SkillContractManifest[] =
	skillNames.map((id) => {
		const definition = skillDefinitions[id];
		return {
			version: skillContractVersion,
			id,
			...definition,
			permissions: definition.permissions ?? ["github:read"],
			steps: definition.steps ?? defaultSteps,
			maxOutputBytes: definition.maxOutputBytes ?? 1_000_000,
		};
	});

const knownPermissions = new Set<CapabilityPermission>([
	"github:read",
	"database:read",
	"artifact:create",
	"deploy:mutate",
	"event:ingest",
]);

export function validateSkillContractManifest(
	manifest: SkillContractManifest,
): string[] {
	const errors: string[] = [];
	for (const field of [
		"id",
		"name",
		"description",
		"inputContract",
		"outputArtifact",
		"failureBehavior",
		"demo",
	] as const) {
		if (!manifest[field].trim()) {
			errors.push(`${manifest.id || "skill"} is missing ${field}`);
		}
	}
	if (manifest.version !== skillContractVersion) {
		errors.push(`${manifest.id} has unsupported contract version`);
	}
	if (manifest.permissions.length === 0) {
		errors.push(`${manifest.id} must declare at least one permission`);
	}
	for (const permission of manifest.permissions) {
		if (!knownPermissions.has(permission)) {
			errors.push(`${manifest.id} declares unknown permission ${permission}`);
		}
	}
	if (manifest.steps.length === 0) {
		errors.push(`${manifest.id} must document at least one step`);
	}
	if (manifest.verification.length === 0) {
		errors.push(`${manifest.id} must document verification`);
	}
	if (
		!Number.isInteger(manifest.maxOutputBytes) ||
		manifest.maxOutputBytes < 1 ||
		manifest.maxOutputBytes > 7_500_000
	) {
		errors.push(
			`${manifest.id} must bound maxOutputBytes between 1 and 7500000`,
		);
	}
	if (
		manifest.permissions.includes("deploy:mutate") &&
		(!manifest.requiresApproval || !manifest.approvalDeclaration?.trim())
	) {
		errors.push(
			`${manifest.id} mutates external state and must declare approval`,
		);
	}
	return errors;
}

export function assertValidSkillContractManifests(
	manifests: readonly SkillContractManifest[] = skillContractManifests,
): void {
	const errors = manifests.flatMap(validateSkillContractManifest);
	const seen = new Set<string>();
	for (const manifest of manifests) {
		if (seen.has(manifest.id))
			errors.push(`duplicate skill contract ${manifest.id}`);
		seen.add(manifest.id);
	}
	for (const name of skillNames) {
		if (!seen.has(name))
			errors.push(`source skill ${name} is missing a manifest`);
	}
	for (const id of seen) {
		if (!skillNames.includes(id as SkillName)) {
			errors.push(`manifest ${id} is not an enabled source skill`);
		}
	}
	if (errors.length > 0) throw new Error(errors.join("; "));
}

export function renderSkillContractInventory(): string {
	assertValidSkillContractManifests();
	return `Runtime skills (${skillContractManifests.length}, ${skillContractVersion}; read-only except approval-gated deploy):\n${skillContractManifests
		.map((manifest) => `\`${manifest.id}\``)
		.join(", ")}`;
}
