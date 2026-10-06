import {
	type HilArtifactEvidence,
	type HilArtifactFinding,
	type HilArtifactRisk,
	type HilArtifactSeverity,
	type HilArtifactV1,
	hilArtifactVersion,
} from "./artifact";

export type RiskAssessmentArtifactInput = {
	artifactId: string;
	objective: string;
	repository: string;
	branch: string;
	answer: string;
	createdAt: string;
	baseRef?: string;
	pullRequest?: number;
};

type RiskSection =
	| "summary"
	| "blast-radius"
	| "evidence"
	| "risks"
	| "human-test-plan"
	| "evidence-gaps"
	| "recommended-action";

const sectionAliases: Readonly<Record<string, RiskSection>> = {
	summary: "summary",
	"blast radius": "blast-radius",
	evidence: "evidence",
	risk: "risks",
	risks: "risks",
	"human test plan": "human-test-plan",
	"evidence gap": "evidence-gaps",
	"evidence gaps": "evidence-gaps",
	"recommended action": "recommended-action",
};

export function buildRiskAssessmentArtifact(
	input: RiskAssessmentArtifactInput,
): HilArtifactV1 {
	const sections = parseSections(input.answer);
	const evidence = buildEvidence(sections);
	const summary = sectionText(sections, "summary");
	const blastRadius = sectionItems(sections, "blast-radius");
	const evidenceGaps = sectionItems(sections, "evidence-gaps");
	const findings: HilArtifactFinding[] = [
		...(summary
			? [
					{
						title: "Assessment summary",
						summary,
						severity: "info" as const,
					},
				]
			: []),
		...blastRadius.map((item) => ({
			title: findingTitle(item, "Blast radius"),
			summary: item,
			severity: "medium" as const,
		})),
		...evidenceGaps.map((item) => ({
			title: "Evidence gap",
			summary: item,
			severity: "medium" as const,
		})),
	];
	if (findings.length === 0) {
		findings.push({
			title: "Unstructured assessment",
			summary: bounded(input.answer),
			severity: "medium",
		});
	}
	const risks = buildRisks(sectionItems(sections, "risks"));
	const humanTestPlan = sectionItems(sections, "human-test-plan");
	return {
		version: hilArtifactVersion,
		artifactId: input.artifactId,
		title: `Risk Assessment: ${input.repository}@${input.branch}`,
		capability: "risk-assessment",
		status: "completed",
		objective: input.objective,
		source: {
			kind: "code",
			repository: input.repository,
			branch: input.branch,
		},
		evidence,
		findings,
		risks:
			risks.length > 0
				? risks
				: [
						{
							title: "Structured risk evidence missing",
							impact:
								"The assessment did not provide a severity-ranked Risks section, so release confidence is limited.",
							likelihood: "medium",
							mitigation:
								"Review the cited diff and rerun /risk before approving the release.",
						},
					],
		humanActions:
			humanTestPlan.length > 0
				? humanTestPlan.map((item) => ({
						label: findingTitle(item, "Human test"),
						description: item,
						required: true,
					}))
				: [
						{
							label: "Create a Human Test Plan",
							description:
								"No structured Human Test Plan was returned. Define and run targeted checks for the affected paths before release.",
							required: true,
						},
					],
		recommendedAction:
			sectionText(sections, "recommended-action") ||
			"Do not approve release until the structured evidence gaps and required human tests are resolved.",
		metadata: {
			createdAt: input.createdAt,
			correlationId: input.artifactId,
			tags: ["risk", "release", "human-test-plan"],
			inputs: {
				repository: input.repository,
				branch: input.branch,
				...(input.baseRef ? { baseRef: input.baseRef } : {}),
				...(input.pullRequest ? { pullRequest: input.pullRequest } : {}),
			},
		},
	};
}

function parseSections(answer: string): Map<RiskSection, string[]> {
	const sections = new Map<RiskSection, string[]>();
	let current: RiskSection = "summary";
	sections.set(current, []);
	for (const rawLine of answer.replace(/\r\n?/g, "\n").split("\n")) {
		const heading = rawLine.match(/^#{1,6}\s+(.+?)\s*:?[\s#]*$/);
		if (heading) {
			const normalized = heading[1]?.trim().toLowerCase() ?? "";
			const section = sectionAliases[normalized];
			if (section) {
				current = section;
				if (!sections.has(current)) sections.set(current, []);
				continue;
			}
		}
		const line = rawLine.trim();
		if (line) sections.get(current)?.push(line);
	}
	return sections;
}

function sectionItems(
	sections: Map<RiskSection, string[]>,
	section: RiskSection,
): string[] {
	return (sections.get(section) ?? [])
		.map((line) => line.replace(/^[-*+]\s+|^\d+[.)]\s+/, "").trim())
		.filter(Boolean)
		.slice(0, 20)
		.map(bounded);
}

function sectionText(
	sections: Map<RiskSection, string[]>,
	section: RiskSection,
): string {
	return bounded(sectionItems(sections, section).join(" "));
}

function buildEvidence(
	sections: Map<RiskSection, string[]>,
): HilArtifactEvidence[] {
	const evidence = sectionItems(sections, "evidence").map((item, index) => {
		const path = item.match(/`([^`]+)`/)?.[1];
		return {
			label: `Evidence ${index + 1}`,
			summary: item,
			source: "repository",
			...(path ? { path } : {}),
		};
	});
	return evidence.length > 0
		? evidence
		: [
				{
					label: "Evidence gap",
					summary:
						"No structured repository evidence was returned; source claims require human verification.",
					source: "hermes",
				},
			];
}

function buildRisks(items: string[]): HilArtifactRisk[] {
	return items.map((item) => {
		const match = item.match(
			/^\[(critical|high|medium|low|info)\]\s*([^:—-]+)\s*(?::|—|-)\s*(.+)$/i,
		);
		const severity = (match?.[1]?.toLowerCase() ??
			"medium") as HilArtifactSeverity;
		return {
			title: bounded(match?.[2]?.trim() || findingTitle(item, "Risk")),
			impact: bounded(match?.[3]?.trim() || item),
			severity,
			likelihood: severityLikelihood(severity),
			mitigation:
				"Run the linked Human Test Plan and resolve the cited evidence gap before release.",
		};
	});
}

function severityLikelihood(
	severity: HilArtifactSeverity,
): "low" | "medium" | "high" {
	if (severity === "critical" || severity === "high") return "high";
	if (severity === "low" || severity === "info") return "low";
	return "medium";
}

function findingTitle(value: string, fallback: string): string {
	return bounded(value.split(/\s*(?::|—|-)\s*/, 1)[0] || fallback).slice(
		0,
		120,
	);
}

function bounded(value: string): string {
	return value.replace(/\s+/g, " ").trim().slice(0, 4_000);
}
