const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);
const REDIRECT_URL = 'https://github.com/0belous/Jellyfin-Universal-Catalogue';
const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const HOURLY_MS = 60 * 60 * 1000;

const ROOT_DIR = __dirname;
const PLUGINS_DIR = path.resolve(ROOT_DIR, './plugins');
const IMAGES_DIR = path.join(PLUGINS_DIR, 'images');
const MANIFEST_FILE = path.join(PLUGINS_DIR, 'manifest.json');
const KNOWN_AGENTS_FILE = path.join(PLUGINS_DIR, '.known_user_agents.json');

const updateInProgress = new Set();
const knownAgents = new Map();
const isInteractiveTerminal = Boolean(process.stdout.isTTY && !process.env.CI);
const agentStatuses = new Map();
let currentStatusLine = '';
let completedAgentCount = 0;

function nowIso() {
	return new Date().toISOString();
}

function renderStatusPanel() {
	if (!isInteractiveTerminal) {
		return;
	}

	const entries = Array.from(agentStatuses.entries())
		.sort((left, right) => right[1].updatedAt - left[1].updatedAt)
		.slice(0, 1);
	const line = entries.length > 0 ? `[${entries[0][0]}] ${entries[0][1].message}` : '';

	if (line === currentStatusLine) {
		return;
	}

	currentStatusLine = line;
	readline.cursorTo(process.stdout, 0);
	readline.clearLine(process.stdout, 0);
	if (line) {
		process.stdout.write(line);
	}
}

function setAgentStatus(agentId, message) {
	const current = agentStatuses.get(agentId);
	if (current && current.message === message) {
		return;
	}

	agentStatuses.set(agentId, {
		message,
		updatedAt: Date.now()
	});
	renderStatusPanel();
}

function clearAgentStatus(agentId) {
	if (agentStatuses.delete(agentId)) {
		renderStatusPanel();
	}
}

function isJellyfinUserAgent(ua) {
	return /^jellyfin/i.test(ua);
}

function normalizeUserAgent(rawUserAgent) {
	const ua = String(rawUserAgent || '').trim();
	if (!ua) return null;

	const capture = ua.match(/^jellyfin(?:-server)?\/([^\s;]+)/i);
	const source = capture?.[1] || ua;
	const cleaned = source.replace(/[^a-zA-Z0-9._-]/g, '');
	return cleaned || null;
}

function getManifestFallback(userAgentId) {
	const safeAgent = userAgentId || 'unknown';
	const checksum = require('crypto').randomBytes(16).toString('hex');
	const timestamp = new Date().toISOString();
	const targetAbi = safeAgent && !safeAgent.endsWith('.0') ? `${safeAgent}.0` : safeAgent;

	return [
		{
			guid: crypto.randomUUID ? crypto.randomUUID() : hashString('upr-dummy-' + timestamp),
			name: 'Jellyfin Universal Catalogue',
			description: `Your user agent ${safeAgent} has not been seen yet, Please wait a moment and refresh the plugins page.`,
			overview: `Please wait for manifest: ${safeAgent}`,
			owner: 'Obelous',
			category: 'Miscellaneous',
			image: 'upr-loading.png',
			imageUrl: 'https://dl.obelous.dev/public/upr-loading.png',
			versions: [
				{
					version: '0.0.0',
					changelog: 'Placeholder',
					targetAbi: targetAbi || '',
					sourceUrl: 'https://github.com/0belous/Jellyfin-Universal-Catalogue',
					checksum: checksum,
					timestamp: timestamp
				}
			]
		}
	];
}

async function ensurePluginsDir() {
	await fs.mkdir(PLUGINS_DIR, { recursive: true });
}

async function loadKnownAgents() {
	await ensurePluginsDir();

	try {
		const raw = await fs.readFile(KNOWN_AGENTS_FILE, 'utf8');
		const parsed = JSON.parse(raw);
		for (const [agent, timestamp] of Object.entries(parsed || {})) {
			if (typeof agent !== 'string' || typeof timestamp !== 'string') continue;
			knownAgents.set(agent, timestamp);
		}
	} catch (error) {
		if (error.code !== 'ENOENT') {
			console.error('Failed to load known user agents:', error.message);
		}
	}
}

async function saveKnownAgents() {
	const payload = {};
	for (const [agent, timestamp] of knownAgents.entries()) {
		payload[agent] = timestamp;
	}
	await fs.writeFile(KNOWN_AGENTS_FILE, JSON.stringify(payload, null, 2));
}

async function removeAgentData(agentId) {
	if (!agentId) {
		return;
	}

	await Promise.allSettled([
		fs.rm(path.join(PLUGINS_DIR, `manifest.${agentId}.json`), { force: true }),
		fs.rm(path.join(IMAGES_DIR, agentId), { recursive: true, force: true })
	]);
}

