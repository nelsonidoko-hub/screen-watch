// ---- Config ----
// Point this at wherever you run signaling-server/server.js.
// For local testing, that's ws://localhost:8080.
//
// This is now pointed at a permanent, always-on signaling server hosted
// on Render (free tier) instead of localhost or a temporary ngrok tunnel.
// Note: Render's free tier sleeps after 15 minutes of no traffic and takes
// about a minute to wake back up on the next connection - if a demo seems
// stuck right at the start, that's just it waking up, not a real failure.
// const SIGNALING_SERVER_URL = 'wss://screen-watch-329x.onrender.com';
// const SIGNALING_SERVER_URL = 'ws://localhost:8080';
const SIGNALING_SERVER_URL = 'wss://screen-watch-ppfp.onrender.com';

// Public STUN server so peers can discover their public IP/port, plus a
// TURN server (Open Relay / metered.ca free tier) that relays traffic when
// a direct peer-to-peer connection can't be made - e.g. two different
// networks/ISPs, like testing with someone in another location. This is
// what makes it possible to demo across the internet, not just same-wifi.
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.relay.metered.ca:80' },
    {
      urls: 'turn:global.relay.metered.ca:80',
      username: '234992c5d334d66ead5e8023',
      credential: '8Zx3iuliVqargFnI',
    },
    {
      urls: 'turn:global.relay.metered.ca:80?transport=tcp',
      username: '234992c5d334d66ead5e8023',
      credential: '8Zx3iuliVqargFnI',
    },
    {
      urls: 'turn:global.relay.metered.ca:443',
      username: '234992c5d334d66ead5e8023',
      credential: '8Zx3iuliVqargFnI',
    },
    {
      urls: 'turns:global.relay.metered.ca:443?transport=tcp',
      username: '234992c5d334d66ead5e8023',
      credential: '8Zx3iuliVqargFnI',
    },
  ],
};

const END_MESSAGES = {
  expired: 'Session reached its maximum length and was ended.',
  'join-window-expired': 'This invite expired. Ask for a new link.',
  'viewer-left': 'The viewer disconnected. Sharing stopped.',
};

const ERROR_MESSAGES = {
  invalid: 'This invite is invalid or has expired. Ask for a new link.',
  'in-use': 'This invite was already used. Ask for a new link.',
};

const views = {
  idle: document.getElementById('idleView'),
  consent: document.getElementById('consentView'),
  sharing: document.getElementById('sharingView'),
};
const idleMsgEl = document.getElementById('idleMsg');
const inviterEl = document.getElementById('inviterName');
const timerEl = document.getElementById('timer');
const statusEl = document.getElementById('status');
const shareViewBtn = document.getElementById('shareViewBtn');
const shareControlBtn = document.getElementById('shareControlBtn');
const cancelBtn = document.getElementById('cancelBtn');
const stopBtn = document.getElementById('stopBtn');
const controlCheckbox = document.getElementById('controlCheckbox');

let ws = null;
let pc = null;
let stream = null;
let inputChannel = null;

let invite = null; // { token, name } from the link the person clicked
let active = false; // true from the moment they click Share until the session ends
let endsAt = 0; // local-clock deadline, computed from the duration the server sent
let countdownTimer = null;

function show(name) {
  Object.entries(views).forEach(([key, el]) => el.classList.toggle('show', key === name));
}

// The checkbox is the actual safety gate - flipping it tells the main
// process (via preload.js) whether it's allowed to act on anything that
// comes in over the data channel. Default is off; the viewer can request
// control, but only this checkbox can grant it. endSession() always turns
// it back off, so control never carries over into the next session.
controlCheckbox.addEventListener('change', () => {
  window.screenwatch.setControlEnabled(controlCheckbox.checked);
});

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function formatRemaining(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Runs every second. This is the agent's own copy of the expiry rule - it
// matters because after WebRTC connects the signaling server can no longer
// cut the stream; only this machine can.
function tick() {
  const left = endsAt - Date.now();
  if (left <= 0) return endSession(END_MESSAGES.expired);
  timerEl.textContent = `Session ends in ${formatRemaining(left)}`;
}

function teardownMedia() {
  if (inputChannel) {
    inputChannel.onmessage = null;
    try { inputChannel.close(); } catch (e) { /* already closed */ }
    inputChannel = null;
  }
  if (pc) {
    pc.onicecandidate = null;
    pc.onconnectionstatechange = null;
    pc.close();
    pc = null;
  }
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }
}

// Single exit point for every way a session can end (user clicked Stop,
// hard cap hit, viewer left, connection lost, ...).
function endSession(message) {
  active = false;
  invite = null;
  clearInterval(countdownTimer);
  countdownTimer = null;

  teardownMedia();

  if (ws) {
    const old = ws;
    ws = null;
    old.onclose = null;
    old.onmessage = null;
    old.close(); // server sees this and ends the session for the viewer too
  }

  // Remote control permission never outlives the session.
  controlCheckbox.checked = false;
  window.screenwatch.setControlEnabled(false);

  timerEl.textContent = '';
  statusEl.textContent = '';
  idleMsgEl.textContent = message || '';
  show('idle');
}

