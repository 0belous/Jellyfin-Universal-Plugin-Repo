const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

const HEADER_GUID = '00000000-0000-0000-0000-000000000000';
let latestReleaseAbi = '12.2';
const NORMALIZED_WIDTH = 576;
const NORMALIZED_HEIGHT = 324;
const IMAGE_EXT = '.webp';
const fallbackImageUrl = 'https://raw.githubusercontent.com/0belous/Jellyfin-Universal-Plugin-Repo/refs/heads/main/assets/upr-missing.png';
const imageBaseUrl = 'https://obelous.dev/plugins/images/';
const pluginsDir = path.join(__dirname, 'plugins');
const pluginDir = path.join(pluginsDir, 'images');
const validVersionsFile = path.join(pluginsDir, '.valid_versions.json');

const CHECKMARKS = ['', '✓', '✓✓', '✓✓✓'];

const hashString = (s) => crypto.createHash('md5').update(s).digest('hex');

const isBlockedHost = (u) => {
    try {
        if (!u) return true;
        const host = new URL(u).hostname;
        return /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0)/i.test(host);
    } catch {
        return true;
    }
};

const isGithubSource = (u) => {
    try {
        const host = new URL(u).hostname.toLowerCase();
        return (
            host === 'github.com' ||
            host === 'raw.githubusercontent.com' ||
            host === 'gist.githubusercontent.com' ||
            host.endsWith('.github.io') ||
            host.endsWith('.githubusercontent.com')
        );
    } catch {
        return false;
    }
};

