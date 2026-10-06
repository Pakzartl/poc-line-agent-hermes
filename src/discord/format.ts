export function formatDiscordMarkdown(markdown: string): string {
	const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
	const output: string[] = [];
	let inCodeFence = false;

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (isCodeFence(line)) {
			inCodeFence = !inCodeFence;
			output.push(line);
			continue;
		}

		if (!inCodeFence) {
			const headers = parseTableRow(line);
			const separator = parseTableRow(lines[index + 1] ?? "");
			if (
				headers &&
				separator &&
				headers.length === separator.length &&
				separator.every(isTableSeparator)
			) {
				const rows: string[][] = [];
				index += 2;
				while (index < lines.length) {
					const row = parseTableRow(lines[index] ?? "");
					if (!row || row.length !== headers.length) {
						index -= 1;
						break;
					}
					rows.push(row);
					index += 1;
				}
				output.push(...renderTable(headers, rows));
				continue;
			}
		}

		output.push(line);
	}

	return output
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function renderTable(headers: string[], rows: string[][]): string[] {
	const output: string[] = [];
	for (const row of rows) {
		const title = row[0]?.trim();
		if (title) {
			output.push(`**${title}**`);
		}
		for (let index = 1; index < headers.length; index += 1) {
			const value = row[index]?.trim();
			if (value) {
				output.push(`- **${headers[index]}:** ${value}`);
			}
		}
		output.push("");
	}
	return output.length > 0 ? output.slice(0, -1) : [];
}

function parseTableRow(line: string): string[] | undefined {
	const trimmed = line.trim();
	if (!trimmed.includes("|")) {
		return undefined;
	}

	const content = trimmed.replace(/^\|/, "").replace(/\|$/, "");
	const cells: string[] = [];
	let cell = "";
	let escaped = false;
	let inInlineCode = false;

	for (const character of content) {
		if (escaped) {
			cell += character;
			escaped = false;
			continue;
		}
		if (character === "\\") {
			cell += character;
			escaped = true;
			continue;
		}
		if (character === "`") {
			inInlineCode = !inInlineCode;
			cell += character;
			continue;
		}
		if (character === "|" && !inInlineCode) {
			cells.push(cell.trim());
			cell = "";
			continue;
		}
		cell += character;
	}
	cells.push(cell.trim());
	return cells.length >= 2 ? cells : undefined;
}

function isTableSeparator(cell: string): boolean {
	return /^:?-{3,}:?$/.test(cell.trim());
}

function isCodeFence(line: string): boolean {
	return /^\s*```/.test(line);
}
