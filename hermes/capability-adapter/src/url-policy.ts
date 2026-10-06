import { lookup } from "node:dns/promises";

const unsafeHostnameSuffixes = [
	".localhost",
	".local",
	".internal",
	".home",
	".lan",
];

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
		isUnsafeAddress(hostname)
	) {
		throw new Error(`${label} must use a public HTTPS host`);
	}
	return url;
}

export async function assertPublicDnsResolution(
	url: URL,
	resolver: typeof lookup = lookup,
): Promise<string[]> {
	const results = await resolver(url.hostname, { all: true, verbatim: true });
	if (
		results.length === 0 ||
		results.some(({ address }) => isUnsafeAddress(address))
	) {
		throw new Error("screenshot target resolved to a non-public address");
	}
	return [...new Set(results.map(({ address }) => normalizeHostname(address)))];
}

export function isUnsafeAddress(value: string): boolean {
	const normalized = normalizeHostname(value);
	if (normalized.includes(":")) {
		return isUnsafeIpv6(normalized);
	}
	if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized)) {
		return false;
	}
	const octets = normalized.split(".").map(Number);
	if (octets.some((octet) => octet < 0 || octet > 255)) return true;
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

function isUnsafeIpv6(address: string): boolean {
	const value = address.toLowerCase();
	return (
		value === "::" ||
		value === "::1" ||
		value.startsWith("::ffff:") ||
		value.startsWith("fc") ||
		value.startsWith("fd") ||
		/^fe[89ab]/.test(value) ||
		/^fe[cdef]/.test(value) ||
		value.startsWith("ff") ||
		value.startsWith("64:ff9b:") ||
		value.startsWith("2001:db8:")
	);
}

function normalizeHostname(value: string): string {
	return value
		.replace(/^\[|\]$/g, "")
		.replace(/\.$/, "")
		.toLowerCase();
}
