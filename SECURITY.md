# Security policy

## Reporting a problem

Report security problems privately through [GitHub's private vulnerability reporting](https://github.com/Kaos599/Maglev/security/advisories/new). Do not open a public issue, and do not post details in discussions or pull requests until a fix is released.

Useful things to include:

- The Maglev version (Settings → About) and your Android version.
- What an attacker can do, and what they need first (a malicious web page, a crafted torrent or magnet link, a shared link, another app on the phone, the same Wi-Fi network).
- Steps to reproduce, or a proof of concept.

You will get a reply within 7 days. Once the problem is confirmed, the fix ships in the next release, and the advisory is published with credit to you unless you ask not to be named.

## Supported versions

Only the latest release gets security fixes. Maglev updates in place, so update first and check the problem still happens.

## What counts

Examples of what to report:

- A web page, link or torrent that can read or write files outside the download folder.
- A way for another app, or a device on the network, to control downloads, reach the streaming server, or read the browser's cookies.
- Cookies, passwords or private links ending up in places they should not: logs, the debug log export, notifications, backups or other apps.
- Private browsing keeping history, cookies or cache after you leave the browser.
- Maglev sending data anywhere you did not ask it to.

Not security problems (open a normal issue):

- Your IP address being visible to torrent peers. That is how BitTorrent works; use a VPN and the VPN-only setting.
- A site blocking downloads, or a search source returning bad results.
- Crashes that need physical access to an unlocked phone.
