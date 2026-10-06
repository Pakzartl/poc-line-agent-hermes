const metrics = document.querySelector("#metrics");
const containers = document.querySelector("#containers");
const services = document.querySelector("#services");
const freshness = document.querySelector("#freshness");
const subtitle = document.querySelector("#subtitle");
const logSource = document.querySelector("#log-source");
const logs = document.querySelector("#logs");
const canvas = document.querySelector("#history");
let latestLogs = {};

logSource.addEventListener("change", () => renderLogs(logSource.value));
window.addEventListener("resize", () =>
	window.requestAnimationFrame(() => drawHistory(window.lastHistory || [])),
);

async function refresh() {
	try {
		const response = await fetch("/ops/api/snapshot", { cache: "no-store" });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const snapshot = await response.json();
		render(snapshot);
	} catch (error) {
		freshness.textContent = "offline";
		freshness.className = "pill bad";
		subtitle.textContent = `โหลด snapshot ไม่สำเร็จ: ${error.message}`;
	}
}

function render(snapshot) {
	const system = snapshot.system;
	const ageSeconds = Math.max(
		0,
		Math.round((Date.now() - Date.parse(system.timestamp)) / 1000),
	);
	freshness.textContent =
		ageSeconds <= 30 ? `live · ${ageSeconds}s` : `stale · ${ageSeconds}s`;
	freshness.className = ageSeconds <= 30 ? "pill good" : "pill bad";
	subtitle.textContent = `${system.hostname} · updated ${new Date(system.timestamp).toLocaleString()}`;
	renderMetrics(system, snapshot.cloudflared);
	renderServices(snapshot.services, snapshot.cloudflared);
	renderContainers(snapshot.containers);
	window.lastHistory = snapshot.history || [];
	drawHistory(window.lastHistory);
	latestLogs = snapshot.logs || {};
	renderLogSources();
}

function renderMetrics(system, tunnel) {
	const cards = [
		[
			"CPU",
			`${number(system.cpuPercent)}%`,
			`load ${system.loadAverage.join(" · ")}`,
			system.cpuPercent,
		],
		[
			"Memory",
			`${number(system.memory.usedPercent)}%`,
			`${bytes(system.memory.usedBytes)} / ${bytes(system.memory.totalBytes)}`,
			system.memory.usedPercent,
		],
		[
			"Disk /",
			`${number(system.disk.usedPercent)}%`,
			`${bytes(system.disk.usedBytes)} / ${bytes(system.disk.totalBytes)}`,
			system.disk.usedPercent,
		],
		["Uptime", duration(system.uptimeSeconds), "host uptime", null],
		["Tunnel", String(tunnel.haConnections ?? "-"), "HA connections", null],
		[
			"Requests",
			compact(tunnel.totalRequests),
			`${compact(tunnel.requestErrors)} errors`,
			null,
		],
	];
	metrics.replaceChildren(
		...cards.map(([label, value, detail, percent]) =>
			metricCard(label, value, detail, percent),
		),
	);
}

function metricCard(label, value, detail, percent) {
	const card = element("article", "metric-card");
	card.append(
		element("span", "label", label),
		element("strong", "value", value),
		element("span", "detail", detail),
	);
	if (typeof percent === "number") {
		const bar = element("div", "bar");
		const fill = document.createElement("span");
		fill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
		bar.append(fill);
		card.append(bar);
	}
	return card;
}

function renderServices(statuses, tunnel) {
	const entries = Object.entries(statuses).map(([name, status]) => [
		name.replace(".service", ""),
		status,
	]);
	entries.push([
		"tunnel-ha",
		Number(tunnel.haConnections) > 0
			? `${tunnel.haConnections} connected`
			: "disconnected",
	]);
	services.replaceChildren(
		...entries.map(([name, status]) => {
			const good = status === "active" || status.includes("connected");
			return element(
				"span",
				`status ${good ? "good" : "bad"}`,
				`${name}: ${status}`,
			);
		}),
	);
}

