# music.localhost

Bun app that imitates the Apple Music fullscreen view on Macs using React, [mediaremote-adapter](https://github.com/ungive/mediaremote-adapter), and [LRCLIB](https://lrclib.net). Tiny WebSocket server and a (mostly vibeslopped) frontend.

I'll take PRs but would recommend you don't touch this codebase. It's hellish.

![demo](demo.jpeg)

## YouTube Music support

To use this app with YouTube Music, install `music.localhost.user.js`. Make sure the app is served `music.localhost`, using the [Caddyfile](./Caddyfile) or otherwise. YouTube Music's Now Playing state is still exposed and usable in the app without the userscript, but Chromium limitations only publish low-quality thumbnails from the media session API. The userscript bypasses this, giving the server a special path to upgrade artwork images to the high-res versions when possible.