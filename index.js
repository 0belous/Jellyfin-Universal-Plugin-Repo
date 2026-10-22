const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const readline = require('readline');
const {
    HEADER_GUID,
    updateValidVersions,
    fetchSources,
    deduplicateAndMergePlugins,
    processImages,
    updateAll,
    generateManifestForAgent,
    writeManifest
} = require('./update');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);
const REDIRECT_URL = 'https://github.com/0belous/Jellyfin-Universal-Catalogue';
const HOURLY_MS = 3600000;
const WEEK_MS = 604800000;

const PLUGINS_DIR = path.resolve(__dirname, './plugins');
const IMAGES_DIR = path.join(PLUGINS_DIR, 'images');
const KNOWN_AGENTS_FILE = path.join(PLUGINS_DIR, '.known_user_agents.json');
const VALID_VERSIONS_FILE = path.join(PLUGINS_DIR, '.valid_versions.json');

const knownAgents = new Map();
let validVersions = new Set();
const agentStatuses = new Map();
let currentStatusLine = '';
let cachedSourceData = null;
let isUpdating = false;

const logStatus = () => {
    if (!process.stdout.isTTY || process.env.CI) return;
    const entries = [...agentStatuses.entries()].sort((a, b) => b[1].ts - a[1].ts);
    const line = entries[0] ? `[${entries[0][0]}] ${entries[0][1].msg}` : '';
    if (line === currentStatusLine) return;
    currentStatusLine = line;
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    process.stdout.write(line);
};

const setStatus = (id, msg) => {
    agentStatuses.set(id, { msg, ts: Date.now() });
    logStatus();
};

const logger = {
    info: (msg) => {
        setStatus('update', msg);
        if (!process.stdout.isTTY || process.env.CI) {
            console.log(`[update] ${msg}`);
        }
    },
    error: (msg) => {
        setStatus('update', `err: ${msg}`);
        console.error(`[update error] ${msg}`);
    }
};

const normalizeUA = (ua) => ua?.match(/^jellyfin(?:-server)?\/([^\s;]+)/i)?.[1]?.replace(/[^a-zA-Z0-9._-]/g, '') || null;

