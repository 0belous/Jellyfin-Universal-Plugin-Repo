const { parentPort } = require('worker_threads');

function isAllowedUrl(url) {
	let parsed;
	try { parsed = new URL(url); } catch { return false; }
	if (parsed.protocol !== 'https:') return false;
	const host = parsed.hostname;
	if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0)/i.test(host)) return false;
	return true;
}

parentPort.on('message', async (message) => {
	const { id, url, userAgent } = message;

	if (!isAllowedUrl(url)) {
		parentPort.postMessage({ id, success: false, error: 'URL not allowed', url });
		return;
	}

	let headerUA = userAgent || 'unknown';
	if (!/^jellyfin-server\//i.test(headerUA)) {
		headerUA = 'Jellyfin-Server/' + headerUA;
	}

	try {
		const response = await fetch(url, {
			headers: { 'User-Agent': headerUA }
		});

		if (!response.ok) {
			throw new Error(`Status: ${response.status}`);
		}

		const json = await response.json();
		parentPort.postMessage({ id, success: true, data: json, url });
	} catch (error) {
		parentPort.postMessage({
			id,
			success: false,
			error: error.message,
			url
		});
	}
});
