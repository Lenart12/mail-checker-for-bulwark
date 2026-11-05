<img src="src/icon.png" alt="" width="96" height="96" align="right">

# Mail Checker for Bulwark

[![Tests](https://github.com/Lenart12/mail-checker-for-bulwark/actions/workflows/test.yml/badge.svg)](https://github.com/Lenart12/mail-checker-for-bulwark/actions/workflows/test.yml)
[![Latest release](https://img.shields.io/github/v/release/Lenart12/mail-checker-for-bulwark)](https://github.com/Lenart12/mail-checker-for-bulwark/releases/latest)
[![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-blue)](LICENSE)
![Tested with Bulwark 1.20.0](https://img.shields.io/badge/tested%20with-Bulwark%201.20.0-informational)

New mail notifications and a quick mail overlay for [Bulwark](https://github.com/bulwarkmail/webmail) webmail, for Firefox and Chromium browsers. Unofficial: not made by the Bulwark project.

- Desktop notification, sound and a wiggling toolbar icon when new mail reaches your Inbox, while the browser is open
- Unread count on the toolbar icon, which goes grey when there's nothing unread or you aren't connected. Other badges: `…` connecting, `!` can't reach your mail, `?` not logged in
- Click the icon to read mail in an overlay, using Bulwark's own interface
- Right-click the icon to open mail, start a new message, check for mail, mark the Inbox as read, or open settings
- Uses your Bulwark server's icon, sounds and notification settings

## Install

Download the file for your browser from [Releases](https://github.com/Lenart12/mail-checker-for-bulwark/releases).

- **Chromium browsers:** unzip the `.zip`. At `chrome://extensions`, turn on developer mode, click **Load Unpacked** and pick the unzipped folder. It doesn't update by itself.
- **Firefox-based browsers:** at `about:addons`, click the gear icon, choose **Install Add-on From File** and pick the `.xpi`. It's signed by Mozilla and updates itself.

## Setup

1. Log in to Bulwark in your browser.
2. Enter your Bulwark address when the extension asks.

Accounts come from whatever you're logged in to, and several accounts work at once. It needs the full edition of Bulwark; Lite isn't supported. To change the address later, right-click the icon and choose **Settings**, or open the extension's preferences in your browser's extension manager.

## Options

- **Desktop notifications:** sender, subject and preview; sender and subject; just "New mail"; or off
- **Overlay size:** one pane (599px) or a wider layout (800px)
- **Clicking the icon:** opens the overlay, or Bulwark in a tab
- **Icon wiggle:** on or off. It also stays still if your system asks for reduced motion
- **Sound volume:** for sounds the extension plays. An open Bulwark tab that can play the sound uses its own volume

Each account also has its own rules, which appear once you're logged in:

- **Notify:** always, when not muted (the default), or never. This covers the notification, sound and wiggle
- **Badge count:** always (the default), when not muted, or never

"When not muted" follows the mutes set in Bulwark. For notifications, it also follows Do Not Disturb and whether notifications are on in Bulwark, and **always** ignores all of these. **Never** can't silence an open Bulwark tab, which still follows Bulwark's own settings.

Which sound plays is set in Bulwark, per account. Bulwark's beep plays as its Involved sound.

## Getting two notifications for each email?

The extension sends its own notifications, separately from Bulwark. If you've also turned on push notifications in Bulwark's settings, you'll get one from each, so turn off Bulwark's.

## Privacy and security

- The extension only talks to your Bulwark server and the mail server it uses, and collects nothing. It asks for permission for your Bulwark host only.
- Your password and tokens stay in a hidden frame on your Bulwark address, in memory. The extension saves only your account names, its settings and your server's icon.
- To show Bulwark in the overlay, the extension removes `Content-Security-Policy` and `X-Frame-Options` from the Bulwark pages it opens itself. Normal Bulwark tabs keep them. HTML mail is still sanitized and sandboxed by Bulwark, but the overlay loses CSP as an outer layer of protection.
- An `http://` address sends your password and mail unencrypted. The settings page warns about this.

## Limits

- It relies on internal Bulwark details, so a Bulwark update can break it. Tested with Bulwark 1.20.0.
- Bulwark plugins that use their own frames won't load in the overlay.
- With Bulwark's Offline mode on, mail can't show in the overlay, because the browser won't frame the pages it saves. The overlay offers **Open in a tab** instead.
- There are no alerts for mail that arrived while the browser was closed, though the unread count includes it.

## Development

```bash
node test/test.js
```

```bash
./build.sh
```

`build.sh` writes both builds and a zip for each to `dist/`.

`test/test.js` checks the logic in Node against a fake server. After building, `python3 test/test-firefox.py oauth` (or `basic`) runs the add-on in a headless Firefox against a fake server, which catches Firefox's content script rules that Node can't. It fails if the add-on doesn't connect and alert.

To try a build by hand, follow [Install](#install), using `dist/mail-checker-firefox.zip` or the `dist/chrome` folder.

## Releasing

Versions follow [Semantic Versioning](https://semver.org). To release, run this on a clean `main`, using the new version number:

```bash
./release.sh 0.2.0
```

```bash
git push --follow-tags
```

Pushing the tag runs the tests, builds both browsers, has Mozilla sign the Firefox add-on as unlisted, and publishes the results as a GitHub release. Installed Firefox add-ons find the new version through the release's `updates.json`.

Signing needs Mozilla [API keys](https://addons.mozilla.org/developers/addon/api/key/), saved as the repository secrets `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET`.

If signing fails or Mozilla takes longer than an hour, the workflow stops and publishes nothing. Mozilla won't accept the same version twice, so a rerun can fail once the version has been uploaded. In that case, release the next version number.

## AI disclosure

This project was written with substantial help from an AI coding assistant, under human direction. A person chose the design and features, and tested them by hand in Firefox-based and Chromium browsers, but much of the code hasn't been written or reviewed line by line by a person. Please review it with that in mind, and report any problems you find.

## License

Copyright (C) 2026 Lenart Kos

[GNU Affero General Public License v3.0 only](LICENSE).
