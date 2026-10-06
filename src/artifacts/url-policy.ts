const unsafeHostnameSuffixes = [
	".localhost",
	".local",
	".internal",
	".home",
	".lan",
];

// Accept a bare domain at the user-input boundary; executor URLs stay strict.
export function normalizeScreenshotUrl(value: string): string {
	const input = value.trim();
	const bareDomain =
		/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?::\d+)?(?:[/?#]|$)/i;
	return assertSafePublicHttpsUrl(
		bareDomain.test(input) ? `https://${input}` : input,
		"Screenshot URL",
	).toString();
}

export function assertSafePublicHttpsUrl(value: string, label: string): URL {
	const url = new URL(value);
	if (url.protocol !== "https:" || url.username || url.password) {
		throw new Error(`${label} must use credential-free HTTPS`);
	}
	const hostname = normalizeHostname(url.hostname);
	if (
		!hostname ||
		hostname === "localhost" ||
		unsafeHostnameSuffixes.some((suffix) => hostname.endsWith(suffix)) ||
		isUnsafeIpLiteral(hostname)
	) {
		throw new Error(`${label} must use a public HTTPS host`);
	}
	return url;
}

export function isUnsafeIpLiteral(hostname: string): boolean {
	const normalized = normalizeHostname(hostname);
	if (normalized.includes(":")) {
		return true;
	}
	if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized)) {
		return false;
	}
	const octets = normalized.split(".").map(Number);
	if (octets.some((octet) => octet < 0 || octet > 255)) {
		return true;
	}
	const [a = 0, b = 0] = octets;
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		a >= 224 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && (b === 0 || b === 168)) ||
		(a === 198 && (b === 18 || b === 19))
	);
}

function normalizeHostname(hostname: string): string {
	return hostname
		.replace(/^\[|\]$/g, "")
		.replace(/\.$/, "")
		.toLowerCase();
}
