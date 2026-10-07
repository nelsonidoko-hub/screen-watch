const { app, BrowserWindow, ipcMain, desktopCapturer, screen } = require('electron');
const path = require('path');
const { mouse, keyboard, Button, Key, Point } = require('@nut-tree-fork/nut-js');

// Make mouse moves land instantly instead of animating - important for
// keeping up with a live stream of coordinates coming over the data channel.
mouse.config.autoDelayMs = 0;
keyboard.config.autoDelayMs = 0;

// v2: remote control is off by default. The agent (the person being
// watched) must explicitly tick "Allow remote control" in the app window
// before any injected input is allowed to actually move the mouse or type.
// This is a deliberate safety gate, not just a UI nicety - the viewer
// cannot turn this on themselves.
let controlEnabled = false;

// Maps a browser KeyboardEvent.key value to nut-js's Key enum. Only the
// keys someone would realistically need for basic remote control are
// covered here; anything unmapped is silently ignored rather than crashing.
const KEY_MAP = {
  a: Key.A, b: Key.B, c: Key.C, d: Key.D, e: Key.E, f: Key.F, g: Key.G,
  h: Key.H, i: Key.I, j: Key.J, k: Key.K, l: Key.L, m: Key.M, n: Key.N,
  o: Key.O, p: Key.P, q: Key.Q, r: Key.R, s: Key.S, t: Key.T, u: Key.U,
  v: Key.V, w: Key.W, x: Key.X, y: Key.Y, z: Key.Z,
  '0': Key.Num0, '1': Key.Num1, '2': Key.Num2, '3': Key.Num3, '4': Key.Num4,
  '5': Key.Num5, '6': Key.Num6, '7': Key.Num7, '8': Key.Num8, '9': Key.Num9,
  ' ': Key.Space, Enter: Key.Enter, Backspace: Key.Backspace, Tab: Key.Tab,
  Escape: Key.Escape, Delete: Key.Delete, Home: Key.Home, End: Key.End,
  PageUp: Key.PageUp, PageDown: Key.PageDown,
  ArrowUp: Key.Up, ArrowDown: Key.Down, ArrowLeft: Key.Left, ArrowRight: Key.Right,
  Shift: Key.LeftShift, Control: Key.LeftControl, Alt: Key.LeftAlt, Meta: Key.LeftSuper,
  F1: Key.F1, F2: Key.F2, F3: Key.F3, F4: Key.F4, F5: Key.F5, F6: Key.F6,
  F7: Key.F7, F8: Key.F8, F9: Key.F9, F10: Key.F10, F11: Key.F11, F12: Key.F12,
  '-': Key.Minus, '=': Key.Equal, '[': Key.LeftBracket, ']': Key.RightBracket,
  ';': Key.Semicolon, "'": Key.Quote, ',': Key.Comma, '.': Key.Period, '/': Key.Slash,
  '`': Key.Grave, '\\': Key.Backslash,
};

function mapKey(key) {
  if (typeof key !== 'string') return null;
  return KEY_MAP[key] || KEY_MAP[key.toLowerCase()] || null;
}

// ---- Invite links ----
// The viewer sends the person a link that opens this app:
//   screenwatch://join?t=<token>&n=<name>
// Nothing happens automatically: the link only fills in the consent prompt.
// Screen capture starts only after the person clicks "Share my screen".
const PROTOCOL = 'screenwatch';
let mainWindow = null;
let pendingInvite = null;

function parseInvite(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== PROTOCOL + ':' || u.hostname !== 'join') return null;
    const token = u.searchParams.get('t') || '';
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
    // The name is typed by whoever made the invite - plain text only, short.
    const name = (u.searchParams.get('n') || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 40);
    return { token, name };
  } catch (e) {
    return null;
  }
}

function deliverInvite(invite) {
  if (!invite) return;
  pendingInvite = invite;
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    if (!mainWindow.webContents.isLoading()) {
      mainWindow.webContents.send('invite', invite);
      pendingInvite = null;
    }
  }
}

function findInviteArg(argv) {
  return (argv || []).find((a) => typeof a === 'string' && a.startsWith(PROTOCOL + '://'));
}

ipcMain.handle('take-pending-invite', () => {
  const invite = pendingInvite;
  pendingInvite = null;
  return invite;
});

// Register this app as the handler for screenwatch:// links.
if (process.defaultApp && process.argv.length >= 2) {
  app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

// Only one copy of the app: a second launch (from clicking a link) hands its
// link to the first one and exits.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (event, argv) => deliverInvite(parseInvite(findInviteArg(argv))));
  app.on('open-url', (event, url) => { // macOS
    event.preventDefault();
    deliverInvite(parseInvite(url));
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 540,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The renderer enforces session expiry with timers. Without this,
      // Chromium slows timers in a minimized/hidden window, which could let
      // an expired session linger for up to a minute.
      backgroundThrottling: false,
    },
  });

  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.loadFile('renderer.html');
}

// The renderer can't call desktopCapturer directly (it's main-process only),
// so we expose it through IPC via preload.js.
ipcMain.handle('get-screen-sources', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen'] });
  return sources.map((s) => ({ id: s.id, name: s.name }));
});

ipcMain.handle('get-screen-size', () => {
  const { width, height } = screen.getPrimaryDisplay().size;
  return { width, height };
});

ipcMain.handle('set-control-enabled', (event, enabled) => {
  controlEnabled = !!enabled;
  return controlEnabled;
});

// v2: apply an input event (mouse move/click/scroll or key press) that came
// in over the WebRTC data channel from the viewer. Coordinates arrive
// normalized (0 to 1) rather than in raw pixels, so this works regardless
// of how big the viewer's video element is on their end - we just multiply
// by *this* machine's actual screen resolution.
ipcMain.handle('inject-input', async (event, input) => {
  if (!controlEnabled || !input || typeof input.type !== 'string') return;

  try {
    switch (input.type) {
      case 'move': {
        const { width, height } = screen.getPrimaryDisplay().size;
        const x = Math.round(Math.min(1, Math.max(0, input.x)) * width);
        const y = Math.round(Math.min(1, Math.max(0, input.y)) * height);
        await mouse.setPosition(new Point(x, y));
        break;
      }
      case 'mousedown':
        await mouse.pressButton(input.button === 2 ? Button.RIGHT : Button.LEFT);
        break;
      case 'mouseup':
        await mouse.releaseButton(input.button === 2 ? Button.RIGHT : Button.LEFT);
        break;
      case 'scroll': {
        const amount = Math.round(Math.abs(input.deltaY || 0)) || 1;
        if ((input.deltaY || 0) > 0) await mouse.scrollDown(amount);
        else if ((input.deltaY || 0) < 0) await mouse.scrollUp(amount);
        break;
      }
      case 'keydown': {
        const mapped = mapKey(input.key);
        if (mapped !== null) await keyboard.pressKey(mapped);
        break;
      }
      case 'keyup': {
        const mapped = mapKey(input.key);
        if (mapped !== null) await keyboard.releaseKey(mapped);
        break;
      }
      default:
        break;
    }
  } catch (e) {
    console.error('Failed to inject input:', e);
  }
});

app.whenReady().then(() => {
  // Cold start from a link (Windows/Linux put it in argv).
  pendingInvite = pendingInvite || parseInvite(findInviteArg(process.argv));
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});
