import { rm, unlink } from "node:fs/promises";
import {
	assertPublicDnsResolution,
	assertSafePublicHttpsUrl,
} from "./url-policy";

export type ScreenshotRenderer = (url: string) => Promise<Uint8Array>;

const screenshotTimeoutMs = 30_000;
const maxScreenshotBytes = 7_500_000;

export async function renderScreenshot(url: string): Promise<Uint8Array> {
	const parsed = assertSafePublicHttpsUrl(url, "screenshot URL");
	const addresses = await assertPublicDnsResolution(parsed);
	const address = addresses.find((candidate) => !candidate.includes(":"));
	const pinnedAddress = address ?? `[${addresses[0]}]`;
	const output = `/tmp/capability-${crypto.randomUUID()}.png`;
	const profile = `/tmp/chromium-${crypto.randomUUID()}`;
	const chromium = Bun.spawn(
		buildChromiumCommand({
			url: parsed,
			pinnedAddress,
			output,
			profile,
		}),
		{ stdout: "ignore", stderr: "pipe" },
	);
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		const exitCode = await Promise.race([
			chromium.exited,
			new Promise<never>((_, reject) => {
				timeout = setTimeout(() => {
					chromium.kill();
					reject(new Error("screenshot renderer timed out"));
				}, screenshotTimeoutMs);
			}),
		]);
		if (exitCode !== 0) {
			const detail = (await new Response(chromium.stderr).text())
				.replace(/\s+/g, " ")
				.trim()
				.slice(0, 300);
			throw new Error(
				`chromium screenshot failed (${exitCode})${detail ? `: ${detail}` : ""}`,
			);
		}
		const bytes = new Uint8Array(await Bun.file(output).arrayBuffer());
		if (bytes.byteLength === 0 || bytes.byteLength > maxScreenshotBytes) {
			throw new Error("screenshot output size is invalid");
		}
		return bytes;
	} finally {
		if (timeout) clearTimeout(timeout);
		await unlink(output).catch(() => undefined);
		await rm(profile, { recursive: true, force: true }).catch(() => undefined);
	}
}

export function buildChromiumCommand(input: {
	url: URL;
	pinnedAddress: string;
	output: string;
	profile: string;
	chromiumBin?: string;
}): string[] {
	return [
		input.chromiumBin ??
			process.env.CHROMIUM_BIN ??
			"/usr/bin/chromium-headless-shell",
		"--headless=new",
		// Chromium cannot initialize its setuid/user-namespace sandbox under the
		// container's no-new-privileges policy. The dedicated sidecar is instead
		// the security boundary: non-root, read-only, cap-drop ALL, bounded tmpfs.
		"--no-sandbox",
		"--disable-dev-shm-usage",
		"--disable-gpu",
		"--hide-scrollbars",
		`--user-data-dir=${input.profile}`,
		`--disk-cache-dir=${input.profile}/cache`,
		"--window-size=1440,900",
		"--virtual-time-budget=5000",
		`--host-resolver-rules=MAP ${input.url.hostname} ${input.pinnedAddress}, MAP * ~NOTFOUND`,
		`--screenshot=${input.output}`,
		input.url.toString(),
	];
}