async function updateValidVersions(targetFile = validVersionsFile, logger = console) {
    const versions = new Set();
    try {
        const existing = JSON.parse(await fs.readFile(targetFile, 'utf8'));
        if (Array.isArray(existing)) existing.forEach(v => versions.add(String(v)));
    } catch {}

    const maxMinorByMajor = new Map();
    let maxReleasedMajor = 0;

    function addExpanded(vStr, trackRelease = false) {
        if (!vStr) return;
        const clean = String(vStr).trim().replace(/^v/i, '');
        if (!/^\d+\.\d+/.test(clean)) return;
        versions.add(clean);

        const base = clean.split('-')[0];
        const parts = base.split('.').map(Number);
        if (parts.some(isNaN)) return;
        const maj = parts[0];
        const min = parts[1] ?? 0;
        const patch = parts[2] ?? 0;

        if (trackRelease && !clean.includes('-') && maj >= 10) {
            if (maj > maxReleasedMajor) maxReleasedMajor = maj;
            if (!maxMinorByMajor.has(maj) || min > maxMinorByMajor.get(maj)) {
                maxMinorByMajor.set(maj, min);
            }
        }

        if (maj >= 10) {
            versions.add(`${maj}.${min}`);
        }
        versions.add(`${maj}.${min}.${patch}`);
        versions.add(`${maj}.${min}.${patch}.0`);
    }

    try {
        let rawTags = [];
        try {
            const refsRes = await fetch('https://github.com/jellyfin/jellyfin.git/info/refs?service=git-upload-pack', {
                headers: { 'User-Agent': `Jellyfin-Server/${latestReleaseAbi}` },
                signal: AbortSignal.timeout(15000)
            });
            if (refsRes.ok) {
                const text = await refsRes.text();
                rawTags = [...new Set([...text.matchAll(/refs\/tags\/v([0-9]+\.[0-9]+(?:\.[0-9]+)*(?:-[a-zA-Z0-9._-]+)?)(?:\^\{\}|\s)/g)].map(m => m[1]))];
            }
        } catch {}

        if (rawTags.length === 0) {
            for (let page = 1; page <= 3; page++) {
                const apiRes = await fetch(`https://api.github.com/repos/jellyfin/jellyfin/tags?per_page=100&page=${page}`, {
                    headers: { 'User-Agent': `Jellyfin-Server/${latestReleaseAbi}` },
                    signal: AbortSignal.timeout(15000)
                });
                if (!apiRes.ok) break;
                const tags = await apiRes.json();
                if (!Array.isArray(tags) || tags.length === 0) break;
                tags.forEach(t => {
                    if (t?.name) rawTags.push(t.name.replace(/^v/i, ''));
                });
            }
        }

        rawTags.forEach(t => addExpanded(t, true));

        for (const [maj, maxMin] of maxMinorByMajor.entries()) {
            if (maj === 10 || maj === maxReleasedMajor) {
                addExpanded(`${maj}.${maxMin + 1}.0`, false);
            }
        }

        if (maxReleasedMajor >= 10) {
            latestReleaseAbi = `${maxReleasedMajor}.${maxMinorByMajor.get(maxReleasedMajor) ?? 0}`;
            const nextMaj = maxReleasedMajor + 1;
            addExpanded(`${nextMaj}.0.0`, false);
            addExpanded(`${nextMaj}.1.0`, false);
        }

        try {
            const svRes = await fetch('https://raw.githubusercontent.com/jellyfin/jellyfin/master/SharedVersion.cs', {
                headers: { 'User-Agent': `Jellyfin-Server/${latestReleaseAbi}` },
                signal: AbortSignal.timeout(10000)
            });
            if (svRes.ok) {
                const svText = await svRes.text();
                const matches = [...svText.matchAll(/Assembly(?:File)?Version\("([0-9]+\.[0-9]+(?:\.[0-9]+)*)"\)/g)];
                for (const m of matches) {
                    addExpanded(m[1], false);
                    const parts = m[1].split('.').map(Number);
                    if (!parts.some(isNaN) && parts[0] >= 10) {
                        addExpanded(`${parts[0]}.${(parts[1] ?? 0) + 1}.0`, false);
                    }
                }
            }
        } catch {}

        if (versions.size > 0) {
            const sorted = [...versions].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
            await fs.mkdir(path.dirname(targetFile), { recursive: true });
            const tmp = `${targetFile}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
            await fs.writeFile(tmp, JSON.stringify(sorted, null, 2));
            await fs.rename(tmp, targetFile);
        }
    } catch (err) {
        logger.error(`Failed to update valid Jellyfin versions: ${err.message}`);
    }

    return versions;
}

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

async function mapConcurrent(items, concurrency, fn) {
    const results = new Array(items.length);
    let index = 0;
    async function worker() {
        while (index < items.length) {
            const i = index++;
            try {
                results[i] = { status: 'fulfilled', value: await fn(items[i], i) };
            } catch (err) {
                results[i] = { status: 'rejected', reason: err };
            }
        }
    }
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
    await Promise.all(workers);
    return results;
}

async function fetchSourceWithRetry(url, options = {}) {
    const maxRetries = options.retries ?? 2;
    const timeoutMs = options.timeoutMs ?? 15000;
    const userAgent = options.userAgent || `Jellyfin-Server/${latestReleaseAbi}`;

    if (isBlockedHost(url)) throw new Error('Blocked host');

    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const res = await fetch(url, {
                headers: {
                    'User-Agent': userAgent,
                    'Accept': 'application/json, text/plain, */*'
                },
                signal: AbortSignal.timeout(timeoutMs)
            });

            if (!res.ok) {
                if ((res.status === 429 || (res.status >= 500 && res.status <= 504)) && attempt < maxRetries) {
                    const retryAfterHeader = res.headers.get('retry-after');
                    const retryAfterSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : null;
                    const delayMs = (retryAfterSec && !isNaN(retryAfterSec))
                        ? retryAfterSec * 1000
                        : Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 5000);
                    await new Promise(r => setTimeout(r, delayMs));
                    continue;
                }
                throw new Error(`HTTP ${res.status}`);
            }

            const data = await res.json();
            return data;
        } catch (err) {
            lastError = err;
            const isPermanentError =
                err instanceof SyntaxError ||
                err.message?.startsWith('HTTP 404') ||
                err.message?.startsWith('HTTP 403') ||
                err.message?.startsWith('HTTP 410');
            if (attempt < maxRetries && !isPermanentError) {
                const delayMs = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 4000);
                await new Promise(r => setTimeout(r, delayMs));
            } else {
                break;
            }
        }
    }
    throw lastError;
}

async function fetchSources(file, options = {}) {
    const concurrency = options.concurrency ?? 15;
    const logger = options.logger || console;
    const nonGithubOnly = options.nonGithubOnly || false;
    const lines = (await fs.readFile(file, 'utf8')).split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#'));
    const sources = lines.map(l => { const [m, g] = l.split('|').map(s => s.trim()); return { m, g }; });

    const uaVersions = Array.from(new Set(
        (options.agentVersions || [])
            .map(v => (v === 'universal' || !v) ? latestReleaseAbi : v)
            .filter(Boolean)
    ));
    if (uaVersions.length === 0) {
        uaVersions.push(latestReleaseAbi);
    }

    const tasks = [];
    const nonGithubSources = [];

    for (const s of sources) {
        if (isGithubSource(s.m)) {
            if (!nonGithubOnly) {
                tasks.push({
                    source: s,
                    userAgent: `Jellyfin-Server/${latestReleaseAbi}`,
                    isGithub: true
                });
            }
        } else {
            nonGithubSources.push(s);
        }
    }

    // Interleave by version across non-GitHub sources to avoid bursting a single host
    for (const ver of uaVersions) {
        const ua = /^jellyfin(?:-server)?\//i.test(ver) ? ver : `Jellyfin-Server/${ver}`;
        for (const s of nonGithubSources) {
            tasks.push({
                source: s,
                userAgent: ua,
                version: ver,
                isGithub: false
            });
        }
    }

    const results = await mapConcurrent(tasks, concurrency, t =>
        fetchSourceWithRetry(t.source.m, { ...options, userAgent: t.userAgent })
    );

    const rawPlugins = [];
    const sourceStatus = new Map();

    results.forEach((r, i) => {
        const { source } = tasks[i];
        if (r.status === 'fulfilled') {
            sourceStatus.set(source.m, { ok: true });
            const rawList = Array.isArray(r.value) ? r.value : (r.value?.plugins || []);
            rawList.forEach(p => {
                const guid = p.guid || p.Guid;
                if (!guid) return;
                rawPlugins.push({
                    ...p,
                    _metaSourceUrl: source.m,
                    _metaGithubUrl: source.g
                });
            });
        } else if (!sourceStatus.get(source.m)?.ok) {
            sourceStatus.set(source.m, { ok: false, reason: r.reason?.message || r.reason });
        }
    });

    for (const [url, status] of sourceStatus.entries()) {
        if (!status.ok) {
            logger.error(`fetch failed: ${url} (${status.reason})`);
        }
    }

    return { rawPlugins, sourceCount: sources.length, fetchedAgentVersions: new Set(uaVersions) };
}

function deduplicateAndMergePlugins(plugins) {
    const map = new Map();
    for (const p of plugins) {
        const rawGuid = p.guid || p.Guid;
        if (!rawGuid) continue;
        const guidKey = String(rawGuid).toLowerCase().trim();
        if (!guidKey) continue;

        if (!map.has(guidKey)) {
            const entry = {
                ...p,
                guid: rawGuid,
                versions: [...(p.versions || p.Versions || [])]
            };
            delete entry.Guid;
            delete entry.Versions;
            map.set(guidKey, entry);
        } else {
            const existing = map.get(guidKey);
            const existingVersions = existing.versions || [];
            const incomingVersions = p.versions || p.Versions || [];

            // Merge versions, deduplicating identical version entries
            const seen = new Set(existingVersions.map(v => `${(v.version || '').trim()}|${(v.targetAbi || v.TargetAbi || '').trim()}|${(v.checksum || '').trim()}`));
            for (const v of incomingVersions) {
                const key = `${(v.version || '').trim()}|${(v.targetAbi || v.TargetAbi || '').trim()}|${(v.checksum || '').trim()}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    existingVersions.push(v);
                }
            }

            // Fill in missing metadata fields if existing is missing them
            if (!existing.description && p.description) existing.description = p.description;
            if (!existing.overview && p.overview) existing.overview = p.overview;
            if (!existing.owner && p.owner) existing.owner = p.owner;
            if (!existing.category && p.category) existing.category = p.category;
            if (!existing.imageUrl && p.imageUrl) existing.imageUrl = p.imageUrl;
            if (!existing.name && (p.name || p.Name)) existing.name = p.name || p.Name;
        }
    }
    return Array.from(map.values());
}

