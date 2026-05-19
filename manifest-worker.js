const { parentPort } = require('worker_threads');

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
    return plugins.map((plugin) => {
        const resolvedGuid = (plugin.guid || plugin.Guid || '').toLowerCase();
        const { guid, Guid, name, ...rest } = plugin;

        if (plugin.versions) {
            plugin.versions.forEach((version) => {
                if (version.dependencies) {
                    version.dependencies = version.dependencies.filter((depId) => depId.toLowerCase() !== resolvedGuid);
                }
                if (!version.targetAbi || version.targetAbi.trim() === '') {
                    version.targetAbi = '10.11.0.0';
                }
            });
            plugin.versions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        }

        const descProp = ['description', 'Description', 'overview'].find((prop) => plugin[prop]);
        if (descProp) {
            plugin[descProp] = plugin[descProp]
                .replace(/@\[renovate\[bot\]\].*$/gs, '')
                .replace(/\n\s*\n/g, '\n')
                .trim();
        }
        return { guid: resolvedGuid, name, ...rest };
    });
}

function processDescriptions(pluginData, genTime) {
	for (const plugin of pluginData) {
		const repoUrl = findGithubUrl(plugin);
		const sourceUrl = plugin._metaSourceUrl || 'Unknown';
		let appendText = `  \n  \nUniversal Repo:  \nGenerated: ${genTime}  \nSource: ${sourceUrl}`;
		delete plugin._metaSourceUrl;
		if (repoUrl) {
			appendText += `  \nGithub: ${repoUrl}`;
		}

		const descriptionProp = ['description', 'Description', 'overview'].find((prop) => plugin[prop]);

		if (descriptionProp) {
			if (!plugin[descriptionProp].includes('Universal Repo:')) {
				plugin[descriptionProp] += appendText;
			}
		} else {
			plugin.description = appendText.trim();
		}
	}

	return pluginData;
}

function transformPlugins(plugins, genTime) {
	return processDescriptions(sanitizePlugins(plugins), genTime);
}

parentPort.on('message', async (message) => {
	const { id, operation } = message;

	try {
		if (operation === 'transform') {
			const data = transformPlugins(message.plugins || [], message.genTime || new Date().toISOString().substring(11, 16) + ' UTC');
			parentPort.postMessage({ id, success: true, data });
			return;
		}

		if (operation === 'stringify') {
			const data = JSON.stringify(message.data ?? [], null, 2);
			parentPort.postMessage({ id, success: true, data });
			return;
		}

		throw new Error(`Unknown operation: ${operation}`);
	} catch (error) {
		parentPort.postMessage({
			id,
			success: false,
			error: error.message
		});
	}
});