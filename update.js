const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

const LATEST_RELEASE_ABI = '10.11';
const NORMALIZED_WIDTH = 576;
const NORMALIZED_HEIGHT = 324;
const IMAGE_EXT = '.webp';
const fallbackImageUrl = 'https://dl.obelous.dev/public/upr-missing.png';
const imageBaseUrl = 'https://obelo.us/plugins/images/';
const pluginDir = path.join('./plugins', 'images');

const arg2 = (process.argv[2] || '').trim().toLowerCase();
const arg3 = (process.argv[3] || '').trim();
const regenImages = ['true', '1', 'yes'].includes(arg2);
const agentArg = (['true', '1', 'yes', 'false', '0', 'no'].includes(arg2) ? arg3 : (process.argv[2] || arg3)) || 'universal';
const sanitizedAgentVersion = agentArg.replace(/[^a-zA-Z0-9._-]/g, '');
const agentLabel = agentArg.replace(/[^a-zA-Z0-9._-]/g, '') || 'universal';
const defaultUserAgent = /^jellyfin-server\//i.test(sanitizedAgentVersion) ? sanitizedAgentVersion : `Jellyfin-Server/${sanitizedAgentVersion}`;

const ABI_BADGE = {
    0: { label: '', bg: '', fg: '' },
    1: { label: '✓', bg: '#1d4ed8', fg: '#ffffff' },
    2: { label: '✓✓', bg: '#15803d', fg: '#ffffff' },
    3: { label: '✓✓✓', bg: '#15803d', fg: '#ffffff' }
};

const logger = {
    info: (m) => console.log(`[${agentLabel}] ${m}`),
    error: (m) => console.error(`[${agentLabel}] ${m}`)
};

