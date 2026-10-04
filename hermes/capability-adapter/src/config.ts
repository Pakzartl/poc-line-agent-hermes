export type ArtifactTarget = {
	id: string;
	url: string;
};

export type CapabilityAdapterConfig = {
	port: number;
	token: string;
	artifactTargets: readonly ArtifactTarget[];
};

export function loadCapabilityAdapterConfig(
	env: Readonly<Record<string, string | undefined>>,
): CapabilityAdapterConfig {
	const port = Number(env.CAPABILITY_ADAPTER_PORT ?? "8788");
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error("CAPABILITY_ADAPTER_PORT must be a valid TCP port");
	}
	const token = env.CAPABILITY_ADAPTER_TOKEN?.trim() ?? "";
	if (token.length < 32) {
		throw new Error("CAPABILITY_ADAPTER_TOKEN must be at least 32 characters");
	}
	return {
		port,
		token,
		artifactTargets: parseArtifactTargets(env.CAPABILITY_ARTIFACT_TARGETS_JSON),
	};
}

export function parseArtifactTargets(
	raw: string | undefined,
): ArtifactTarget[] {
	if (!raw?.trim()) {
		throw new Error("CAPABILITY_ARTIFACT_TARGETS_JSON is required");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("CAPABILITY_ARTIFACT_TARGETS_JSON must be valid JSON");
	}
	if (!Array.isArray(parsed) || parsed.length === 0) {
		throw new Error(
			"CAPABILITY_ARTIFACT_TARGETS_JSON must be a non-empty array",
		);
	}
	const seen = new Set<string>();
	return parsed.map((candidate, index) => {
		if (!candidate || typeof candidate !== "object") {
			throw new Error(`artifact target ${index} must be an object`);
		}
		const record = candidate as Record<string, unknown>;
		if (typeof record.id !== "string" || !/^[a-z0-9._-]+$/.test(record.id)) {
			throw new Error(`artifact target ${index} id is invalid`);
		}
		if (seen.has(record.id)) {
			throw new Error(`artifact target ${record.id} is duplicated`);
		}
		seen.add(record.id);
		if (typeof record.url !== "string") {
			throw new Error(`artifact target ${record.id} URL is required`);
		}
		const url = new URL(record.url);
		if (url.protocol !== "https:" || url.username || url.password) {
			throw new Error(
				`artifact target ${record.id} must use credential-free HTTPS`,
			);
		}
		return { id: record.id, url: url.toString() };
	});
}
