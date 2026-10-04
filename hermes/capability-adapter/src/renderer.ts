import { rm, unlink } from "node:fs/promises";

export type ScreenshotRenderer = (url: string) => Promise<Uint8Array>;

const screenshotTimeoutMs = 30_000;
const maxScreenshotBytes = 7_500_000;

export async function renderScreenshot(url: string): Promise<Uint8Array> {
	const parsed = new URL(url);
	if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
		throw new Error("screenshot URL is not a trusted HTTPS target");
	}
	const output = `/tmp/capability-${crypto.randomUUID()}.png`;
	const profile = `/tmp/chromium-${crypto.randomUUID()}`;
	const chromium = Bun.spawn(
		[
			process.env.CHROMIUM_BIN ?? "/usr/bin/chromium-headless-shell",
			"--headless=new",
			"--no-sandbox",
			"--disable-dev-shm-usage",
			"--disable-gpu",
			"--hide-scrollbars",
			`--user-data-dir=${profile}`,
			`--disk-cache-dir=${profile}/cache`,
			"--window-size=1440,900",
			"--virtual-time-budget=5000",
			`--screenshot=${output}`,
			parsed.toString(),
		],
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
