// Same signaling server and STUN config as the agent — they have to match
// so both sides know how to find each other and connect.
//
// This is now pointed at a permanent, always-on signaling server hosted
// on Render (free tier) instead of a temporary ngrok tunnel. Since it's
// permanent, this URL doesn't need updating each demo like ngrok did.
// Note: Render's free tier sleeps after 15 minutes idle and takes about a
// minute to wake up on the next connection - if it seems stuck right at
// the start, that's the wake-up, not a real failure.
// const SIGNALING_SERVER_URL = 'wss://screen-watch-329x.onrender.com';
const SIGNALING_SERVER_URL = 'ws://localhost:8080';
// Same TURN/STUN config as the agent - both sides must match, or ICE
// negotiation can fail. TURN relays traffic when a direct connection isn't
// possible (different networks/ISPs), which is what lets this work for a
// demo across the internet instead of only on the same wifi.
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

const nameInput = document.getElementById('nameInput');
const inviteBtn = document.getElementById('inviteBtn');
const inviteBox = document.getElementById('inviteBox');
const inviteLinkEl = document.getElementById('inviteLink');
const copyBtn = document.getElementById('copyBtn');
const statusEl = document.getElementById('status');
const timerEl = document.getElementById('timer');
const videoEl = document.getElementById('remoteVideo');

// The invite link points at join.html next to this page. If you open the
// viewer on localhost, that link only works on this computer - host the viewer
// somewhere reachable and open it from there (or set this to that address).
const INVITE_PAGE_URL = new URL('join.html', location.href).href;

let ws;
let pc;
let inputChannel;
let controlActive = false;

const controlCheckbox = document.getElementById('controlCheckbox');
const controlLabel = document.getElementById('controlLabel');

function sendInput(obj) {
  if (inputChannel && inputChannel.readyState === 'open') {
    inputChannel.send(JSON.stringify(obj));
  }
}

// Converts a mouse event's pixel position into a 0-1 normalized coordinate
// relative to the video element's displayed size. The agent then multiplies
// this by *its own* real screen resolution - that's what makes this work
// regardless of how big the video looks on the viewer's screen. The video
// element has no forced height in the CSS, so it keeps the source's aspect
// ratio and there's no letterboxing to account for.
function normalizedPos(event) {
  const rect = videoEl.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}

controlCheckbox.addEventListener('change', () => {
  controlActive = controlCheckbox.checked;
  if (controlActive) videoEl.focus();
});

videoEl.addEventListener('mousemove', (event) => {
  if (!controlActive) return;
  const { x, y } = normalizedPos(event);
  sendInput({ type: 'move', x, y });
});

videoEl.addEventListener('mousedown', (event) => {
  if (!controlActive) return;
  event.preventDefault();
  sendInput({ type: 'mousedown', button: event.button });
});

videoEl.addEventListener('mouseup', (event) => {
  if (!controlActive) return;
  event.preventDefault();
  sendInput({ type: 'mouseup', button: event.button });
});

// Right-click would otherwise pop up the browser's own context menu instead
// of reaching the agent as a right mouse button press.
videoEl.addEventListener('contextmenu', (event) => {
  if (controlActive) event.preventDefault();
});

videoEl.addEventListener('wheel', (event) => {
  if (!controlActive) return;
  event.preventDefault();
  sendInput({ type: 'scroll', deltaY: event.deltaY });
}, { passive: false });

// Keyboard only fires while the video element itself has focus (that's what
// tabindex="0" on it is for), so typing in the code input box above never
// accidentally gets sent to the agent.
videoEl.addEventListener('keydown', (event) => {
  if (!controlActive) return;
  event.preventDefault();
  sendInput({ type: 'keydown', key: event.key });
});

videoEl.addEventListener('keyup', (event) => {
  if (!controlActive) return;
  event.preventDefault();
  sendInput({ type: 'keyup', key: event.key });
});

// ---- Invites ----
// This page creates the invite. The server makes the token; we wrap it in a
// link for the other person. The token sits after the "#", which browsers
// never send to any server.

const END_MESSAGES = {
  expired: 'Session reached its maximum length and was ended.',
  'join-window-expired': 'Your invite expired before they accepted. Create a new one.',
  'agent-left': 'They stopped sharing.',
};

let active = false;
let endsAt = 0;
let phase = 'idle'; // 'idle' | 'invited' | 'connected'
let countdownTimer = null;
let inviteDeadline = 0;
let currentLink = null;

