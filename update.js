const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

const LATEST_RELEASE_ABI = '12.2';
const NORMALIZED_WIDTH = 576;
const NORMALIZED_HEIGHT = 324;
const IMAGE_EXT = '.webp';
const fallbackImageUrl = 'https://raw.githubusercontent.com/0belous/Jellyfin-Universal-Plugin-Repo/refs/heads/main/assets/upr-missing.png';
const imageBaseUrl = 'https://obelous.dev/plugins/images/';
const pluginsDir = path.join(__dirname, 'plugins');
const pluginDir = path.join(pluginsDir, 'images');

const arg2 = (process.argv[2] || '').trim().toLowerCase();
const arg3 = (process.argv[3] || '').trim();
const regenImages = ['true', '1', 'yes'].includes(arg2);
const agentArg = (['true', '1', 'yes', 'false', '0', 'no'].includes(arg2) ? arg3 : (process.argv[2] || arg3)) || 'universal';
const sanitizedAgentVersion = agentArg.replace(/[^a-zA-Z0-9._/-]/g, '');
const agentLabel = sanitizedAgentVersion || 'universal';
const defaultUserAgent = /^jellyfin-server\//i.test(sanitizedAgentVersion) ? sanitizedAgentVersion : `Jellyfin-Server/${sanitizedAgentVersion}`;

const versionMatch = sanitizedAgentVersion.match(/\d+(\.\d+)*/);
const agentVersion = versionMatch ? versionMatch[0] : null;
const CHECKMARKS = ['', '✓', '✓✓', '✓✓✓'];

const logger = {
    info: (m) => console.log(`[${agentLabel}] ${m}`),
    error: (m) => console.error(`[${agentLabel}] ${m}`)
};

const hashString = (s) => crypto.createHash('md5').update(s).digest('hex');
const isBlockedHost = (u) => !u || /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0)/i.test(new URL(u).hostname);

function getMajorIndex(v) {
    if (!v) return null;
    const s = String(v).trim();
    const m10 = s.match(/^10\.(\d+)/);
    if (m10) return parseInt(m10[1], 10);
    const m = s.match(/^(\d+)/);
    return m ? parseInt(m[1], 10) : null;
}

function getMinorIndex(v) {
    if (!v) return null;
    const s = String(v).trim();
    if (s.startsWith('10.')) {
        const parts = s.replace(/^10\.\d+\.?/, '').split(/[^0-9]+/).filter(Boolean);
        return parts.length > 0 ? parseInt(parts[0], 10) : 0;
    }
    const parts = s.replace(/^\d+\.?/, '').split(/[^0-9]+/).filter(Boolean);
    return parts.length > 0 ? parseInt(parts[0], 10) : 0;
}

const targetMajorIdx = agentVersion ? getMajorIndex(agentVersion) : null;

function abiScore(req, cand) {
    const reqMajor = getMajorIndex(req);
    const candMajor = getMajorIndex(cand);
    if (reqMajor == null || candMajor == null) return 0;

    const diff = candMajor - reqMajor;

    if (diff === 0) {
        const reqMinor = getMinorIndex(req);
        const candMinor = getMinorIndex(cand);
        if (reqMinor != null && candMinor != null && reqMinor === candMinor) {
            return 3;
        }
        return 2;
    }

    if (Math.abs(diff) === 1) {
        return 1;
    }

    return 0;
}

function findGithubUrl(obj) {
    if (!obj) return null;
    for (const key in obj) {
        if (typeof obj[key] === 'string') {
            const m = obj[key].match(/https?:\/\/github\.com\/[^\/]+\/[^\/]+/);
            if (m) return m[0];
        } else if (typeof obj[key] === 'object') {
            const res = findGithubUrl(obj[key]);
            if (res) return res;
        }
    }
    return null;
}

function transformPlugins(plugins, genTime) {
    return plugins.map(p => {
        const guid = (p.guid || p.Guid || '').toLowerCase();
        const { Guid, ...rest } = p;

        if (rest.versions) {
            rest.versions.forEach(v => {
                if (v.dependencies) {
                    v.dependencies = v.dependencies.filter(d => d.toLowerCase() !== guid);
                }
            });
            rest.versions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        }

        const score = agentVersion
            ? (rest.versions || []).reduce((s, v) => Math.max(s, abiScore(agentVersion, v.targetAbi || v.TargetAbi)), 0)
            : 0;

        const badge = CHECKMARKS[score];
        if (badge && (rest.name || rest.Name)) {
            rest[rest.name ? 'name' : 'Name'] += ` [${badge}]`;
        }

        const repoUrl = findGithubUrl(p);
        const sourceUrl = rest._metaSourceUrl || 'Unknown';
        let appendText = `  \n  \nUniversal Repo:  \nGenerated: ${genTime}  \nSource: ${sourceUrl}`;
        delete rest._metaSourceUrl;
        delete rest._metaGithubUrl;
        if (repoUrl) appendText += `  \nGithub: ${repoUrl}`;

        const descKey = ['description', 'Description', 'overview'].find(k => rest[k]);
        if (descKey) {
            rest[descKey] = rest[descKey].replace(/@\[renovate\[bot\]\].*$/gs, '').replace(/\n\s*\n/g, '\n').trim();
            if (!rest[descKey].includes('Universal Repo:')) rest[descKey] += appendText;
        } else {
            rest.description = appendText.trim();
        }

        return { ...rest, guid };
    });
}

