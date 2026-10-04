export const hilArtifactVersion = "hil-artifact/v1" as const;

export type HilArtifactStatus =
	| "queued"
	| "running"
	| "waiting_approval"
	| "completed"
	| "failed"
	| "cancelled";

export type HilArtifactSeverity =
	| "info"
	| "low"
	| "medium"
	| "high"
	| "critical";

export type HilArtifactEvidence = {
	label: string;
	summary: string;
	source?: string;
	path?: string;
	line?: number;
};

export type HilArtifactFinding = {
	title: string;
	summary: string;
	severity?: HilArtifactSeverity;
	evidence?: string[];
};

export type HilArtifactRisk = {
	title: string;
	impact: string;
	likelihood?: "low" | "medium" | "high";
	mitigation?: string;
};

export type HilArtifactHumanAction = {
	label: string;
	description: string;
	required?: boolean;
};

export type HilArtifactSource = {
	kind: "code" | "database" | "event" | "deployment" | "manual";
	repository?: string;
	branch?: string;
	commit?: string;
	eventId?: string;
	jobId?: string;
	url?: string;
};

export type HilArtifactMetadata = {
	createdAt: string;
	correlationId?: string;
	owner?: string;
	tags?: string[];
	inputs?: Record<string, string | number | boolean | null>;
};

export type HilArtifactV1 = {
	version: typeof hilArtifactVersion;
	artifactId: string;
	title: string;
	capability: string;
	status: HilArtifactStatus;
	objective: string;
	source: HilArtifactSource;
	evidence: HilArtifactEvidence[];
	findings: HilArtifactFinding[];
	risks: HilArtifactRisk[];
	humanActions: HilArtifactHumanAction[];
	recommendedAction?: string;
	metadata: HilArtifactMetadata;
};

export function renderHilArtifactMarkdown(artifact: HilArtifactV1): string {
	const lines = [
		`# ${artifact.title}`,
		"",
		`- Version: ${artifact.version}`,
		`- Artifact ID: ${artifact.artifactId}`,
		`- Capability: ${artifact.capability}`,
		`- Status: ${artifact.status}`,
		`- Created: ${artifact.metadata.createdAt}`,
		...(artifact.metadata.correlationId
			? [`- Correlation ID: ${artifact.metadata.correlationId}`]
			: []),
		"",
		"## Objective",
		"",
		artifact.objective,
		"",
		"## Source",
		"",
		...renderSource(artifact.source),
		"",
		"## Evidence",
		"",
		...renderEvidence(artifact.evidence),
		"",
		"## Findings",
		"",
		...renderFindings(artifact.findings),
		"",
		"## Risks",
		"",
		...renderRisks(artifact.risks),
		"",
		"## Human Actions",
		"",
		...renderHumanActions(artifact.humanActions),
		...(artifact.recommendedAction
			? ["", "## Recommended Action", "", artifact.recommendedAction]
			: []),
		"",
		"## Metadata",
		"",
		...renderMetadata(artifact.metadata),
	];
	return `${lines.join("\n").trimEnd()}\n`;
}

export function safeArtifactFilename(input: {
	title: string;
	capability: string;
	createdAt?: string;
	extension?: string;
}): string {
	const extension = sanitizeExtension(input.extension ?? "md");
	const stamp = input.createdAt
		? input.createdAt.replace(/[^0-9]/g, "").slice(0, 14)
		: "";
	const base = [input.capability, input.title, stamp]
		.filter(Boolean)
		.join("-")
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/\.+/g, "-")
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^[._-]+|[._-]+$/g, "")
		.slice(0, 96);
	return `${base || "hil-artifact"}.${extension}`;
}

function renderSource(source: HilArtifactSource): string[] {
	return Object.entries(source)
		.filter(([, value]) => value !== undefined && value !== "")
		.map(([key, value]) => `- ${label(key)}: ${String(value)}`);
}

function renderEvidence(evidence: readonly HilArtifactEvidence[]): string[] {
	if (evidence.length === 0) {
		return ["- No evidence captured."];
	}
	return evidence.flatMap((item) => [
		`- ${item.label}: ${item.summary}`,
		...(item.source ? [`  - Source: ${item.source}`] : []),
		...(item.path ? [`  - Path: ${item.path}${lineSuffix(item.line)}`] : []),
	]);
}

function renderFindings(findings: readonly HilArtifactFinding[]): string[] {
	if (findings.length === 0) {
		return ["- No findings."];
	}
	return findings.flatMap((finding) => [
		`- ${finding.severity ? `[${finding.severity}] ` : ""}${finding.title}: ${finding.summary}`,
		...(finding.evidence?.length
			? [`  - Evidence: ${finding.evidence.join(", ")}`]
			: []),
	]);
}

function renderRisks(risks: readonly HilArtifactRisk[]): string[] {
	if (risks.length === 0) {
		return ["- No risks identified."];
	}
	return risks.flatMap((risk) => [
		`- ${risk.title}: ${risk.impact}`,
		...(risk.likelihood ? [`  - Likelihood: ${risk.likelihood}`] : []),
		...(risk.mitigation ? [`  - Mitigation: ${risk.mitigation}`] : []),
	]);
}

function renderHumanActions(
	actions: readonly HilArtifactHumanAction[],
): string[] {
	if (actions.length === 0) {
		return ["- No human action required."];
	}
	return actions.map(
		(action) =>
			`- ${action.required ? "[required] " : ""}${action.label}: ${action.description}`,
	);
}

function renderMetadata(metadata: HilArtifactMetadata): string[] {
	const rows = [
		`- Owner: ${metadata.owner ?? "unassigned"}`,
		...(metadata.tags?.length ? [`- Tags: ${metadata.tags.join(", ")}`] : []),
		...(metadata.inputs
			? Object.entries(metadata.inputs).map(
					([key, value]) => `- Input ${key}: ${String(value)}`,
				)
			: []),
	];
	return rows;
}

function sanitizeExtension(extension: string): string {
	const safe = extension
		.toLowerCase()
		.replace(/^\.+/, "")
		.replace(/[^a-z0-9]/g, "")
		.slice(0, 12);
	return safe || "md";
}

function lineSuffix(line: number | undefined): string {
	return typeof line === "number" && Number.isFinite(line) ? `:${line}` : "";
}

function label(key: string): string {
	return key
		.replace(/[A-Z]/g, (match) => ` ${match}`)
		.replace(/^./, (match) => match.toUpperCase());
}