function renderContainers(items) {
	containers.replaceChildren(
		...items.map((item) => {
			const row = document.createElement("tr");
			const healthy =
				item.status === "running" &&
				["healthy", "not-configured"].includes(item.health);
			row.append(
				cell(item.name),
				cellNode(
					element(
						"span",
						`status ${healthy ? "good" : "bad"}`,
						`${item.status} / ${item.health}`,
					),
				),
				cell(item.cpuPercent == null ? "-" : `${number(item.cpuPercent)}%`),
				cell(item.memoryUsage),
				cell(item.networkIO),
				cell(String(item.restartCount ?? "-")),
			);
			return row;
		}),
	);
}

function renderLogSources() {
	const prior = logSource.value;
	const names = Object.keys(latestLogs);
	logSource.replaceChildren(
		...names.map((name) => {
			const option = document.createElement("option");
			option.value = name;
			option.textContent = name;
			return option;
		}),
	);
	logSource.value = names.includes(prior) ? prior : names[0] || "";
	renderLogs(logSource.value);
}

function renderLogs(source) {
	const lines = latestLogs[source] || [];
	logs.textContent = lines.length
		? lines.join("\n")
		: "No logs in the last 30 minutes.";
	logs.scrollTop = logs.scrollHeight;
}

function drawHistory(history) {
	const context = canvas.getContext("2d");
	const ratio = window.devicePixelRatio || 1;
	const width = canvas.clientWidth;
	const height = canvas.clientHeight;
	canvas.width = Math.max(1, Math.round(width * ratio));
	canvas.height = Math.max(1, Math.round(height * ratio));
	context.scale(ratio, ratio);
	context.clearRect(0, 0, width, height);
	context.strokeStyle = "#1d3543";
	context.lineWidth = 1;
	for (let value = 0; value <= 100; value += 25) {
		const y = height - (value / 100) * (height - 18) - 9;
		context.beginPath();
		context.moveTo(0, y);
		context.lineTo(width, y);
		context.stroke();
	}
	plot(context, history, "cpuPercent", "#59d9bd", width, height);
	plot(context, history, "memoryPercent", "#6da8ff", width, height);
}

function plot(context, history, key, color, width, height) {
	if (history.length < 2) return;
	context.strokeStyle = color;
	context.lineWidth = 2;
	context.beginPath();
	history.forEach((point, index) => {
		const x = (index / (history.length - 1)) * width;
		const y =
			height -
			(Math.min(100, Math.max(0, Number(point[key]))) / 100) * (height - 18) -
			9;
		if (index === 0) context.moveTo(x, y);
		else context.lineTo(x, y);
	});
	context.stroke();
}

function element(tag, className, text) {
	const node = document.createElement(tag);
	node.className = className;
	if (text != null) node.textContent = text;
	return node;
}
function cell(text) {
	const node = document.createElement("td");
	node.textContent = text;
	return node;
}
function cellNode(child) {
	const node = document.createElement("td");
	node.append(child);
	return node;
}
function number(value) {
	return Number(value || 0).toFixed(1);
}
function compact(value) {
	return value == null
		? "-"
		: new Intl.NumberFormat(undefined, {
				notation: "compact",
				maximumFractionDigits: 1,
			}).format(value);
}
function bytes(value) {
	const units = ["B", "KiB", "MiB", "GiB", "TiB"];
	let size = Number(value || 0),
		index = 0;
	while (size >= 1024 && index < units.length - 1) {
		size /= 1024;
		index += 1;
	}
	return `${size.toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}
function duration(seconds) {
	const days = Math.floor(seconds / 86400);
	const hours = Math.floor((seconds % 86400) / 3600);
	return days ? `${days}d ${hours}h` : `${hours}h`;
}

refresh();
setInterval(refresh, 5_000);