async function fetchSource(url) {
    if (isBlockedHost(url)) throw new Error('Blocked host');
    const res = await fetch(url, { headers: { 'User-Agent': defaultUserAgent }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

async function getSources(file) {
    const lines = (await fs.readFile(file, 'utf8')).split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#'));
    const sources = lines.map(l => { const [m, g] = l.split('|').map(s => s.trim()); return { m, g }; });
    const results = await Promise.allSettled(sources.map(s => fetchSource(s.m)));
    const plugins = [];

    results.forEach((r, i) => {
        if (r.status === 'fulfilled') {
            const rawList = Array.isArray(r.value) ? r.value : (r.value?.plugins || []);

            rawList.forEach(p => {
                const guid = p.guid || p.Guid;
                if (!guid) return;

                const allVersions = p.versions || p.Versions || [];

                let matchingVersions = [];

                if (targetMajorIdx != null) {
                    const exact = [];
                    const plusOne = [];
                    const minusOne = [];

                    allVersions.forEach(v => {
                        const candMajor = getMajorIndex(v.targetAbi || v.TargetAbi);
                        if (candMajor == null) return;
                        const diff = candMajor - targetMajorIdx;

                        if (diff === 0) exact.push(v);
                        else if (diff === 1) plusOne.push(v);
                        else if (diff === -1) minusOne.push(v);
                    });
                    if (exact.length > 0 || plusOne.length > 0) {
                        matchingVersions = [...exact, ...plusOne];
                    } else if (minusOne.length > 0) {
                        matchingVersions = [...minusOne];
                    }
                } else {
                    matchingVersions = allVersions;
                }

                if (matchingVersions.length > 0) {
                    const pluginEntry = {
                        ...p,
                        versions: matchingVersions,
                        _metaSourceUrl: sources[i].m,
                        _metaGithubUrl: sources[i].g
                    };
                    delete pluginEntry.Versions;
                    plugins.push(pluginEntry);
                }
            });
        } else {
            logger.error(`fetch failed: ${sources[i].m} (${r.reason.message})`);
        }
    });

    return { plugins, sourceCount: sources.length };
}

async function processSinglePass(url, filename) {
    try {
        if (isBlockedHost(url)) return false;
        const res = await fetch(url, { headers: { 'User-Agent': defaultUserAgent }, signal: AbortSignal.timeout(10000) });
        if (!res.ok) return false;
        await sharp(Buffer.from(await res.arrayBuffer()))
            .resize(NORMALIZED_WIDTH, NORMALIZED_HEIGHT, { fit: 'cover', position: 'centre' })
            .webp({ quality: 82, effort: 4 })
            .toFile(path.join(pluginDir, filename));
        return true;
    } catch { return false; }
}

async function processImages(plugins) {
    logger.info(`processing images for ${plugins.length} plugins`);
    const concurrency = 6;
    for (let i = 0; i < plugins.length; i += concurrency) {
        await Promise.all(plugins.slice(i, i + concurrency).map(async (p) => {
            const id = p.id || p.Id || p.pluginId || p.name || hashString(p.imageUrl || fallbackImageUrl);
            const fname = `${String(id).replace(/\s+/g, '')}${IMAGE_EXT}`;
            const exists = await fs.access(path.join(pluginDir, fname)).then(() => true).catch(() => false);

            if (regenImages || !exists) {
                if (!(await processSinglePass(p.imageUrl || fallbackImageUrl, fname))) {
                    await processSinglePass(fallbackImageUrl, fname);
                }
            }
            p.imageUrl = `${imageBaseUrl}${fname}`;
        }));
    }
}

async function main() {
    await fs.mkdir(pluginDir, { recursive: true });
    if (regenImages) await fs.readdir(pluginDir).then(files => Promise.all(files.map(f => fs.rm(path.join(pluginDir, f), { recursive: true, force: true }))));

    const { plugins: fetched, sourceCount } = await getSources(path.join(__dirname, 'sources.txt'));
    if (!fetched.length) throw new Error(`No plugins matched target major: ${targetMajorIdx ?? 'any'}`);

    const timestamp = new Date().toISOString();
    fetched.unshift({
        guid: crypto.randomUUID?.() || hashString('upr-dummy-' + timestamp),
        name: '! Universal Plugin Repo',
        description: `Aggregated: ${fetched.length}, Sources: ${sourceCount}.`,
        overview: `Generated: ${timestamp}`,
        owner: 'Obelous',
        category: 'Miscellaneous',
        imageUrl: 'https://raw.githubusercontent.com/0belous/Jellyfin-Universal-Plugin-Repo/refs/heads/main/assets/upr-main.png',
        _metaSourceUrl: 'internal',
        versions: [{ version: '0.0.0', targetAbi: agentVersion || LATEST_RELEASE_ABI, timestamp }]
    });

    await processImages(fetched);
    const transformed = transformPlugins(fetched, timestamp.substring(11, 16) + ' UTC');

    const manifest = JSON.stringify(transformed, null, 2);
    const out = path.join(pluginsDir, `manifest.${agentLabel}.json`);
    const tmp = `${out}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, manifest);
    await fs.rename(tmp, out);
    if (agentLabel === 'universal') await fs.writeFile(path.join(pluginsDir, 'manifest.json'), manifest);
    logger.info(`manifest written: ${out} (${transformed.length} plugins)`);
}

main().catch(e => {
    logger.error(e.message);
    process.exit(1);
});