async function pruneExpiredAgents() {
	const cutoff = Date.now() - ONE_MONTH_MS;
	let changed = false;

	for (const [agentId, seenAt] of knownAgents.entries()) {
		const seenTime = new Date(seenAt).getTime();
		if (!Number.isFinite(seenTime) || seenTime < cutoff) {
			knownAgents.delete(agentId);
			changed = true;
			await removeAgentData(agentId);
			console.log(`Pruned expired user agent: ${agentId}`);
		}
	}

	if (changed) {
		await saveKnownAgents();
	}
}

function markSeen(agentId) {
	knownAgents.set(agentId, nowIso());
}

async function runUpdateForAgent(agentId, regenImages = false) {
	if (updateInProgress.has(agentId)) {
		return;
	}

	updateInProgress.add(agentId);

	try {
		await ensurePluginsDir();
		try { await fs.mkdir(IMAGES_DIR, { recursive: true }); } catch {}
	} catch (err) {
		console.error('Failed to ensure plugin directories before update:', err.message);
	}

	const args = [path.join(ROOT_DIR, 'update.js'), regenImages ? 'true' : 'false', agentId];
	const proc = spawn(process.execPath, args, {
		cwd: ROOT_DIR,
		stdio: ['ignore', 'pipe', 'pipe']
	});

	let stdoutBuffer = '';
	let stderrBuffer = '';
	let lastStatusMessage = '';

	function parseStatusMessage(line) {
		const trimmed = line.trim();
		if (!trimmed) {
			return null;
		}

		let match = trimmed.match(/^\[(?:[^\]]+)\]\s+collecting manifests from (\d+) sources$/i);
		if (match) {
			return `collecting manifests 0/${match[1]}`;
		}

		match = trimmed.match(/^\[(?:[^\]]+)\]\s+http requests (\d+)\/(\d+) complete \((\d+) plugins\)$/i);
		if (match) {
			return `requests ${match[1]}/${match[2]} (${match[3]} plugins)`;
		}

		match = trimmed.match(/^\[(?:[^\]]+)\]\s+merging and normalizing (\d+) collected plugins$/i);
		if (match) {
			return `merging ${match[1]} plugins`;
		}

		match = trimmed.match(/^\[(?:[^\]]+)\]\s+merge complete: (\d+) plugins ready for image processing$/i);
		if (match) {
			return `image prep ${match[1]} plugins`;
		}

		match = trimmed.match(/^\[(?:[^\]]+)\]\s+processing images for (\d+) plugins$/i);
		if (match) {
			return `processing images ${match[1]} plugins`;
		}

		match = trimmed.match(/^\[(?:[^\]]+)\]\s+images complete: downloaded (\d+), normalized (\d+), reused (\d+), renamed (\d+), badged (\d+), fallback (\d+)$/i);
		if (match) {
			return `images complete d${match[1]} z${match[2]} r${match[3]} n${match[4]} b${match[5]} f${match[6]}`;
		}

		if (/^\[(?:[^\]]+)\]\s+serializing manifest payload$/i.test(trimmed)) {
			return 'serializing manifest';
		}

		match = trimmed.match(/^\[(?:[^\]]+)\]\s+manifest written: (.+) \((\d+) total plugins\)$/i);
		if (match) {
			return `done ${match[2]} plugins`;
		}

		return null;
	}

	function updateStatusFromLine(line) {
		const message = parseStatusMessage(line);
		if (!message) {
			return;
		}

		lastStatusMessage = message;
		setAgentStatus(agentId, lastStatusMessage);
	}

	function flushBufferedLines(buffer, chunk, onLine) {
		const nextBuffer = buffer + chunk.toString();
		const lines = nextBuffer.split(/\r?\n/);
		const remainder = lines.pop() || '';

		for (const line of lines) {
			if (line.length > 0) {
				onLine(line);
			}
		}

		return remainder;
	}

	proc.stdout.on('data', (chunk) => {
		stdoutBuffer = flushBufferedLines(stdoutBuffer, chunk, (line) => {
			updateStatusFromLine(line);
		});
	});

	proc.stderr.on('data', (chunk) => {
		stderrBuffer = flushBufferedLines(stderrBuffer, chunk, (line) => {
			process.stderr.write(`${line}\n`);
		});
	});

	proc.on('close', async (code) => {
		if (stdoutBuffer.length > 0) {
			stdoutBuffer = '';
		}
		if (stderrBuffer.length > 0) {
			process.stderr.write(`${stderrBuffer}\n`);
			stderrBuffer = '';
		}
		updateInProgress.delete(agentId);
		if (code === 0) {
			completedAgentCount += 1;
			console.log(`[${agentId}]`);
			setAgentStatus(agentId, lastStatusMessage || 'completed');
		} else {
			completedAgentCount += 1;
			console.log(`[${agentId}] finished with code ${code}`);
			setAgentStatus(agentId, `finished with code ${code}`);
		}
		if (code === 0) {
			markSeen(agentId);
			try {
				await saveKnownAgents();
			} catch (error) {
				console.error('Failed to persist known user agents:', error.message);
			}
		}
	});
}