const hashString = (s) => crypto.createHash('md5').update(s).digest('hex');
const isVersionMatch = (t, c) => !c || c === '.' || c === '*.*' || c.split(',').some(p => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*')}$`).test(t) || t.startsWith(p.replace(/\*+$/, '')));
const matchesAbiPrefix = (a, p) => a && p && (a === p.replace(/\.\*$/, '') || a.startsWith(p.replace(/\.\*$/, '') + '.') || a.startsWith(p.replace(/\.\*$/, '') + '-') || a.startsWith(p.replace(/\.\*$/, '')));
const pluginSupportsAnyAbi = (p, prefixes) => (p.versions || p.Versions || []).some(v => prefixes.some(pre => matchesAbiPrefix(String(v.targetAbi || v.TargetAbi || ''), pre)));
const toAbiParts = (v) => String(v || '').split(/[^0-9]+/).filter(Boolean).slice(0, 3).map(Number);

function getAbiMatchScore(req, cand) {
    const r = toAbiParts(req), c = toAbiParts(cand);
    if (!r.length || !c.length || r[0] !== c[0]) return 0;
    if (r[1] == null || c[1] == null || r[1] !== c[1]) return 1;
    return r[2] != null && c[2] != null && r[2] === c[2] ? 3 : 2;
}

function getPluginAbiBadgeScore(p, req) {
    return (p.versions || p.Versions || []).reduce((s, v) => Math.max(s, getAbiMatchScore(req, v.targetAbi || v.TargetAbi || '')), 0);
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
                if (v.dependencies) v.dependencies = v.dependencies.filter(d => d.toLowerCase() !== guid);
            });
            rest.versions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
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
    const res = await fetch(url, { headers: { 'User-Agent': defaultUserAgent } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

async function getSources(file) {
    const lines = (await fs.readFile(file, 'utf8')).split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#'));
    const filtered = lines.map(l => { const [m, g, t] = l.split('|').map(s => s.trim()); return { m, g, t: t || '.' }; }).filter(s => /^12/.test(sanitizedAgentVersion) || isVersionMatch(sanitizedAgentVersion, s.t));
    const results = await Promise.allSettled(filtered.map(s => fetchSource(s.m)));
    const plugins = [];

    results.forEach((r, i) => {
        if (r.status === 'fulfilled') {
            (Array.isArray(r.value) ? r.value : (r.value.plugins || [])).forEach(p => {
                if (p.guid || p.Guid) {
                    if (/^12/.test(sanitizedAgentVersion) && !pluginSupportsAnyAbi(p, ['12.*', '10.11', '10.10'])) return;
                    p._metaSourceUrl = filtered[i].m;
                    p._metaGithubUrl = filtered[i].g;
                    plugins.push(p);
                }
            });
        } else {
            logger.error(`fetch failed: ${filtered[i].m} (${r.reason.message})`);
        }
    });

    return { plugins, sourceCount: filtered.length };
}

async function processSinglePass(url, filename, score) {
    try {
        const res = await fetch(url, { headers: { 'User-Agent': defaultUserAgent } });
        if (!res.ok) throw new Error();
        let pipeline = sharp(Buffer.from(await res.arrayBuffer())).resize(NORMALIZED_WIDTH, NORMALIZED_HEIGHT, { fit: 'cover', position: 'centre' });
        const style = ABI_BADGE[score];
        if (style?.label) {
            const w = Math.max(34, style.label.length * 16 + 24);
            const badge = Buffer.from(`<svg width="${w}" height="34" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="${w}" height="34" rx="17" fill="${style.bg}"/><text x="${w / 2}" y="24.48" text-anchor="middle" font-size="22" font-family="DejaVu Sans, sans-serif" fill="${style.fg}">${style.label}</text></svg>`);
            pipeline = pipeline.composite([{ input: badge, top: Math.round((NORMALIZED_HEIGHT - 34) / 2 - 60), left: Math.round(NORMALIZED_WIDTH - w - 10) }]);
        }
        const dir = path.join(pluginDir, agentLabel);
        await fs.mkdir(dir, { recursive: true });
        await pipeline.webp({ quality: 82, effort: 6 }).toFile(path.join(dir, filename));
        return true;
    } catch { return false; }
}

async function processImages(plugins) {
    logger.info(`processing images for ${plugins.length} plugins`);
    await Promise.all(plugins.map(async (p) => {
        const score = getPluginAbiBadgeScore(p, sanitizedAgentVersion);
        const id = p.id || p.Id || p.pluginId || p.name || hashString(p.imageUrl || fallbackImageUrl);
        const fname = `${String(id).replace(/\s+/g, '')}${IMAGE_EXT}`;
        const exists = await fs.access(path.join(pluginDir, agentLabel, fname)).then(() => true).catch(() => false);

        if (regenImages || !exists) {
            if (!(await processSinglePass(p.imageUrl || fallbackImageUrl, fname, score))) {
                await processSinglePass(fallbackImageUrl, fname, score);
            }
        }
        p.imageUrl = `${imageBaseUrl}${agentLabel}/${fname}`;
    }));
}

async function main() {
    await fs.mkdir(path.join(pluginDir, agentLabel), { recursive: true });
    if (regenImages) await fs.readdir(pluginDir).then(files => Promise.all(files.map(f => fs.rm(path.join(pluginDir, f), { recursive: true, force: true }))));
    
    const { plugins: fetched, sourceCount } = await getSources('sources.txt');
    if (!fetched.length) return;

    const timestamp = new Date().toISOString();
    fetched.unshift({
        guid: crypto.randomUUID?.() || hashString('upr-dummy-' + timestamp),
        name: '! Universal Plugin Repo',
        description: `Aggregated: ${fetched.length}, Sources: ${sourceCount}.`,
        overview: `Generated: ${timestamp}`,
        owner: 'Obelous',
        category: 'Miscellaneous',
        imageUrl: 'https://dl.obelous.dev/public/upr-main.png',
        _metaSourceUrl: 'internal',
        versions: [{ version: '0.0.0', targetAbi: sanitizedAgentVersion, timestamp }]
    });

    const transformed = transformPlugins(fetched, timestamp.substring(11, 16) + ' UTC');
    await processImages(transformed);
    
    const manifest = JSON.stringify(transformed, null, 2);
    const out = path.join('./plugins', `manifest.${agentLabel}.json`);
    await fs.writeFile(out, manifest);
    if (agentLabel === 'universal') await fs.writeFile(path.join('./plugins', 'manifest.json'), manifest);
    logger.info(`manifest written: ${out} (${transformed.length} plugins)`);
}

main().catch(e => logger.error(e.message));