function filterVersionsForAgent(allVersions, targetMajorIdx) {
    if (targetMajorIdx == null) return allVersions;

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
        return [...exact, ...plusOne];
    } else if (minusOne.length > 0) {
        return [...minusOne];
    }
    return [];
}

async function processSinglePass(url, filename, options = {}) {
    const targetPluginDir = options.pluginDir || pluginDir;
    try {
        if (isBlockedHost(url)) return false;
        const res = await fetch(url, {
            headers: { 'User-Agent': 'Jellyfin-Universal-Catalogue/1.0 (+https://github.com/0belous/Jellyfin-Universal-Catalogue)' },
            signal: AbortSignal.timeout(10000)
        });
        if (!res.ok) return false;
        await sharp(Buffer.from(await res.arrayBuffer()))
            .resize(NORMALIZED_WIDTH, NORMALIZED_HEIGHT, { fit: 'cover', position: 'centre' })
            .webp({ quality: 82, effort: 4 })
            .toFile(path.join(targetPluginDir, filename));
        return true;
    } catch {
        return false;
    }
}

async function processImages(plugins, options = {}) {
    const targetPluginDir = options.pluginDir || pluginDir;
    const regenImages = options.regenImages || false;
    const logger = options.logger || console;
    logger.info(`processing images for ${plugins.length} plugins`);
    const concurrency = 6;
    for (let i = 0; i < plugins.length; i += concurrency) {
        await Promise.all(plugins.slice(i, i + concurrency).map(async (p) => {
            const id = p.id || p.Id || p.pluginId || p.name || hashString(p.imageUrl || fallbackImageUrl);
            const fname = `${String(id).replace(/\s+/g, '')}${IMAGE_EXT}`;
            const exists = await fs.access(path.join(targetPluginDir, fname)).then(() => true).catch(() => false);

            if (regenImages || !exists) {
                if (!(await processSinglePass(p.imageUrl || fallbackImageUrl, fname, options))) {
                    await processSinglePass(fallbackImageUrl, fname, options);
                }
            }
            p.imageUrl = `${imageBaseUrl}${fname}`;
        }));
    }
}