async function runHourlyUpdates() {
	await pruneExpiredAgents();
	for (const agentId of knownAgents.keys()) {
		runUpdateForAgent(agentId, false);
	}
}

async function fileExists(filePath) {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

function sendJson(res, statusCode, payload) {
	const body = JSON.stringify(payload, null, 2);
	res.writeHead(statusCode, {
		'Content-Type': 'application/json; charset=utf-8',
		'Cache-Control': 'no-store',
		'Content-Length': Buffer.byteLength(body)
	});
	res.end(body);
}

function sendRedirect(res, to) {
	res.writeHead(302, { Location: to });
	res.end();
}

async function serveFile(res, filePath) {
	try {
		const stat = await fs.stat(filePath);
		const ext = path.extname(filePath).toLowerCase();
		const mimeTypes = {
			'.json': 'application/json; charset=utf-8',
			'.svg': 'image/svg+xml; charset=utf-8',
			'.png': 'image/png',
			'.jpg': 'image/jpeg',
			'.jpeg': 'image/jpeg',
			'.gif': 'image/gif',
			'.webp': 'image/webp',
			'.ico': 'image/x-icon'
		};
		const mime = mimeTypes[ext] || 'application/octet-stream';
		res.writeHead(200, {
			'Content-Type': mime,
			'Content-Length': stat.size,
			'Cache-Control': 'no-store'
		});
		const data = await fs.readFile(filePath);
		res.end(data);
	} catch {
		res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
		res.end('Not found');
	}
}

async function servePluginAsset(res, filename) {
	if (!filename) {
		res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
		res.end('Not found');
		return;
	}

	const absolute = path.resolve(IMAGES_DIR, filename);

	if (!absolute.startsWith(IMAGES_DIR + path.sep)) {
		res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
		res.end('Bad request');
		return;
	}

	await serveFile(res, absolute);
}

async function handleManifestRequest(req, res, manifestName) {
	const ua = req.headers['user-agent'] || '';
	if (!isJellyfinUserAgent(ua)) {
		sendRedirect(res, REDIRECT_URL);
		return;
	}

	const agentId = normalizeUserAgent(ua);
	if (!agentId) {
		sendJson(res, 400, { error: 'Unable to parse Jellyfin user agent' });
		return;
	}

	markSeen(agentId);
	await saveKnownAgents();

	const agentManifestPath = path.join(PLUGINS_DIR, `manifest.${agentId}.json`);

	if (await fileExists(agentManifestPath)) {
		await serveFile(res, agentManifestPath);
		return;
	}

	if (await fileExists(MANIFEST_FILE)) {
		await serveFile(res, MANIFEST_FILE);
		return;
	}

	runUpdateForAgent(agentId, false);
	sendJson(res, 200, getManifestFallback(agentId));
}

async function start() {

	const server = http.createServer((req, res) => {
		const reqPath = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
		const routePath = reqPath.startsWith('/plugins/') ? reqPath.slice('/plugins'.length) : reqPath;

		if (req.method !== 'GET') {
			res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
			res.end('Method not allowed');
			return;
		}

		if (routePath === '/upr') {
			handleManifestRequest(req, res, 'manifest.json').catch((error) => {
				console.error('Failed to handle manifest.json:', error.message);
				sendJson(res, 500, { error: 'Internal server error' });
			});
			return;
		}

		const imageMatch = routePath.match(/^\/images\/(.+\.(png|jpg|jpeg|gif|webp|ico|svg))$/i);
		if (imageMatch) {
			servePluginAsset(res, imageMatch[1]).catch((error) => {
				console.error('Failed to serve plugin asset:', error.message);
				res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
				res.end('Internal server error');
			});
			return;
		}

		sendRedirect(res, REDIRECT_URL);
	});

	server.listen(PORT, HOST, () => {
		console.log(`Universal catalogue server listening on http://${HOST}:${PORT}`);
		console.log(`Serving plugin manifests from ${PLUGINS_DIR}`);
	});

	setInterval(() => {
		runHourlyUpdates().catch((error) => {
			console.error('Hourly update cycle failed:', error.message);
		});
	}, HOURLY_MS);

	(async () => {
		try {
			await loadKnownAgents();
			await pruneExpiredAgents();

			for (const agentId of knownAgents.keys()) {
				runUpdateForAgent(agentId, false);
			}
		} catch (error) {
			console.error('Startup background tasks failed:', error.message);
		}
	})();
}

start().catch((error) => {
	console.error('Failed to start server:', error);
	process.exitCode = 1;
});
