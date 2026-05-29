const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { Worker } = require('worker_threads');

const arg2 = String(process.argv[2] || '').trim();
const arg3 = String(process.argv[3] || '').trim();

const trueValues = ['true', '1', 'yes'];
const falseValues = ['false', '0', 'no'];
const arg2Lower = arg2.toLowerCase();

let regenImages = false;
let agentArg = '';

if (trueValues.includes(arg2Lower)) {
    regenImages = true;
    agentArg = arg3;
} else if (falseValues.includes(arg2Lower)) {
    regenImages = false;
    agentArg = arg3;
} else {
    agentArg = arg2 || arg3;
}

const pluginDir = path.join('./plugins', 'images');
const imageBaseUrl = 'https://obelo.us/plugins/images/';
const fallbackImageUrl = 'https://dl.obelous.dev/public/upr-missing.png';
const sanitizedAgentVersion = (agentArg || '10.0.0.0').replace(/[^a-zA-Z0-9._-]/g, '');
const agentLabel = (agentArg || 'universal').replace(/[^a-zA-Z0-9._-]/g, '') || 'universal';
const defaultUserAgent = /^jellyfin-server\//i.test(sanitizedAgentVersion)
    ? sanitizedAgentVersion
    : `Jellyfin-Server/${sanitizedAgentVersion}`;

const WORKER_POOL_SIZE = 4;
let workerPool = [];
let workerQueue = [];
let activeWorkers = 0;

const MANIFEST_WORKER_POOL_SIZE = Math.max(2, Math.min(4, (os.cpus()?.length || 4) - 1));
let manifestWorkerPool = [];
let manifestWorkerQueue = [];
let activeManifestWorkers = 0;

function createLogger(label) {
    const prefix = label ? `[${label}] ` : '';

    return {
        info(message) {
            console.log(`${prefix}${message}`);
        },
        error(message) {
            console.error(`${prefix}${message}`);
        }
    };
}

const logger = createLogger(agentLabel);

function initializeWorkerPool() {
	for (let i = 0; i < WORKER_POOL_SIZE; i++) {
		const worker = new Worker(path.join(__dirname, 'fetch-worker.js'));
		workerPool.push({ worker, busy: false });
	}
}

function terminateWorkerPool() {
	return Promise.all(workerPool.map(({ worker }) => worker.terminate()));
}

function fetchWithWorker(url) {
	return new Promise((resolve, reject) => {
		const task = { url, resolve, reject };
		
		const availableWorker = workerPool.find(w => !w.busy);
		if (availableWorker) {
			executeTask(availableWorker, task);
		} else {
			workerQueue.push(task);
		}
	});
}

function executeTask(workerItem, task) {
	workerItem.busy = true;
	activeWorkers++;
	
	const taskId = Math.random().toString(36);
	
	const onMessage = (message) => {
		if (message.id === taskId) {
			workerItem.worker.removeListener('message', onMessage);
			workerItem.worker.removeListener('error', onError);
			workerItem.busy = false;
			activeWorkers--;
			
			if (message.success) {
				task.resolve({ data: message.data, url: message.url });
			} else {
				task.reject(new Error(message.error));
			}
			
			const nextTask = workerQueue.shift();
			if (nextTask) {
				executeTask(workerItem, nextTask);
			}
		}
	};
	
	const onError = (error) => {
		workerItem.worker.removeListener('message', onMessage);
		workerItem.worker.removeListener('error', onError);
		workerItem.busy = false;
		activeWorkers--;
		task.reject(error);
		
		const nextTask = workerQueue.shift();
		if (nextTask) {
			executeTask(workerItem, nextTask);
		}
	};
	
	workerItem.worker.on('message', onMessage);
	workerItem.worker.on('error', onError);
	workerItem.worker.postMessage({ id: taskId, url: task.url, userAgent: defaultUserAgent });
}

