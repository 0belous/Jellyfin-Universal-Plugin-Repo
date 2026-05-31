# Jellyfin Universal Catalogue

The universal plugin repository for **Jellyfin Media Server**. This project aggregates plugin feeds, de-duplicates entries, normalizes assets, and publishes a single catalogue URL that is easier for end users to install and maintain.

## Why this repo exists
Managing multiple Jellyfin plugin repositories can get messy fast. This project provides:
- **one primary catalogue URL** for plugins
- automatic feed updates and duplicate merging
- a simpler setup flow for self-hosted Jellyfin users

## Manifest URL
```text
https://obelo.us/upr
```

## Installation
1. Open the Jellyfin admin dashboard.
2. Go to the plugin or catalogue repository settings.
3. Remove outdated repository entries if you previously added multiple plugin feeds.
4. Add the main catalogue URL shown above.
5. Save the configuration and refresh your available plugins.

## How this project is maintained
The update pipeline is driven by `update.js`.

It does the following:
- reads source repository lists from `sources.txt`
- fetches upstream plugin JSON feeds
- downloads and refreshes image assets
- outputs normalized manifests for Jellyfin clients

## Project structure
```text
.
├── README.md           # Project overview and setup instructions
├── update.js           # Aggregation and manifest generation script
├── index.js            # Serves generated manifests and images
├── sources.txt         # Upstream plugin feed list
├── manifest.json       # Generated main catalogue manifest
└── images/             # Downloaded plugin artwork/assets
```

## Security notes
Most upstream sources come from reputable community-maintained Jellyfin plugin repositories, including entries referenced from [awesome-jellyfin](https://github.com/awesome-jellyfin/awesome-jellyfin).

A few practical notes:
- this project helps reduce direct exposure to many separate repository endpoints
- new sources are reviewed before inclusion
- installing a plugin still means trusting that plugin's code
- users should continue to install only plugins they recognize or have reviewed

## Contributing
If you want to add a missing plugin source:
1. update `sources.txt`
2. regenerate the manifests with `node update.js`
3. open a pull request with the new source and any context maintainers should know

## Star history
<a href="https://www.star-history.com/?repos=0belous%2FJellyfin-Universal-Catalogue&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" style="max-height:300px;" srcset="https://api.star-history.com/chart?repos=0belous/Jellyfin-Universal-Catalogue&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" style="max-height:300px;" srcset="https://api.star-history.com/chart?repos=0belous/Jellyfin-Universal-Catalogue&type=date&legend=top-left" />
   <img alt="Star History Chart" style="max-height:300px;" src="https://api.star-history.com/chart?repos=0belous/Jellyfin-Universal-Catalogue&type=date&legend=top-left" />
 </picture>
</a>