async function setupCapture() {
  // 1. Get the screen as a MediaStream via Electron's desktopCapturer.
  const sources = await window.screenwatch.getScreenSources();
  const primary = sources[0]; // v1: just grab the first screen
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: primary.id,
      },
    },
  });

  // 2. Set up the WebRTC peer connection and add the screen track to it.
  pc = new RTCPeerConnection(RTC_CONFIG);
  stream.getTracks().forEach((track) => pc.addTrack(track, stream));

  // v2: create a data channel for remote control input. This has to happen
  // before createOffer(), so the channel gets included in the SDP that's
  // negotiated with the viewer.
  inputChannel = pc.createDataChannel('input');
  inputChannel.onmessage = (event) => {
    if (!active) return;
    let input;
    try {
      input = JSON.parse(event.data);
    } catch (e) {
      return; // ignore malformed messages
    }
    // Actually applying this is gated in the main process by whether
    // "Allow remote control" is checked - this call is a no-op until then.
    window.screenwatch.injectInput(input);
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      send({ type: 'ice-candidate', candidate: event.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    if (!active || !pc) return;
    const state = pc.connectionState;
    statusEl.textContent = `Connection: ${state}`;
    if (state === 'failed' || state === 'closed') {
      endSession('Connection to the viewer was lost.');
    }
  };
}

// Called only from the two buttons on the consent screen. This is the
// moment of consent: nothing has been captured or sent to the server before it.
function startSharing(allowControl) {
  if (active || !invite) return;
  active = true;
  show('sharing');
  timerEl.textContent = '';
  statusEl.textContent = 'Connecting...';

  const token = invite.token;
  ws = new WebSocket(SIGNALING_SERVER_URL);

  ws.onopen = () => send({ type: 'accept', token });

  // A dead signaling connection means the server can no longer enforce expiry
  // or tell us the viewer left, so we stop sharing rather than carry on unsupervised.
  ws.onclose = () => {
    if (active) endSession('Lost connection to the server. Sharing stopped.');
  };

  ws.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (e) {
      return;
    }
    if (!active) return;

    if (msg.type === 'accepted') {
      // Start the clock the moment the server tells us, before the (possibly
      // slow) screen-capture setup, so our deadline matches the server's.
      const remaining = Number(msg.remainingMs);
      if (!(remaining > 0)) {
        endSession('The server sent an invalid session. Sharing stopped.');
        return;
      }
      endsAt = Date.now() + remaining;

      try {
        await setupCapture();
      } catch (e) {
        console.error('Screen capture setup failed:', e);
        endSession('Could not start screen capture.');
        return;
      }
      if (!active) {
        teardownMedia(); // session ended while we were setting up
        return;
      }

      // Control is granted only if they chose that button. The checkbox stays
      // visible so they can take it back at any time.
      controlCheckbox.checked = !!allowControl;
      window.screenwatch.setControlEnabled(!!allowControl);

      countdownTimer = setInterval(tick, 1000);
      tick();
      statusEl.textContent = 'Connecting to viewer...';

      // The viewer is already waiting, so we make the WebRTC offer right away.
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      send({ type: 'offer', sdp: offer });
      return;
    }

    if (msg.type === 'answer') {
      if (!pc) return;
      await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      statusEl.textContent = 'Connected';
      return;
    }

    if (msg.type === 'ice-candidate') {
      if (!pc) return;
      try {
        await pc.addIceCandidate(msg.candidate);
      } catch (e) {
        console.error('Failed to add ICE candidate', e);
      }
      return;
    }

    if (msg.type === 'error') {
      endSession(ERROR_MESSAGES[msg.code] || 'Could not join the session.');
      return;
    }

    if (msg.type === 'session-ended') {
      endSession(END_MESSAGES[msg.reason] || 'The session ended.');
    }
  };
}

function showInvite(next) {
  if (!next) return;
  if (active) {
    // Never swap the invite under someone who is mid-session.
    statusEl.textContent = 'Another invite arrived and was ignored. Stop sharing first to use it.';
    return;
  }
  invite = next;
  inviterEl.textContent = next.name || 'Someone'; // textContent: name is never treated as HTML
  idleMsgEl.textContent = '';
  show('consent');
}

shareViewBtn.addEventListener('click', () => startSharing(false));
shareControlBtn.addEventListener('click', () => startSharing(true));
cancelBtn.addEventListener('click', () => {
  invite = null;
  idleMsgEl.textContent = 'Cancelled. Nothing was shared.';
  show('idle');
});
stopBtn.addEventListener('click', () => endSession('Sharing stopped.'));

window.screenwatch.onInvite(showInvite);
window.screenwatch.takePendingInvite().then(showInvite); // link that launched the app