async function waitForAllWorkersComplete() {
	return new Promise((resolve) => {
		const checkCompletion = () => {
			if (activeWorkers === 0 && workerQueue.length === 0) {
				resolve();
			} else {
				setImmediate(checkCompletion);
			}
		};
		checkCompletion();
	});
}

function initializeManifestWorkerPool() {
    for (let i = 0; i < MANIFEST_WORKER_POOL_SIZE; i++) {
        const worker = new Worker(path.join(__dirname, 'manifest-worker.js'));
        manifestWorkerPool.push({ worker, busy: false });
    }
}

function terminateManifestWorkerPool() {
    return Promise.all(manifestWorkerPool.map(({ worker }) => worker.terminate()));
}

function runManifestWorkerTask(taskMessage) {
    return new Promise((resolve, reject) => {
        const task = { taskMessage, resolve, reject };
        const availableWorker = manifestWorkerPool.find((workerItem) => !workerItem.busy);
        if (availableWorker) {
            executeManifestTask(availableWorker, task);
        } else {
            manifestWorkerQueue.push(task);
        }
    });
}

function executeManifestTask(workerItem, task) {
    workerItem.busy = true;
    activeManifestWorkers++;

    const taskId = Math.random().toString(36);

    const onMessage = (message) => {
        if (message.id === taskId) {
            workerItem.worker.removeListener('message', onMessage);
            workerItem.worker.removeListener('error', onError);
            workerItem.busy = false;
            activeManifestWorkers--;

            if (message.success) {
                task.resolve(message.data);
            } else {
                task.reject(new Error(message.error));
            }

            const nextTask = manifestWorkerQueue.shift();
            if (nextTask) {
                executeManifestTask(workerItem, nextTask);
            }
        }
    };

    const onError = (error) => {
        workerItem.worker.removeListener('message', onMessage);
        workerItem.worker.removeListener('error', onError);
        workerItem.busy = false;
        activeManifestWorkers--;
        task.reject(error);

        const nextTask = manifestWorkerQueue.shift();
        if (nextTask) {
            executeManifestTask(workerItem, nextTask);
        }
    };

    workerItem.worker.on('message', onMessage);
    workerItem.worker.on('error', onError);
    workerItem.worker.postMessage({ id: taskId, ...task.taskMessage });
}

async function transformPluginsInWorkers(plugins) {
    if (!plugins.length) {
        return [];
    }

    const workerCount = Math.max(1, Math.min(MANIFEST_WORKER_POOL_SIZE, plugins.length));
    const chunkSize = Math.ceil(plugins.length / workerCount);
    const genTime = new Date().toISOString().substring(11, 16) + ' UTC';
    const tasks = [];

    for (let index = 0; index < plugins.length; index += chunkSize) {
        tasks.push(runManifestWorkerTask({
            operation: 'transform',
            plugins: plugins.slice(index, index + chunkSize),
            genTime
        }));
    }

    const results = await Promise.all(tasks);
    return results.flat();
}

async function stringifyManifestInWorker(data) {
    return runManifestWorkerTask({
        operation: 'stringify',
        data
    });
}

async function getSources(sourceFile){
    let sources = [];
    try {
        const fileContent = await fs.readFile(sourceFile, 'utf8');
        sources = fileContent.split(/\r?\n/).filter(line => line.trim() !== '' && !line.trim().startsWith('#'));
    } catch (err) {
        logger.error(`error reading ${sourceFile}: ${err.message}`);
        return { plugins: [], sourceCount: 0 };
    }

    let plugins = [];
    let collectedPlugins = 0;
    const fetchPromises = sources.map(url => fetchWithWorker(url));
    const results = await Promise.allSettled(fetchPromises);
    await waitForAllWorkersComplete();

    for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const url = sources[i];
        
        if (result.status === 'fulfilled') {
            try {
                let json = result.value.data;
                const pluginList = Array.isArray(json) ? json : (json.plugins || []);
                let added = 0;

                for (const plugin of pluginList) {
                    const guid = plugin.guid || plugin.Guid;
                    if (!guid) {
                        continue;
                    }
                    plugin._metaSourceUrl = url;
                    plugins.push(plugin);
                    added++;
                }

                collectedPlugins += added;
                logger.info(`http requests ${i + 1}/${sources.length} complete (${collectedPlugins} plugins)`);
            } catch (error) {
                logger.error(`error processing ${url}: ${error.message}`);
            }

        } else {
            logger.error(`error fetching ${url}: ${result.reason.message}`);
        }
    }
    
        return {
            plugins: plugins,
        sourceCount: sources.length
    };
}

