const discordPublicKeyBytes = 32;
const discordSignatureBytes = 64;

export async function verifyDiscordRequest(input: {
	body: string;
	publicKey: string;
	signature: string | null;
	timestamp: string | null;
}): Promise<boolean> {
	if (!input.signature || !input.timestamp) {
		return false;
	}
	const publicKey = decodeHex(input.publicKey, discordPublicKeyBytes);
	const signature = decodeHex(input.signature, discordSignatureBytes);
	if (!publicKey || !signature) {
		return false;
	}
	try {
		const key = await crypto.subtle.importKey(
			"raw",
			publicKey,
			{ name: "Ed25519" },
			false,
			["verify"],
		);
		const message = new TextEncoder().encode(`${input.timestamp}${input.body}`);
		return await crypto.subtle.verify(
			{ name: "Ed25519" },
			key,
			signature,
			message,
		);
	} catch {
		return false;
	}
}

function decodeHex(
	value: string,
	expectedBytes: number,
): Uint8Array<ArrayBuffer> | undefined {
	if (value.length !== expectedBytes * 2 || !/^[0-9a-f]+$/i.test(value)) {
		return undefined;
	}
	const bytes = new Uint8Array(new ArrayBuffer(expectedBytes));
	for (let index = 0; index < expectedBytes; index += 1) {
		bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
	}
	return bytes;
}
