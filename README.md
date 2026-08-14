# Jellyfin Universal Catalogue

The universal plugin repository for **Jellyfin Media Server**.

## Why this repo exists
Managing multiple Jellyfin plugin repositories can get messy fast. This project provides:
- **one universal catalogue URL** for plugins
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

## Ready for Jellyfin 12
Look for the <img src="https://github.com/0belous/Jellyfin-Universal-Plugin-Repo/blob/main/assets/12badge.png?raw=true" style="width:20px; transform:translate(0px,5px); margin-left:2px; margin-right:2px;"> symbol to find plugins explicitly marked as compatible with jellyfin version 12<br>
Older plugins may still work, but most plugins will break due to sweeping API changes.

## How this project is maintained
The update pipeline is driven by `update.js`.

It does the following:
- reads source repository lists from `sources.txt`
- fetches upstream plugin JSON feeds
- downloads and converts image assets
- outputs manifest to be served by `index.js` for jellyfin clients

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
3. open a pull request with your changes

## Star history
<a href="https://www.star-history.com/?repos=0belous%2FJellyfin-Universal-Catalogue&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=0belous/Jellyfin-Universal-Catalogue&type=date&theme=dark&legend=top-left&sealed_token=TihnkVXJsM47qRbiulumvHT2vk21i75_fysAohZQHwQZOQB0Jc31huqgOQasKeBlc4jh3HT4tQgKHnFOVuf-5i92xQi1JcoPhrXbQsS7G9GHS9mGPjhPAT26Pm17bWAVq3YAl5YTMHeV2REbokWWSUXO57GDPsuJOezbHGiSwdhqY5txbiXd6FcHXxu-" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=0belous/Jellyfin-Universal-Catalogue&type=date&legend=top-left&sealed_token=TihnkVXJsM47qRbiulumvHT2vk21i75_fysAohZQHwQZOQB0Jc31huqgOQasKeBlc4jh3HT4tQgKHnFOVuf-5i92xQi1JcoPhrXbQsS7G9GHS9mGPjhPAT26Pm17bWAVq3YAl5YTMHeV2REbokWWSUXO57GDPsuJOezbHGiSwdhqY5txbiXd6FcHXxu-" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=0belous/Jellyfin-Universal-Catalogue&type=date&legend=top-left&sealed_token=TihnkVXJsM47qRbiulumvHT2vk21i75_fysAohZQHwQZOQB0Jc31huqgOQasKeBlc4jh3HT4tQgKHnFOVuf-5i92xQi1JcoPhrXbQsS7G9GHS9mGPjhPAT26Pm17bWAVq3YAl5YTMHeV2REbokWWSUXO57GDPsuJOezbHGiSwdhqY5txbiXd6FcHXxu-" />
 </picture>
</a>
