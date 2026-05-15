# music.localhost

Bun app that imitates the Apple Music fullscreen view on Macs using React, [mediaremote-adapter](https://github.com/ungive/mediaremote-adapter), and [LRCLIB](https://lrclib.net). Tiny WebSocket server and a (mostly vibeslopped) frontend.

I'll take PRs but would recommend you don't touch this codebase. It's hellish.

![demo](demo.jpeg)

## YouTube Music support

This app can also accept high-resolution artwork relayed from YouTube Music.

To use it, install/enable `music.localhost.user.js` in a browser on `https://music.youtube.com/*`. Also make sure `music.localhost` is being served locally (or through the project's local HTTPS setup) so the script can POST to `https://music.localhost/api/ytm-artwork`.

The userscript will upgrade artwork URLs when it can, then relay the metadata/artwork to the server.