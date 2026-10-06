import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildChromiumCommand, createSafeHttpsProxy } from "./renderer";

describe("capability renderer isolation", () => {
	test("forces all Chromium traffic through the validating HTTPS proxy", () => {
		const command = buildChromiumCommand({
			url: new URL("https://artifact.example/health"),
			proxyPort: 43123,
			output: "/tmp/output.png",
			profile: "/tmp/profile",
			chromiumBin: "/usr/bin/chromium-headless-shell",
		});

		expect(command).toContain("--proxy-server=http://127.0.0.1:43123");
		expect(command).toContain("--proxy-bypass-list=<-loopback>");
		expect(command).toContain(
			"--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
		);
		expect(command).toContain("--disable-quic");
		expect(command).toContain(
			"--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
		);
		expect(command).toContain("--user-data-dir=/tmp/profile");
		expect(command).toContain("--disk-cache-dir=/tmp/profile/cache");
		expect(command.at(-1)).toBe("https://artifact.example/health");
	});

	test("blocks redirect CONNECT attempts to localhost or metadata IPs", async () => {
		const proxy = await createSafeHttpsProxy();
		try {
			for (const authority of [
				"127.0.0.1:443",
				"169.254.169.254:443",
				"[::1]:443",
			]) {
				const response = await proxyConnect(proxy.port, authority);
				expect(response).toStartWith("HTTP/1.1 403 Forbidden");
			}
			expect(proxy.deniedReason()).toContain("non-public HTTPS host");
		} finally {
			await proxy.close();
		}
	});

	test("blocks public hostnames when DNS resolves to a private address", async () => {
		const proxy = await createSafeHttpsProxy({
			resolver: async () => [{ address: "127.0.0.1", family: 4 }],
		});
		try {
			const response = await proxyConnect(proxy.port, "public.example:443");
			expect(response).toStartWith("HTTP/1.1 403 Forbidden");
			expect(proxy.deniedReason()).toContain("non-public address");
		} finally {
			await proxy.close();
		}
	});

	test("keeps the browser in an explicit non-root locked-down sidecar", async () => {
		const here = dirname(fileURLToPath(import.meta.url));
		const dockerfile = await readFile(join(here, "..", "Dockerfile"), "utf8");
		const compose = await readFile(
			join(here, "..", "..", "compose.yaml"),
			"utf8",
		);

		expect(dockerfile).toContain("USER bun");
		expect(compose).toContain('user: "1000:1000"');
		expect(compose).toContain("read_only: true");
		expect(compose).toContain("no-new-privileges:true");
		expect(compose).toContain("cap_drop:\n      - ALL");
		expect(compose).toContain("pids_limit: 128");
	});
});

function proxyConnect(port: number, authority: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = connect({ host: "127.0.0.1", port });
		let response = "";
		socket.setEncoding("utf8");
		socket.once("error", reject);
		socket.on("data", (chunk) => {
			response += chunk;
		});
		socket.once("end", () => resolve(response));
		socket.once("connect", () => {
			socket.write(
				`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`,
			);
		});
	});
}