const saveKnownAgents = async () => {
    const tmp = `${KNOWN_AGENTS_FILE}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(Object.fromEntries(knownAgents), null, 2));
    await fs.rename(tmp, KNOWN_AGENTS_FILE);
};

const prune = async () => {
    const cutoff = Date.now() - WEEK_MS;
    for (const [id, seen] of knownAgents) {
        const seenTime = new Date(seen).getTime();
        const isExpired = isNaN(seenTime) || seenTime < cutoff;
        const isInvalid = validVersions.size > 0 && !validVersions.has(id);
        if (isExpired || isInvalid) {
            knownAgents.delete(id);
            await fs.rm(path.join(PLUGINS_DIR, `manifest.${id}.json`), { force: true }).catch(() => {});
        }
    }
    await saveKnownAgents();
};

const runUpdateAll = async (regen = false) => {
    if (isUpdating) return;
    isUpdating = true;
    try {
        const updatedValid = await updateValidVersions(VALID_VERSIONS_FILE, logger);
        if (updatedValid.size > 0) {
            validVersions = updatedValid;
        }
        await prune();

        const agentVersions = Array.from(new Set(['universal', ...knownAgents.keys()]));
        cachedSourceData = await updateAll({
            sourcesFile: path.join(__dirname, 'sources.txt'),
            pluginsDir: PLUGINS_DIR,
            validVersionsFile: VALID_VERSIONS_FILE,
            skipValidVersionsUpdate: true,
            agentVersions,
            regenImages: regen,
            logger
        });
    } catch (err) {
        logger.error(`Update failed: ${err.message}`);
    } finally {
        isUpdating = false;
    }
};

const serve = async (res, file, type = 'application/octet-stream') => {
    try {
        const data = await fs.readFile(file);
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        res.end(data);
    } catch {
        res.writeHead(404).end();
    }
};

const start = async () => {
    await fs.mkdir(IMAGES_DIR, { recursive: true });
    try {
        const validData = JSON.parse(await fs.readFile(VALID_VERSIONS_FILE, 'utf8'));
        if (Array.isArray(validData)) {
            validVersions = new Set(validData.map(String));
        }
    } catch {}

    try {
        const data = JSON.parse(await fs.readFile(KNOWN_AGENTS_FILE, 'utf8'));
        Object.entries(data).forEach(([k, v]) => knownAgents.set(k, v));
    } catch {}

    const updatedValid = await updateValidVersions(VALID_VERSIONS_FILE, logger);
    if (updatedValid.size > 0) {
        validVersions = updatedValid;
    }
    await prune();

    http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const p = url.pathname;

        if (p === '/upr') {
            const id = normalizeUA(req.headers['user-agent']);
            if (!id || (validVersions.size > 0 && !validVersions.has(id))) {
                return res.writeHead(302, { Location: REDIRECT_URL }).end();
            }

            // Refresh TTL only when the user agent is actually seen
            knownAgents.set(id, new Date().toISOString());
            await saveKnownAgents().catch(() => {});

            const manifestPath = path.join(PLUGINS_DIR, `manifest.${id}.json`);
            const exists = await fs.stat(manifestPath).then(s => s.size > 2).catch(() => false);

            if (exists) {
                return serve(res, manifestPath, 'application/json');
            }

            if (cachedSourceData && cachedSourceData.rawPlugins) {
                try {
                    if (!cachedSourceData.fetchedAgentVersions?.has(id)) {
                        const { rawPlugins: extraPlugins } = await fetchSources(
                            path.join(__dirname, 'sources.txt'),
                            {
                                nonGithubOnly: true,
                                agentVersions: [id],
                                concurrency: 15,
                                retries: 2,
                                timeoutMs: 15000,
                                logger
                            }
                        );
                        if (extraPlugins.length > 0) {
                            await processImages(extraPlugins, { pluginDir: IMAGES_DIR, logger });
                            cachedSourceData.rawPlugins = deduplicateAndMergePlugins([
                                ...cachedSourceData.rawPlugins,
                                ...extraPlugins
                            ]);
                        }
                        cachedSourceData.fetchedAgentVersions?.add(id);
                    }

                    const transformed = generateManifestForAgent(id, cachedSourceData.rawPlugins, cachedSourceData.sourceCount);
                    await writeManifest(PLUGINS_DIR, id, transformed);
                    return serve(res, manifestPath, 'application/json');
                } catch (err) {
                    logger.error(`Failed to generate manifest for ${id}: ${err.message}`);
                }
            }

            if (!isUpdating) {
                runUpdateAll().catch(() => {});
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify([{
                guid: HEADER_GUID,
                name: 'Jellyfin Universal Catalogue',
                description: `Initializing repo for ${id}. Please refresh in a moment.`,
                overview: 'Generating manifest...',
                owner: 'Obelous',
                category: 'Miscellaneous',
                imageUrl: 'https://dl.obelous.dev/public/upr-loading.png',
                versions: [{ version: '0.0.0', targetAbi: id, timestamp: new Date().toISOString() }]
            }]));
        }

        const img = p.match(/^\/plugins\/images\/(.+\.(webp|png|jpg|svg))$/i);
        if (img) return serve(res, path.join(IMAGES_DIR, img[1]), `image/${img[2] === 'svg' ? 'svg+xml' : img[2]}`);

        res.writeHead(302, { Location: REDIRECT_URL }).end();
    }).listen(PORT, HOST, () => console.log(`Server at http://${HOST}:${PORT}`));

    setInterval(() => { runUpdateAll(); }, HOURLY_MS);
    runUpdateAll();
};

start().catch(console.error);