function transformPlugins(plugins, agentVersion, genTime) {
    return plugins.map(p => {
        const guid = p.guid || p.Guid;
        const guidLower = String(guid || '').toLowerCase().trim();
        const { Guid, ...rest } = p;

        if (rest.versions) {
            rest.versions.forEach(v => {
                if (v.dependencies) {
                    v.dependencies = v.dependencies.filter(d => (d || '').toLowerCase() !== guidLower);
                }
            });
            rest.versions.sort((a, b) => {
                const timeDiff = new Date(b.timestamp || 0) - new Date(a.timestamp || 0);
                if (timeDiff !== 0) return timeDiff;
                return (b.version || '').localeCompare(a.version || '');
            });
        }

        const isHeader = (guidLower === HEADER_GUID);
        const score = (agentVersion && !isHeader)
            ? (rest.versions || []).reduce((s, v) => Math.max(s, abiScore(agentVersion, v.targetAbi || v.TargetAbi)), 0)
            : 0;

        const badge = CHECKMARKS[score];

        const repoUrl = rest._metaGithubUrl || findGithubUrl(p);
        const sourceUrl = rest._metaSourceUrl || 'Unknown';
        let appendText = `  \n  \nUniversal Repo${badge ? ` [${badge}]` : ''} \nSource: ${sourceUrl}`;
        delete rest._metaSourceUrl;
        delete rest._metaGithubUrl;
        if (repoUrl) appendText += `  \nGithub: ${repoUrl}`;

        const descKey = ['description', 'Description', 'overview'].find(k => rest[k]);
        if (descKey) {
            rest[descKey] = rest[descKey].replace(/@\[renovate\[bot\]\].*$/gs, '').replace(/\n\s*\n/g, '\n').trim();
            if (!rest[descKey].includes('Universal Repo')) rest[descKey] += appendText;
        } else {
            rest.description = appendText.trim();
        }

        return { ...rest, guid };
    }).sort((a, b) =>
        String(a.guid || '').toLowerCase().localeCompare(String(b.guid || '').toLowerCase()) ||
        (a.name || a.Name || '').localeCompare(b.name || b.Name || '')
    );
}