async function clearImagesFolder() {
    try {
        const entries = await fs.readdir(pluginDir, { withFileTypes: true });
        for (const entry of entries) {
            await fs.rm(path.join(pluginDir, entry.name), { recursive: true, force: true });
        }
    } catch (err) {
        logger.error(`error clearing images folder: ${err.message}`);
    }
}

async function downloadImage(url, filename) {
    try {
        const res = await fetch(url, { headers: { 'User-Agent': defaultUserAgent } });
        if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
        const buffer = await res.arrayBuffer();
        await fs.writeFile(path.join(pluginDir, filename), Buffer.from(buffer));
        return true;
    } catch {
        return false;
    }
}

function getImageExtension(url) {
    const ext = path.extname(new URL(url).pathname);
    return ext || '.png';
}

async function imageExists(filename) {
    try {
        await fs.access(path.join(pluginDir, filename));
        return true;
    } catch {
        return false;
    }
}
function getPluginId(plugin) {
    return plugin.id || plugin.Id || plugin.pluginId || plugin.name || null;
}

function hashString(str) {
    return crypto.createHash('md5').update(str).digest('hex');
}

function sanitizeImageName(name) {
    return String(name).replace(/\s+/g, '');
}

function findGithubUrl(obj) {
    if (!obj) return null;
    for (const key in obj) {
        if (typeof obj[key] === 'string') {
            const match = obj[key].match(/https?:\/\/github\.com\/[^\/]+\/[^\/]+/);
            if (match) {
                return match[0];
            }
        } else if (typeof obj[key] === 'object' && obj[key] !== null) {
            const url = findGithubUrl(obj[key]);
            if (url) return url;
        }
    }
    return null;
}

function sanitizePlugins(plugins) {
    return plugins.map(plugin => {
        const guid = (plugin.guid || plugin.Guid || "").toLowerCase();
        
        if (plugin.versions) {
            plugin.versions.forEach(v => {
                if (v.dependencies) {
                    v.dependencies = v.dependencies.filter(depId => depId.toLowerCase() !== guid);
                }
            });
            plugin.versions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        }
        const descProp = ['description', 'Description', 'overview'].find(p => plugin[p]);
        if (descProp) {
            plugin[descProp] = plugin[descProp]
                .replace(/@\[renovate\[bot\]\].*$/gs, "")
                .replace(/\n\s*\n/g, '\n')
                .trim();
        }
        const { guid: g, name, ...rest } = plugin;
        return { guid: g, name, ...rest };
    });
}