function formatRemaining(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function tick() {
  const now = Date.now();
  if (now >= endsAt) return endViewerSession(END_MESSAGES.expired);
  if (phase === 'invited') {
    if (now >= inviteDeadline) return endViewerSession(END_MESSAGES['join-window-expired']);
    timerEl.textContent = `Invite expires in ${formatRemaining(Math.min(inviteDeadline, endsAt) - now)}`;
  } else {
    timerEl.textContent = `Session ends in ${formatRemaining(endsAt - now)}`;
  }
}

// Single exit point for every way a session can end on this side.
function endViewerSession(message) {
  active = false;
  phase = 'idle';
  clearInterval(countdownTimer);
  countdownTimer = null;

  if (ws) {
    const old = ws;
    ws = null;
    old.onclose = null;
    old.onmessage = null;
    old.close();
  }
  if (pc) {
    pc.ontrack = null;
    pc.ondatachannel = null;
    pc.onicecandidate = null;
    pc.onconnectionstatechange = null;
    pc.close();
    pc = null;
  }
  inputChannel = null;
  videoEl.srcObject = null;

  controlCheckbox.checked = false;
  controlCheckbox.disabled = true;
  controlActive = false;
  controlLabel.classList.add('disabled');

  currentLink = null;
  inviteBox.hidden = true;
  inviteLinkEl.textContent = '';
  timerEl.textContent = '';
  inviteBtn.disabled = false;
  statusEl.textContent = message;
}

function createInvite() {
  if (active) return;
  active = true;
  phase = 'idle';
  inviteBtn.disabled = true;
  statusEl.textContent = 'Creating invite...';

  const name = nameInput.value.trim().slice(0, 100);

  // Peer connection is ready before anyone can possibly accept.
  pc = new RTCPeerConnection(RTC_CONFIG);

  pc.ontrack = (event) => {
    videoEl.srcObject = event.streams[0];
    statusEl.textContent = 'Connected — watching remote screen';
  };

  // The agent creates the data channel; we just receive it here. Until it
  // opens, the "take control" checkbox stays disabled.
  pc.ondatachannel = (event) => {
    inputChannel = event.channel;
    inputChannel.onopen = () => {
      controlCheckbox.disabled = false;
      controlLabel.classList.remove('disabled');
    };
    inputChannel.onclose = () => {
      controlCheckbox.disabled = true;
      controlCheckbox.checked = false;
      controlActive = false;
      controlLabel.classList.add('disabled');
    };
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      send({ type: 'ice-candidate', candidate: event.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    if (!pc) return;
    statusEl.textContent = `Connection: ${pc.connectionState}`;
    if (pc.connectionState === 'failed') endViewerSession('Connection to them was lost.');
  };

  ws = new WebSocket(SIGNALING_SERVER_URL);

  ws.onopen = () => send({ type: 'create-invite' });

  // Whenever the server ends a session it sends a reason first (handled
  // below, which detaches this handler). Reaching here means the socket just died.
  ws.onclose = () => {
    if (active) endViewerSession('Disconnected from the server. Create a new invite.');
  };

  ws.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (e) {
      return;
    }
    if (!active) return;

    if (msg.type === 'invite-created') {
      // Durations, not timestamps, so it doesn't matter if our clock and the
      // server's disagree.
      const now = Date.now();
      inviteDeadline = now + Number(msg.joinTtlMs);
      endsAt = now + Number(msg.maxTtlMs);
      phase = 'invited';

      let link = `${INVITE_PAGE_URL}#t=${msg.token}`;
      if (name) link += `&n=${encodeURIComponent(name)}`;
      currentLink = link;
      inviteLinkEl.textContent = link;
      inviteBox.hidden = false;
      statusEl.textContent = 'Waiting for them to accept...';
      countdownTimer = setInterval(tick, 1000);
      tick();
      return;
    }

    if (msg.type === 'peer-ready') {
      phase = 'connected';
      statusEl.textContent = 'They accepted — connecting...';
      inviteBox.hidden = true; // the link is spent; don't leave it on screen
      currentLink = null;
      tick();
      return;
    }

    if (msg.type === 'session-ended') {
      endViewerSession(END_MESSAGES[msg.reason] || 'The session ended.');
      return;
    }

    if (msg.type === 'offer') {
      // The agent sent us its offer - answer it.
      await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send({ type: 'answer', sdp: answer });
      return;
    }

    if (msg.type === 'ice-candidate') {
      try {
        await pc.addIceCandidate(msg.candidate);
      } catch (e) {
        console.error('Failed to add ICE candidate', e);
      }
    }
  };
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

copyBtn.addEventListener('click', async () => {
  if (!currentLink) return;
  try {
    await navigator.clipboard.writeText(currentLink);
    copyBtn.textContent = 'Copied!';
  } catch (e) {
    copyBtn.textContent = 'Click the link, then copy';
  }
  setTimeout(() => { copyBtn.textContent = 'Copy link'; }, 2000);
});

inviteBtn.addEventListener('click', createInvite);