function generateManifestForAgent(agentVersionStr, rawPlugins, sourceCount, options = {}) {
    const timestamp = options.timestamp || new Date().toISOString();
    const genTime = timestamp.substring(11, 16) + ' UTC';

    const versionMatch = (agentVersionStr || '').match(/\d+(\.\d+)*/);
    const agentVersion = (agentVersionStr === 'universal' || !agentVersionStr) ? null : (versionMatch ? versionMatch[0] : null);
    const targetMajorIdx = agentVersion ? getMajorIndex(agentVersion) : null;

    // Filter versions for each plugin
    const filteredPlugins = [];
    for (const p of rawPlugins) {
        const matchingVersions = filterVersionsForAgent(p.versions || p.Versions || [], targetMajorIdx);
        if (matchingVersions.length > 0) {
            filteredPlugins.push({
                ...p,
                versions: matchingVersions.map(v => ({ ...v }))
            });
        }
    }

    // Deduplicate and merge plugins by GUID
    const deduped = deduplicateAndMergePlugins(filteredPlugins);

    // Create the dummy header plugin with fixed GUID
    const headerPlugin = {
        guid: HEADER_GUID,
        name: '! Universal Plugin Repo',
        description: `Aggregated: ${deduped.length}, Sources: ${sourceCount}.`,
        overview: `Generated: ${timestamp}`,
        owner: 'Obelous',
        category: 'Miscellaneous',
        imageUrl: 'https://raw.githubusercontent.com/0belous/Jellyfin-Universal-Plugin-Repo/refs/heads/main/assets/upr-main.png',
        _metaSourceUrl: 'internal',
        _metaGithubUrl: 'https://github.com/0belous/Jellyfin-Universal-Catalogue',
        versions: [{ version: '0.0.0', targetAbi: agentVersion || latestReleaseAbi, timestamp }]
    };

    deduped.unshift(headerPlugin);

    return transformPlugins(deduped, agentVersion, genTime);
}

async function writeManifest(targetDir, agentLabel, manifestData) {
    const manifestJson = JSON.stringify(manifestData, null, 2);
    const out = path.join(targetDir, `manifest.${agentLabel}.json`);
    const tmp = `${out}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.writeFile(tmp, manifestJson);
    await fs.rename(tmp, out);
    if (agentLabel === 'universal') {
        const rootManifest = path.join(targetDir, 'manifest.json');
        const rootTmp = `${rootManifest}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
        await fs.writeFile(rootTmp, manifestJson);
        await fs.rename(rootTmp, rootManifest);
    }
    return out;
}

