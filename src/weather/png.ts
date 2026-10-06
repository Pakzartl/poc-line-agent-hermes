export interface PngImage {
	width: number;
	height: number;
	rgba: Uint8Array;
}

const MAX_BYTES = 2_000_000;

function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++)
			crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function paeth(a: number, b: number, c: number): number {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Small bounded PNG decoder for radar tiles; no interlace or 16-bit samples. */
export async function decodePng(bytes: Uint8Array): Promise<PngImage> {
	if (
		bytes.length > MAX_BYTES ||
		bytes.length < 45 ||
		![137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b)
	)
		throw new Error("Invalid PNG");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let width = 0,
		height = 0,
		depth = 0,
		type = -1;
	let palette: Uint8Array | undefined;
	let transparency: Uint8Array | undefined;
	const parts: Uint8Array[] = [];
	let ended = false;
	for (let offset = 8; offset + 12 <= bytes.length; ) {
		const length = view.getUint32(offset);
		const end = offset + 12 + length;
		if (end > bytes.length) throw new Error("Truncated PNG");
		const name = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
		if (crc32(bytes.subarray(offset + 4, end - 4)) !== view.getUint32(end - 4))
			throw new Error("PNG checksum mismatch");
		const body = bytes.subarray(offset + 8, end - 4);
		if (offset === 8 && name !== "IHDR") throw new Error("PNG header missing");
		if (name === "IHDR") {
			if (width || length !== 13) throw new Error("Invalid PNG header");
			width = view.getUint32(offset + 8);
			height = view.getUint32(offset + 12);
			depth = body[8]!;
			type = body[9]!;
			if (
				!width ||
				!height ||
				width > 512 ||
				height > 512 ||
				body[10] !== 0 ||
				body[11] !== 0 ||
				body[12] !== 0 ||
				![0, 2, 3, 4, 6].includes(type) ||
				(type === 3 ? ![1, 2, 4, 8].includes(depth) : depth !== 8)
			)
				throw new Error("Unsupported PNG format");
		} else if (name === "PLTE") {
			if (!length || length % 3 || length > 768)
				throw new Error("Invalid PNG palette");
			palette = body;
		} else if (name === "tRNS") {
			if (type !== 3 || length > 256)
				throw new Error("Unsupported PNG transparency");
			transparency = body;
		} else if (name === "IDAT") parts.push(body);
		else if (name === "IEND") {
			if (length || end !== bytes.length) throw new Error("Invalid PNG ending");
			ended = true;
			break;
		} else if (name.charCodeAt(0) < 97)
			throw new Error("Unsupported PNG chunk");
		offset = end;
	}
	if (!ended || !parts.length || (type === 3 && !palette))
		throw new Error("Incomplete PNG");
	const channels = type === 6 ? 4 : type === 2 ? 3 : type === 4 ? 2 : 1;
	const rowBytes = Math.ceil((width * channels * depth) / 8);
	const expected = height * (rowBytes + 1);
	const compressed = new Uint8Array(
		parts.reduce((sum, p) => sum + p.length, 0),
	);
	let cursor = 0;
	for (const part of parts) {
		compressed.set(part, cursor);
		cursor += part.length;
	}
	const reader = new Blob([compressed])
		.stream()
		.pipeThrough(new DecompressionStream("deflate"))
		.getReader();
	const inflated = new Uint8Array(expected);
	cursor = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (cursor + value.length > expected)
				throw new Error("PNG decompression limit exceeded");
			inflated.set(value, cursor);
			cursor += value.length;
		}
	} finally {
		await reader.cancel();
	}
	if (cursor !== expected) throw new Error("Truncated PNG pixels");
	const pixels = new Uint8Array(height * rowBytes);
	const bpp = Math.max(1, Math.ceil((channels * depth) / 8));
	for (let y = 0; y < height; y++) {
		const filter = inflated[y * (rowBytes + 1)]!;
		if (filter > 4) throw new Error("Unsupported PNG filter");
		for (let x = 0; x < rowBytes; x++) {
			const i = y * rowBytes + x;
			const a = x >= bpp ? pixels[i - bpp]! : 0;
			const b = y > 0 ? pixels[i - rowBytes]! : 0;
			const c = y > 0 && x >= bpp ? pixels[i - rowBytes - bpp]! : 0;
			const add =
				filter === 0
					? 0
					: filter === 1
						? a
						: filter === 2
							? b
							: filter === 3
								? Math.floor((a + b) / 2)
								: paeth(a, b, c);
			pixels[i] = (inflated[y * (rowBytes + 1) + x + 1]! + add) & 255;
		}
	}
	const rgba = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++)
		for (let x = 0; x < width; x++) {
			const out = (y * width + x) * 4;
			const i = y * rowBytes + x * channels;
			if (type === 3) {
				const bit = x * depth;
				const index =
					(pixels[y * rowBytes + (bit >>> 3)]! >>> (8 - depth - (bit % 8))) &
					((1 << depth) - 1);
				if (index * 3 + 2 >= palette!.length)
					throw new Error("PNG palette index out of bounds");
				rgba.set(palette!.subarray(index * 3, index * 3 + 3), out);
				rgba[out + 3] = transparency?.[index] ?? 255;
			} else if (type === 0 || type === 4) {
				rgba[out] = rgba[out + 1] = rgba[out + 2] = pixels[i]!;
				rgba[out + 3] = type === 4 ? pixels[i + 1]! : 255;
			} else {
				rgba.set(pixels.subarray(i, i + 3), out);
				rgba[out + 3] = type === 6 ? pixels[i + 3]! : 255;
			}
		}
	return { width, height, rgba };
}
