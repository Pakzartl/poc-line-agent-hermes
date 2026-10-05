import { rm, unlink } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import {
	connect as connectSocket,
	createServer,
	type Server,
	type Socket,
} from "node:net";
import {
	assertPublicDnsResolution,
	assertSafePublicHttpsUrl,
} from "./url-policy";

export type ScreenshotRenderer = (url: string) => Promise<Uint8Array>;

const screenshotTimeoutMs = 30_000;
const maxScreenshotBytes = 7_500_000;
const maxProxyHeaderBytes = 8_192;

export type SafeHttpsProxy = {
	port: number;
	deniedReason(): string | undefined;
	close(): Promise<void>;
};

export async function renderScreenshot(url: string): Promise<Uint8Array> {
	const parsed = assertSafePublicHttpsUrl(url, "screenshot URL");
	await assertPublicDnsResolution(parsed);
	const proxy = await createSafeHttpsProxy();
	const output = `/tmp/capability-${crypto.randomUUID()}.png`;
	const profile = `/tmp/chromium-${crypto.randomUUID()}`;
	const chromium = Bun.spawn(
		buildChromiumCommand({
			url: parsed,
			proxyPort: proxy.port,
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
		const deniedReason = proxy.deniedReason();
		if (deniedReason) {
			throw new Error(`screenshot navigation blocked: ${deniedReason}`);
		}
		const bytes = new Uint8Array(await Bun.file(output).arrayBuffer());
		if (bytes.byteLength === 0 || bytes.byteLength > maxScreenshotBytes) {
			throw new Error("screenshot output size is invalid");
		}
		return bytes;
	} finally {
		if (timeout) clearTimeout(timeout);
		await proxy.close();
		await unlink(output).catch(() => undefined);
		await rm(profile, { recursive: true, force: true }).catch(() => undefined);
	}
}

export function buildChromiumCommand(input: {
	url: URL;
	proxyPort: number;
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
		"--disable-quic",
		"--hide-scrollbars",
		"--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
		`--user-data-dir=${input.profile}`,
		`--disk-cache-dir=${input.profile}/cache`,
		"--window-size=1440,900",
		"--virtual-time-budget=5000",
		`--proxy-server=http://127.0.0.1:${input.proxyPort}`,
		"--proxy-bypass-list=<-loopback>",
		"--host-resolver-rules=MAP * ~NOTFOUND",
		`--screenshot=${input.output}`,
		input.url.toString(),
	];
}

export async function createSafeHttpsProxy(input?: {
	resolver?: typeof lookup;
	connect?: typeof connectSocket;
}): Promise<SafeHttpsProxy> {
	const resolver = input?.resolver ?? lookup;
	const connect = input?.connect ?? connectSocket;
	const sockets = new Set<Socket>();
	let denied: string | undefined;
	const server = createServer((client) => {
		sockets.add(client);
		client.once("close", () => sockets.delete(client));
		let pending = Buffer.alloc(0);
		const onData = (chunk: Buffer) => {
			pending = Buffer.concat([pending, chunk]);
			if (pending.byteLength > maxProxyHeaderBytes) {
				deny(client, "proxy request headers are too large");
				return;
			}
			const headerEnd = pending.indexOf("\r\n\r\n");
			if (headerEnd < 0) return;
			client.off("data", onData);
			client.pause();
			void connectPublicTunnel({
				client,
				header: pending.subarray(0, headerEnd).toString("ascii"),
				remainder: pending.subarray(headerEnd + 4),
				resolver,
				connect,
				onDenied: (reason) => {
					denied ??= reason;
				},
			});
		};
		client.on("data", onData);
		client.setTimeout(screenshotTimeoutMs, () => client.destroy());
	});
	await listen(server);
	const address = server.address();
	if (!address || typeof address === "string") {
		await closeServer(server);
		throw new Error("screenshot proxy failed to bind");
	}
	return {
		port: address.port,
		deniedReason: () => denied,
		async close() {
			for (const socket of sockets) socket.destroy();
			await closeServer(server);
		},
	};

	function deny(socket: Socket, reason: string): void {
		denied ??= reason;
		socket.end(
			"HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
		);
	}
}

async function connectPublicTunnel(input: {
	client: Socket;
	header: string;
	remainder: Buffer;
	resolver: typeof lookup;
	connect: typeof connectSocket;
	onDenied(reason: string): void;
}): Promise<void> {
	const [requestLine = ""] = input.header.split("\r\n", 1);
	const match = requestLine.match(/^CONNECT\s+([^\s]+)\s+HTTP\/1\.[01]$/i);
	if (!match) {
		return denyTunnel(
			input.client,
			"only HTTPS CONNECT is allowed",
			input.onDenied,
		);
	}
	let destination: URL;
	try {
		destination = assertSafePublicHttpsUrl(
			`https://${match[1]}`,
			"proxy destination",
		);
	} catch {
		return denyTunnel(
			input.client,
			"redirect or subresource targeted a non-public HTTPS host",
			input.onDenied,
		);
	}
	if (destination.port && destination.port !== "443") {
		return denyTunnel(
			input.client,
			"HTTPS destination port is not allowed",
			input.onDenied,
		);
	}
	let addresses: string[];
	try {
		addresses = await assertPublicDnsResolution(destination, input.resolver);
	} catch {
		return denyTunnel(
			input.client,
			"redirect or subresource resolved to a non-public address",
			input.onDenied,
		);
	}
	const pinnedAddress =
		addresses.find((candidate) => !candidate.includes(":")) ?? addresses[0];
	if (!pinnedAddress || input.client.destroyed) return;
	const upstream = input.connect({ host: pinnedAddress, port: 443 });
	upstream.setTimeout(screenshotTimeoutMs, () => upstream.destroy());
	upstream.once("connect", () => {
		if (input.client.destroyed) {
			upstream.destroy();
			return;
		}
		input.client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
		if (input.remainder.byteLength > 0) upstream.write(input.remainder);
		input.client.pipe(upstream);
		upstream.pipe(input.client);
		input.client.resume();
	});
	upstream.once("error", () => {
		if (!input.client.destroyed) {
			input.client.end(
				"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
			);
		}
	});
}

function denyTunnel(
	client: Socket,
	reason: string,
	onDenied: (reason: string) => void,
): void {
	onDenied(reason);
	client.end(
		"HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
	);
}

function listen(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		if (!server.listening) {
			resolve();
			return;
		}
		server.close((error) => (error ? reject(error) : resolve()));
	});
}
