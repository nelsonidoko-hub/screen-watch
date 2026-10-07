# ScreenWatch v1

A minimal "watch someone's screen remotely" tool. No remote control yet —
that's a deliberate v2 step, not a v1 feature.

## How it works (plain English)

The person who WATCHES creates an invite. The person who SHARES clicks it.

1. `viewer` is a web page. The watcher opens it, types their name, and clicks
   **Create invite**. They send the link it produces to the person to watch.
2. The link opens a small page (`join.html`) that launches the ScreenWatch
   app on the sharer's computer, or points them to download it first.
3. `agent` is an Electron desktop app. It shows who is asking and two buttons:
   **Share my screen** or **Share and let them control my mouse & keyboard**.
   **Nothing is captured or sent anywhere until they click one of them.**
4. `signaling-server` is a small Node app whose only job is introductions. It
   creates the one-time invite token and passes tiny setup messages between
   the two sides. It never sees the screen. Video flows directly between them.

## Run it locally (3 terminals)

### 1. Start the signaling server
```bash
cd signaling-server
npm install
npm start
```

### 2. Serve the viewer
```bash
cd viewer
npm start
```
Open `http://localhost:3000`. (For invites to work from other computers, the
viewer must be hosted at an address they can reach, and you open it from there.)

### 3. Start the agent
```bash
cd agent
npm install
npm start
```
The window says "Waiting for an invite". In the viewer, click **Create invite**,
copy the link and open it in a browser. It tries to open the app (while testing
via `npm start` the `screenwatch://` link handler may not be registered - if
nothing happens, install a packaged build, see Packaging below). Click
**Share my screen** and the viewer shows the screen within a couple seconds.

## Invites & expiry

Each session uses a random 192-bit token that the **server** creates when the
viewer clicks Create invite. The viewer page wraps it as
`<viewer-url>/join.html#t=<token>&n=<name>`.

- **Token after the `#`.** Browsers never send the fragment to a server, so it
  stays out of web-server logs and `Referer` headers.
- **Consent first.** The agent connects to the server only after the sharer
  clicks a Share button, and never captures the screen before that.
- **Control is a separate, revocable choice.** Only the second button turns
  remote control on, and the checkbox in the sharing window switches it off at
  any time. It is switched off whenever a session ends.
- **Single use.** The first agent to accept claims the session. A reused link
  is refused.
- **Expiry** (env vars on the signaling server):

  | Rule | Default | Env var |
  |---|---|---|
  | Invite must be accepted within | 30 min | `JOIN_WINDOW_MS` |
  | Hard cap on session length | 60 min | `MAX_SESSION_MS` |

- **Keep the viewer page open.** The invite only lives while the watcher's
  page is open; closing it ends the session. Either side leaving ends it for both.
- **Enforced in two places.** Once WebRTC connects the server can't cut the
  stream, so the agent keeps its own countdown and, at expiry, closes the
  connection, stops capture and switches remote control off. The server sends
  durations (not timestamps) so clock differences don't matter.
- The name on the consent screen is typed by whoever made the invite, so it
  proves nothing. The sharer should only click Share for someone they know.

## Known limitations (on purpose, for v1)

- **No TURN server** — only works when both machines can reach each other
  directly. If you test across different networks (e.g. home wifi to
  mobile data) and it doesn't connect, that's why. Adding a TURN server
  is the fix, and it's a config change, not a rewrite.
- **One viewer per session code** — fine for v1, easy to extend later.
- **The link is the only credential** — see "Invites & expiry" above.
  Still no rate limiting or per-session TURN credentials.

## v2: Remote control (mouse & keyboard)

Screen viewing now has an optional remote control layer on top:

1. On the **agent**, tick "Allow remote control" — this is off by default
   and is the only thing that actually grants control. Nothing the viewer
   does can turn this on remotely.
2. On the **viewer**, once connected, click on the video first (so it has
   keyboard focus), then tick "Take control". Mouse moves, clicks, scroll,
   and typing now go to the agent's machine.
3. Uncheck "Take control" (or just don't check it) to go back to
   watch-only.

### How it works
- The agent creates a WebRTC **data channel** alongside the existing video
  stream, used only for small input-event messages (never screen data).
- The viewer sends mouse position as **normalized coordinates** (0 to 1,
  relative to the video element's size), not raw pixels — the agent then
  multiplies by its own actual screen resolution. This is what makes it
  work correctly no matter how big or small the video looks on the
  viewer's screen.
- Actual mouse/keyboard injection on the agent's machine uses
  `@nut-tree-fork/nut-js`, which needs a small native binary — like
  Electron, its first `npm install` in the `agent` folder may take a
  while and print similar-looking warnings. That's normal.

### Known limitations (on purpose, for v2)
- **No visual cursor feedback** — the viewer doesn't see a cursor icon
  tracking their mouse on the video; only the agent's actual system
  cursor moves. Fine for v2, worth revisiting later.
- **Basic key coverage only** — letters, numbers, common punctuation,
  arrows, and standard modifier/navigation keys are mapped. Obscure keys
  (numpad, media keys, non-US layouts) are silently ignored rather than
  crashing.
- **No indication to the agent of what's being typed/clicked in
  real time beyond the checkbox state** — there's no "viewer is now
  controlling" banner. Worth adding before giving this to anyone else.
- **Still no TURN server** — remote control inherits the same
  same-network-only limitation as v1's video.

## Next steps once this works

1. Get it running end-to-end on your own machine first.
2. Test agent and viewer on two different machines on the same wifi.
3. Add a TURN server so it works across different networks.
4. Package it as an installable app for others, harden security
   (rate limiting, short-lived TURN credentials, clearer control indicators).

## Packaging the agent as an installer

Before shipping, set `DOWNLOAD_URL` in `viewer/join.html` to where you host the
installers (e.g. your GitHub Releases page).

```bash
cd agent
npm install
npm run dist:win     # on Windows  -> dist/ScreenWatch Agent Setup x.y.z.exe
npm run dist:mac     # on macOS    -> dist/*.dmg (Intel + Apple Silicon)
npm run dist:linux   # on Linux    -> dist/*.AppImage and *.deb
npm run pack         # quick unpacked build for testing
```

Each installer must be built on its own OS (the native mouse/keyboard library
differs per platform). To build all three without owning all three machines,
push the project to GitHub and run the **Build agent installers** workflow
(`.github/workflows/build-agent.yml`); download the results from the run's artifacts.

Before shipping, edit `author`/`maintainer` email in `agent/package.json`, and
optionally add `agent/build/icon.png` (512x512) for a custom app icon.

### Invite links and the installer
The installers register the `screenwatch://` link type (Windows at install time,
macOS via the app bundle, Linux via the `.deb`), so the first invite link works
right after installing. The Linux AppImage doesn't register link types by
itself - use the `.deb` for invite links.

### Per-OS notes
- **Windows:** unsigned installers trigger SmartScreen ("Windows protected your PC" →
  More info → Run anyway). A code-signing certificate removes this.
- **macOS:** unsigned apps are blocked by Gatekeeper; distributing to others needs an
  Apple Developer account for signing and notarization. Users must grant **Screen
  Recording** and **Accessibility** (System Settings → Privacy & Security).
- **Linux:** screen capture and remote control work on X11. On Wayland, capture goes
  through a system prompt and mouse/keyboard injection generally does not work.
