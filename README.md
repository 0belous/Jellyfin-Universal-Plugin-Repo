# Jellyfin Universal Plugin Repository

Jellyfin Universal Repository combines plugin manifests from multiple repositories and serves a manifest for Jellyfin clients.

## Add the catalogue to Jellyfin

Add this URL as a plugin repository in the Jellyfin administrator dashboard:

```text
https://obelo.us/upr
```

To add the repository:

1. Sign in to the Jellyfin administrator dashboard.
2. Open **Dashboard > Plugins > Repositories**.
3. Remove an older Universal Plugin Repo URL, if you added one.
4. Add `https://obelo.us/upr` as the repository URL.
5. Save the repository and refresh the plugin catalogue.

The old GitHub-hosted manifest is deprecated. See [deprecation.md](deprecation.md) for details.

## Jellyfin 12 compatibility

The catalogue includes a badge for plugins with an exact Jellyfin 12 ABI.

Check a plugin's supported ABI before installing it. A plugin that does not provide a compatible version might not work with your Jellyfin server.

## How the catalogue works

The service performs these steps:

1. Reads manifest sources from [`sources.txt`](sources.txt).
2. Fetches the upstream JSON manifests.
3. Filters sources and plugin versions for the requesting Jellyfin version.
4. Normalizes plugin metadata and removes self-dependencies.
5. Downloads and normalizes plugin images.
6. Writes a manifest for the requesting Jellyfin user agent.
7. Serves the manifest from `/upr`.

The server stores generated files in the `plugins` directory. It refreshes known user-agent manifests hourly and removes agents that have not been seen for about one month.

## Run the service locally

### Install dependencies

```bash
npm install
```

### Start the server

```bash
npm start
```

By default, the server listens on `0.0.0.0:3000`. Set these environment variables to change the listener:

```bash
HOST=127.0.0.1 PORT=3000 npm start
```

## Generate a manifest

Run the update script from the repository root:

```bash
node update.js
```

This writes a manifest for the `universal` agent to `plugins/manifest.universal.json`. To generate a manifest for a specific Jellyfin server version, pass `false` and the version as arguments:

```bash
node update.js false 10.11.0.0
```

To remove existing images and download them again, pass `true` instead:

```bash
node update.js true 10.11.0.0
```

The update script uses the third field in each `sources.txt` entry to select compatible sources. Use `*.*` for all versions or a comma-separated list for specific versions.

## Add a plugin source

Each source entry uses this format:

```text
manifest URL | repository URL | Jellyfin version constraint
```

For example:

```text
https://example.com/manifest.json | https://github.com/example/plugin | 10.11,12.0
```

When you add a source:

1. Add the entry to [`sources.txt`](sources.txt) in alphabetical order.
2. Run `node update.js` to check that the source can be fetched and processed.
3. Review the generated files and open a pull request.

## Security

This project distributes metadata and download information from third-party plugin repositories. Installing a plugin means trusting the plugin author and the code they publish.

Review a plugin's source repository before installing it. Adding a repository to this catalogue does not make the plugin safe or imply that the project has audited its code.

## Repository layout

- [`index.js`](index.js): starts the HTTP server and serves manifests and images.
- [`update.js`](update.js): fetches sources and generates manifests.
- [`fetch-worker.js`](fetch-worker.js): fetches upstream manifests in worker threads.
- [`manifest-worker.js`](manifest-worker.js): transforms and serializes manifest data.
- [`sources.txt`](sources.txt): lists upstream manifest sources and version constraints.
- [`plugins/`](plugins/): contains generated manifests and image assets.
