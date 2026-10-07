/**
 * ScreenWatch - Signaling Server
 *
 * This server does NOT see or relay any screen data. It only relays small
 * JSON messages (WebRTC "offer", "answer", and "ICE candidates") between
 * an agent (the machine sharing its screen) and a viewer (the machine
 * watching it). Once the two sides connect directly (or via a TURN relay),
 * the actual video flows peer-to-peer and never touches this server.
 *
 * Pairing model: INVITES (the viewer creates, the agent accepts).
 *
 *   1. The viewer connects and sends { type: 'create-invite' }.
 *   2. The server mints a random 192-bit token and sends it back, along with
 *      how long the invite stays valid (as DURATIONS, not timestamps, so clock
 *      differences between machines don't matter).
 *   3. The viewer page turns the token into a link and sends it to the person
 *      who will share their screen. Their app opens it.
 *   4. Only after that person clicks "Share my screen" does their app connect
 *      and send { type: 'accept', token }.
 *
 * Rules enforced here:
 *   - Invites are single-use: the first agent to accept claims the session.
 *   - An invite nobody accepts expires after JOIN_WINDOW_MS.
 *   - Every session has a hard cap of MAX_SESSION_MS from creation.
 *   - If either side's signaling socket closes, the session ends.
 *   - Expiry is pushed to both sides as { type: 'session-ended', reason }.
 *
 * IMPORTANT: once WebRTC is connected, video and input flow peer-to-peer and
 * this server is no longer in the path. So the agent ALSO enforces the same
 * deadlines locally - it is the one machine that can actually cut the stream.
 */

const WebSocket = require('ws');
const crypto = require('crypto');
const os = require('os');

const PORT = process.env.PORT || 8080;
const HOST = '0.0.0.0'; // listen on all network interfaces, not just localhost

const JOIN_WINDOW_MS = Number(process.env.JOIN_WINDOW_MS) || 30 * 60 * 1000; // invite must be accepted within 30 min (time to install the app)
const MAX_SESSION_MS = Number(process.env.MAX_SESSION_MS) || 60 * 60 * 1000; // hard cap: 60 min from creation
const SWEEP_INTERVAL_MS = Number(process.env.SWEEP_INTERVAL_MS) || 5 * 1000;
const HEARTBEAT_MS = 25 * 1000; // keeps proxies (e.g. Render) from dropping an idle socket
const UNBOUND_TIMEOUT_MS = 15 * 1000; // a socket must create/join a session within this long

const RELAYED_TYPES = new Set(['offer', 'answer', 'ice-candidate']);

// SDP offers are a few KB; anything much bigger than this isn't legitimate.
const wss = new WebSocket.Server({ port: PORT, host: HOST, maxPayload: 64 * 1024 });

// token -> { token, viewer: ws, agent: ws|null, joinDeadline, endsAt }
const sessions = new Map();

function getLocalIPs() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  return ips;
}

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function newToken() {
  // 24 random bytes = 192 bits, URL-safe. Not guessable, so no rate limit is
  // needed to protect the token itself. Never log tokens.
  return crypto.randomBytes(24).toString('base64url');
}

// Ends a session and tells both sides why. Safe to call more than once.
function endSession(s, reason) {
  if (!sessions.delete(s.token)) return;
  for (const peer of [s.agent, s.viewer]) {
    if (!peer) continue;
    peer.session = null; // so the 'close' handler doesn't end it a second time
    if (peer.readyState === WebSocket.OPEN) {
      send(peer, { type: 'session-ended', reason });
      peer.close(1000, reason);
    }
  }
}

function reject(ws, code) {
  send(ws, { type: 'error', code });
  ws.close(1008, code);
}

wss.on('connection', (ws) => {
  ws.role = null;
  ws.session = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // Drop sockets that connect and never do anything.
  const unboundTimer = setTimeout(() => {
    if (!ws.session) ws.close(1008, 'timeout');
  }, UNBOUND_TIMEOUT_MS);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return; // ignore malformed messages
    }
    if (!msg || typeof msg.type !== 'string') return;

    // ---- Viewer: create an invite ----
    if (msg.type === 'create-invite') {
      if (ws.session) return; // one session per socket
      const now = Date.now();
      const session = {
        token: newToken(),
        viewer: ws,
        agent: null,
        joinDeadline: now + JOIN_WINDOW_MS,
        endsAt: now + MAX_SESSION_MS,
      };
      sessions.set(session.token, session);
      ws.role = 'viewer';
      ws.session = session;
      send(ws, {
        type: 'invite-created',
        token: session.token,
        joinTtlMs: JOIN_WINDOW_MS,
        maxTtlMs: MAX_SESSION_MS,
      });
      return;
    }

    // ---- Agent: accept an invite (sent only after the person clicked Share) ----
    if (msg.type === 'accept') {
      if (ws.session) return;
      const s = typeof msg.token === 'string' ? sessions.get(msg.token) : undefined;
      if (!s) return reject(ws, 'invalid'); // unknown, expired, or ended - deliberately indistinguishable
      const now = Date.now();
      if (now >= s.endsAt || (!s.agent && now >= s.joinDeadline)) {
        endSession(s, s.agent ? 'expired' : 'join-window-expired');
        return reject(ws, 'invalid');
      }
      if (s.agent) return reject(ws, 'in-use'); // single-use: already accepted

      s.agent = ws;
      ws.role = 'agent';
      ws.session = s;
      send(ws, { type: 'accepted', remainingMs: s.endsAt - now });
      send(s.viewer, { type: 'peer-ready' });
      return;
    }

    // ---- Either side: relay WebRTC handshake messages to the other side ----
    if (RELAYED_TYPES.has(msg.type)) {
      const s = ws.session;
      if (!s) return;
      const target = ws.role === 'agent' ? s.viewer : s.agent;
      // Forward only the fields we expect, not whatever the client sent.
      send(target, { type: msg.type, sdp: msg.sdp, candidate: msg.candidate });
    }
  });

  ws.on('close', () => {
    clearTimeout(unboundTimer);
    if (ws.session) endSession(ws.session, ws.role === 'agent' ? 'agent-left' : 'viewer-left');
  });
});

// Enforce expiry even if both sides go quiet.
setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (now >= s.endsAt) endSession(s, 'expired');
    else if (!s.agent && now >= s.joinDeadline) endSession(s, 'join-window-expired');
  }
}, SWEEP_INTERVAL_MS).unref();

// Ping every socket; terminate the ones that stopped answering.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);
wss.on('close', () => clearInterval(heartbeat));

console.log(`Signaling server listening on port ${PORT}`);
console.log(`  On this PC:        ws://localhost:${PORT}`);
getLocalIPs().forEach((ip) => {
  console.log(`  From other devices: ws://${ip}:${PORT}`);
});
console.log(`  Link must be opened within ${JOIN_WINDOW_MS / 1000}s; sessions last at most ${MAX_SESSION_MS / 1000}s`);