async function updateAll(options = {}) {
    const sourcesFile = options.sourcesFile || path.join(__dirname, 'sources.txt');
    const targetPluginsDir = options.pluginsDir || pluginsDir;
    const targetImagesDir = path.join(targetPluginsDir, 'images');
    const targetValidVersionsFile = options.validVersionsFile || path.join(targetPluginsDir, '.valid_versions.json');
    const regenImages = options.regenImages || false;
    const logger = options.logger || console;
    const agentVersions = options.agentVersions || ['universal'];

    await fs.mkdir(targetImagesDir, { recursive: true });
    if (regenImages) {
        const files = await fs.readdir(targetImagesDir);
        await Promise.all(files.map(f => fs.rm(path.join(targetImagesDir, f), { recursive: true, force: true })));
    }

    const validVersions = options.skipValidVersionsUpdate
        ? new Set()
        : await updateValidVersions(targetValidVersionsFile, logger);

    logger.info(`Fetching sources from ${sourcesFile}...`);
    const { rawPlugins, sourceCount, fetchedAgentVersions } = await fetchSources(sourcesFile, {
        concurrency: 15,
        retries: 2,
        timeoutMs: 15000,
        agentVersions,
        logger
    });

    if (!rawPlugins.length) {
        throw new Error('No plugins could be fetched from sources.');
    }

    const dedupedRaw = deduplicateAndMergePlugins(rawPlugins);
    logger.info(`Processing images for ${dedupedRaw.length} unique plugins...`);
    await processImages(dedupedRaw, {
        regenImages,
        pluginDir: targetImagesDir,
        logger
    });

    const timestamp = new Date().toISOString();
    logger.info(`Generating manifests for ${agentVersions.length} target agents...`);

    for (const agentLabel of agentVersions) {
        const transformed = generateManifestForAgent(agentLabel, dedupedRaw, sourceCount, { timestamp });
        await writeManifest(targetPluginsDir, agentLabel, transformed);
    }

    logger.info(`Successfully generated ${agentVersions.length} manifests from ${sourceCount} sources.`);
    return { rawPlugins: dedupedRaw, sourceCount, fetchedAgentVersions, validVersions };
}

async function cliMain() {
    const arg2 = (process.argv[2] || '').trim().toLowerCase();
    const arg3 = (process.argv[3] || '').trim();
    const regenImages = ['true', '1', 'yes'].includes(arg2);
    const agentArg = (['true', '1', 'yes', 'false', '0', 'no'].includes(arg2) ? arg3 : (process.argv[2] || arg3)) || '';

    const KNOWN_AGENTS_FILE = path.join(pluginsDir, '.known_user_agents.json');

    let agentVersions;
    if (agentArg === '--all' || agentArg === 'all') {
        let known = [];
        try {
            const data = JSON.parse(await fs.readFile(KNOWN_AGENTS_FILE, 'utf8'));
            known = Object.keys(data);
        } catch {}
        agentVersions = Array.from(new Set(['universal', ...known]));
    } else if (agentArg) {
        const sanitizedAgentVersion = agentArg.replace(/[^a-zA-Z0-9._/-]/g, '');
        agentVersions = [sanitizedAgentVersion || 'universal'];
    } else {
        agentVersions = ['universal'];
    }

    await updateAll({
        sourcesFile: path.join(__dirname, 'sources.txt'),
        pluginsDir,
        agentVersions,
        regenImages,
        logger: {
            info: (m) => console.log(`[update] ${m}`),
            error: (m) => console.error(`[update] ${m}`)
        }
    });
}

if (require.main === module) {
    cliMain().catch(e => {
        console.error(e.message);
        process.exit(1);
    });
}

module.exports = {
    HEADER_GUID,
    CHECKMARKS,
    isGithubSource,
    updateValidVersions,
    getMajorIndex,
    getMinorIndex,
    abiScore,
    findGithubUrl,
    fetchSourceWithRetry,
    fetchSources,
    deduplicateAndMergePlugins,
    filterVersionsForAgent,
    processImages,
    transformPlugins,
    generateManifestForAgent,
    writeManifest,
    updateAll
};