async function processImages(pluginData) {
    logger.info(`processing images for ${pluginData.length} plugins`);

    let downloaded = 0;
    let reused = 0;
    let fallbackCount = 0;
    let renamed = 0;

    for (const plugin of pluginData) {
        if (!plugin.imageUrl) {
            plugin.imageUrl = fallbackImageUrl;
            fallbackCount++;
            continue;
        }

        if (plugin.imageUrl) {
            const ext = getImageExtension(plugin.imageUrl);
            let pluginId = getPluginId(plugin);
            if (!pluginId) {
                pluginId = hashString(plugin.imageUrl);
            }
            const legacyFilename = `${pluginId}${ext}`;
            const filename = `${sanitizeImageName(pluginId)}${ext}`;
            const shouldDownload = regenImages || !(await imageExists(filename));

            if (filename !== legacyFilename && !shouldDownload && await imageExists(legacyFilename)) {
                try {
                    await fs.rename(path.join(pluginDir, legacyFilename), path.join(pluginDir, filename));
                    renamed++;
                } catch (err) {
                    logger.error(`error renaming image ${legacyFilename}: ${err.message}`);
                }
            }

            if (shouldDownload) {
                const success = await downloadImage(plugin.imageUrl, filename);
                if (!success) {
                    plugin.imageUrl = fallbackImageUrl;
                    fallbackCount++;
                    continue;
                }
                downloaded++;
            } else {
                reused++;
            }
            if (shouldDownload || await imageExists(filename)) {
                plugin.imageUrl = imageBaseUrl + filename;
            }
        }
    }

    logger.info(`images complete: downloaded ${downloaded}, reused ${reused}, renamed ${renamed}, fallback ${fallbackCount}`);
}

async function writeManifest(manifestJson, outputFile, pluginCount){
    if (!manifestJson) {
        logger.info(`no data to write to manifest ${outputFile}. aborting.`);
        return;
    }
    try {
        await fs.writeFile(outputFile, manifestJson);
    } catch (err) {
        logger.error(`error writing manifest file ${outputFile}: ${err.message}`);
    }
    logger.info(`manifest written: ${outputFile} (${pluginCount} total plugins)`);
}

async function processList(sourceFile, outputFile) {
    const { plugins: fetchedPlugins, sourceCount } = await getSources(sourceFile);
    let plugins = fetchedPlugins;
    try {
        logger.info(`merging and normalizing ${plugins.length} collected plugins`);
        const safeAgent = 'universal';
        const timestamp = new Date().toISOString();
        const checksum = hashString('upr-' + safeAgent);
        const targetAbi = '10.8.0.0';
        const pluginCount = plugins.length;
        const dummy = {
            guid: crypto.randomUUID ? crypto.randomUUID() : hashString('upr-dummy-' + timestamp),
            name: '! Universal Plugin Repo',
            description: `You are using Universal Plugin Repo. Plugins Aggregated: ${pluginCount}, Number of sources: ${sourceCount}. `,
            overview: `Jellyfin Plugin Aggregator\nGenerated: ${timestamp}`,
            owner: 'Obelous',
            category: 'Miscellaneous',
            image: 'upr-main.png',
            imageUrl: 'https://dl.obelous.dev/public/upr-main.png',
            _metaSourceUrl: 'internal',
            versions: [
                {
                    version: '0.0.0',
                    changelog: 'Placeholder',
                    targetAbi: targetAbi,
                    sourceUrl: 'https://github.com/0belous/Jellyfin-Universal-Catalogue',
                    checksum: checksum,
                    timestamp: timestamp
                }
            ]
        };

        plugins.unshift(dummy);
    } catch (err) {
        logger.error(`error creating dummy plugin: ${err.message}`);
    }

    if (plugins.length > 0) {
        plugins = await transformPluginsInWorkers(plugins);
        logger.info(`merge complete: ${plugins.length} plugins ready for image processing`);
        await processImages(plugins);
        logger.info('serializing manifest payload');
        const manifestJson = await stringifyManifestInWorker(plugins);
        await writeManifest(manifestJson, outputFile, plugins.length);
    }
}

async function main() {
    try{await fs.mkdir('./plugins/')}catch(err){}
    try{await fs.mkdir(pluginDir, { recursive: true })}catch(err){}
    
    initializeWorkerPool();
    initializeManifestWorkerPool();
    
    try {
        if(regenImages)await clearImagesFolder();
        const safeAgent = agentArg ? agentArg.replace(/[^a-zA-Z0-9._-]/g, '') : 'universal';
        const outputFile = path.join('./plugins', `manifest.${safeAgent}.json`);
        await processList('sources.txt', outputFile);
    } finally {
        await terminateWorkerPool();
        await terminateManifestWorkerPool();
    }
}

main();
