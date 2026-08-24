const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');
const crypto = require('crypto');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);
const REDIRECT_URL = 'https://github.com/0belous/Jellyfin-Universal-Catalogue';
const HOURLY_MS = 3600000;
const MONTH_MS = 2592000000;

const PLUGINS_DIR = path.resolve(__dirname, './plugins');
const IMAGES_DIR = path.join(PLUGINS_DIR, 'images');
const KNOWN_AGENTS_FILE = path.join(PLUGINS_DIR, '.known_user_agents.json');

const updateInProgress = new Set();
const knownAgents = new Map();
const agentStatuses = new Map();
let currentStatusLine = '';

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

const normalizeUA = (ua) => ua?.match(/^jellyfin(?:-server)?\/([^\s;]+)/i)?.[1]?.replace(/[^a-zA-Z0-9._-]/g, '') || null;

const runUpdate = (id, regen = false) => {
    if (updateInProgress.has(id)) return;
    updateInProgress.add(id);
    const proc = spawn(process.execPath, [path.join(__dirname, 'update.js'), regen, id], { cwd: __dirname });
    
    proc.stdout.on('data', d => {
        const line = d.toString().split('\n').find(l => l.includes(']'));
        if (line) {
            const msg = line.split(']').slice(1).join(']').trim();
            if (msg) setStatus(id, msg);
        }
    });

    proc.on('close', (code) => {
        updateInProgress.delete(id);
        if (code === 0) {
            knownAgents.set(id, new Date().toISOString());
            fs.writeFile(KNOWN_AGENTS_FILE, JSON.stringify(Object.fromEntries(knownAgents), null, 2));
        }
    });
};

const prune = async () => {
    const cutoff = Date.now() - MONTH_MS;
    for (const [id, seen] of knownAgents) {
        if (new Date(seen).getTime() < cutoff) {
            knownAgents.delete(id);
            await Promise.allSettled([
                fs.rm(path.join(PLUGINS_DIR, `manifest.${id}.json`), { force: true }),
                fs.rm(path.join(IMAGES_DIR, id), { recursive: true, force: true })
            ]);
        }
    }
    await fs.writeFile(KNOWN_AGENTS_FILE, JSON.stringify(Object.fromEntries(knownAgents), null, 2));
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
        const data = JSON.parse(await fs.readFile(KNOWN_AGENTS_FILE, 'utf8'));
        Object.entries(data).forEach(([k, v]) => knownAgents.set(k, v));
    } catch {}

    http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const p = url.pathname;

        if (p === '/upr') {
            const id = normalizeUA(req.headers['user-agent']);
            if (!id) return res.writeHead(302, { Location: REDIRECT_URL }).end();
            
            const manifestPath = path.join(PLUGINS_DIR, `manifest.${id}.json`);
            const exists = await fs.access(manifestPath).then(() => true).catch(() => false);
            
            if (exists) return serve(res, manifestPath, 'application/json');
            
            runUpdate(id);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify([{
                guid: crypto.randomUUID(),
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

    setInterval(() => { prune(); [...knownAgents.keys()].forEach(id => runUpdate(id)); }, HOURLY_MS);
    prune().then(() => [...knownAgents.keys()].forEach(id => runUpdate(id)));
};

start().catch(console.error);