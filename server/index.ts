/**
 * RemoteDesk standalone signaling relay.
 *
 * The desktop app embeds its own signaling server (`src-tauri/src/signaling.rs`),
 * so this process is NOT required to use RemoteDesk. It exists for two cases the
 * embedded server cannot cover:
 *
 * - A rendezvous point on a host both peers can reach, when neither can dial the
 *   other directly (behind separate NATs, no tunnel).
 * - Serving the built web client, so a peer can join from a browser with nothing
 *   installed.
 *
 * It speaks exactly the protocol in `src/utils/signaling.ts`: JSON frames of
 * `{"event": string, "data": value}` over a WebSocket at `/rtc`. Keep the two
 * server implementations in step.
 */
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '../dist');
/**
 * Desktop installers offered for download, if any have been built or copied
 * here. Overridable so a deployment can point at a release directory that is
 * not inside the repository.
 */
const installersDir = path.resolve(
  process.env.REMOTEDESK_INSTALLERS_DIR ?? path.join(__dirname, '../installers')
);

const PORT = Number(process.env.SIGNAL_PORT ?? 4000);
const HOST = process.env.SIGNAL_HOST ?? '0.0.0.0';

/** Max failed join attempts per peer before it is disconnected. */
const MAX_FAILED_JOINS = 10;
/** Window in which failed attempts accumulate. */
const FAILED_JOIN_WINDOW_MS = 60_000;
/** How long the host has to answer an authorization request. */
const AUTH_TIMEOUT_MS = 30_000;
/** Peers that stop answering heartbeats are dropped after this long. */
const HEARTBEAT_INTERVAL_MS = 25_000;

interface Peer {
  id: string;
  socket: WebSocket;
  alive: boolean;
}

interface Room {
  roomId: string;
  hostId: string;
  clientIds: Set<string>;
  createdAt: number;
  unattended: boolean;
  pin?: string;
}

interface PendingAuth {
  clientId: string;
  roomId: string;
  timer: NodeJS.Timeout;
}

const peers = new Map<string, Peer>();
const rooms = new Map<string, Room>();
/** requestId -> pending host authorization */
const pendingAuth = new Map<string, PendingAuth>();
/** peerId -> timestamps of failed join attempts */
const failedJoins = new Map<string, number[]>();

let nextId = 1;
const mintId = (prefix: string) => `${prefix}${(nextId++).toString(16)}`;

function log(...args: unknown[]) {
  console.log(`[signal ${new Date().toISOString()}]`, ...args);
}

function getLocalIpAddresses(): string[] {
  const interfaces = os.networkInterfaces();
  const addresses: string[] = [];
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal) addresses.push(net.address);
    }
  }
  return addresses;
}

function send(peerId: string, event: string, data: unknown) {
  const peer = peers.get(peerId);
  if (!peer || peer.socket.readyState !== WebSocket.OPEN) return;
  try {
    peer.socket.send(JSON.stringify({ event, data }));
  } catch (err) {
    log(`send to ${peerId} failed:`, err);
  }
}

/** Normalizes a PIN the way both peers must agree on before comparison. */
function normalizePin(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().toUpperCase();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Accepts both the object form and the bare-string form of a room payload. */
function roomIdOf(data: any): string {
  if (typeof data === 'string') return data.trim();
  return String(data?.roomId ?? '').trim();
}

function recordFailedJoin(peerId: string): boolean {
  const now = Date.now();
  const history = (failedJoins.get(peerId) ?? []).filter((t) => now - t < FAILED_JOIN_WINDOW_MS);
  history.push(now);
  failedJoins.set(peerId, history);
  return history.length >= MAX_FAILED_JOINS;
}

function roomOf(peerId: string): Room | undefined {
  for (const room of rooms.values()) {
    if (room.hostId === peerId || room.clientIds.has(peerId)) return room;
  }
  return undefined;
}

/**
 * Resolves who should receive a signaling frame from `peerId`. Shared by both
 * signaling shapes so the room-membership check cannot be bypassed by using
 * the other one.
 */
function signalTargets(peerId: string, targetId?: string): { targets: string[]; roomId: string } {
  const room = roomOf(peerId);
  if (!room) return { targets: [], roomId: '' };

  if (targetId) {
    const isPeer = room.hostId === targetId || room.clientIds.has(targetId);
    return { targets: isPeer ? [targetId] : [], roomId: room.roomId };
  }

  const targets = room.hostId === peerId ? [...room.clientIds] : [room.hostId];
  return { targets, roomId: room.roomId };
}

/** Drops the peer from every room and tears down any room it was hosting. */
function removePeer(peerId: string) {
  for (const room of rooms.values()) {
    if (room.clientIds.delete(peerId)) {
      send(room.hostId, 'peer:left', { peerId });
      send(room.hostId, 'peer-left', { peerId, senderId: peerId, roomId: room.roomId });
      log(`client ${peerId} left room ${room.roomId}`);
    }
  }

  for (const [roomId, room] of [...rooms.entries()]) {
    if (room.hostId !== peerId) continue;
    for (const clientId of room.clientIds) {
      send(clientId, 'session:ended', { roomId, reason: 'Host disconnected' });
      send(clientId, 'peer-left', { peerId, senderId: peerId, roomId });
    }
    rooms.delete(roomId);
    log(`room ${roomId} destroyed (host disconnected)`);
  }

  for (const [requestId, pending] of pendingAuth.entries()) {
    if (pending.clientId === peerId) {
      clearTimeout(pending.timer);
      pendingAuth.delete(requestId);
    }
  }
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

function hostCreate(peerId: string, data: any) {
  const roomId = roomIdOf(data);
  if (!/^[A-Za-z0-9-]{3,32}$/.test(roomId)) {
    send(peerId, 'host:create:result', { ok: false, reason: 'Invalid Desk ID format' });
    return;
  }

  const existing = rooms.get(roomId);
  // Refuse to steal a room from a host that is still connected.
  if (existing && existing.hostId !== peerId && peers.has(existing.hostId)) {
    send(peerId, 'host:create:result', { ok: false, reason: 'Desk ID already in use' });
    return;
  }

  rooms.set(roomId, {
    roomId,
    hostId: peerId,
    // A reconnecting host keeps whichever clients are still attached.
    clientIds: existing?.clientIds ?? new Set(),
    createdAt: Date.now(),
    unattended: typeof data === 'object' ? data?.unattended !== false : true,
    pin: normalizePin(data?.pin),
  });

  log(`room ${roomId} created by host ${peerId} (unattended: ${rooms.get(roomId)!.unattended})`);
  send(peerId, 'host:create:result', { ok: true, roomId, peerId });
}

function clientJoin(peerId: string, data: any) {
  const roomId = roomIdOf(data);
  const pin = normalizePin(data?.pin);
  const room = rooms.get(roomId);

  if (!room) {
    send(peerId, 'join:result', {
      granted: false,
      reason: 'No host is currently sharing that Desk ID',
    });
    if (recordFailedJoin(peerId)) {
      send(peerId, 'join:result', { granted: false, reason: 'Too many failed attempts' });
      peers.get(peerId)?.socket.close(1008, 'too many failed attempts');
    }
    return;
  }

  const pinMatches = !room.pin || room.pin === pin;
  if (room.unattended || pinMatches) {
    failedJoins.delete(peerId);
    room.clientIds.add(peerId);

    send(peerId, 'join:result', { granted: true, roomId, hostId: room.hostId, peerId });
    send(room.hostId, 'peer:joined', { peerId });
    send(room.hostId, 'peer-joined', { peerId, senderId: peerId, roomId });
    log(`client ${peerId} authorized into room ${roomId} (auto-accepted / unattended)`);
    return;
  }

  // Otherwise defer to the host operator, with a deadline.
  const requestId = mintId('req');
  const timer = setTimeout(() => {
    pendingAuth.delete(requestId);
    send(peerId, 'join:result', { granted: false, reason: 'Host did not respond in time' });
  }, AUTH_TIMEOUT_MS);

  pendingAuth.set(requestId, { clientId: peerId, roomId, timer });
  send(room.hostId, 'peer:join-request', { requestId, peerId, pin: pin ?? '' });
}

function hostAuthResult(peerId: string, data: any) {
  const requestId = String(data?.requestId ?? '');
  const pending = pendingAuth.get(requestId);
  if (!pending) return;

  const room = rooms.get(pending.roomId);
  // Only the room's own host may rule on its join requests.
  if (!room || room.hostId !== peerId) return;

  clearTimeout(pending.timer);
  pendingAuth.delete(requestId);

  const clientId = pending.clientId;
  if (!peers.has(clientId)) return;

  if (!data?.granted) {
    send(clientId, 'join:result', {
      granted: false,
      reason: data?.reason ?? 'Rejected by host',
    });
    if (recordFailedJoin(clientId)) {
      peers.get(clientId)?.socket.close(1008, 'too many failed attempts');
    }
    return;
  }

  failedJoins.delete(clientId);
  room.clientIds.add(clientId);

  send(clientId, 'join:result', {
    granted: true,
    roomId: room.roomId,
    hostId: room.hostId,
    peerId: clientId,
  });
  send(room.hostId, 'peer:joined', { peerId: clientId });
  send(room.hostId, 'peer-joined', { peerId: clientId, senderId: clientId, roomId: room.roomId });
  log(`client ${clientId} authorized into room ${room.roomId} by host`);
}

function relay(peerId: string, kind: string, payload: unknown, targetId?: string) {
  const { targets, roomId } = signalTargets(peerId, targetId);
  for (const target of targets) {
    send(target, 'signal', { fromId: peerId, kind, data: payload });
    // The typed alias keeps older clients that listen per-event working.
    send(target, kind, { senderId: peerId, roomId, data: payload });
  }
}

function handleEvent(peerId: string, event: string, data: any) {
  switch (event) {
    case 'host:create':
      hostCreate(peerId, data);
      break;
    case 'client:join':
      clientJoin(peerId, data);
      break;
    case 'host:auth-result':
      hostAuthResult(peerId, data);
      break;
    case 'signal':
      if (typeof data?.kind === 'string') relay(peerId, data.kind, data?.data ?? null, data?.targetId);
      break;
    case 'offer':
    case 'answer':
    case 'ice-candidate':
      relay(peerId, event, data?.data ?? data, data?.targetId);
      break;
    case 'leave':
      // Keep the transport open; the peer may re-join another room.
      removePeer(peerId);
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket surface
// ---------------------------------------------------------------------------

const app = express();

// Browser and webview clients read these endpoints from a different origin. The
// data is a port number and this machine's own LAN addresses, and no credentials
// are accepted, so a permissive policy costs nothing.
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});
app.options(/.*/, (_req, res) => res.sendStatus(204));

app.get('/healthz', (_req, res) => {
  res.json({
    status: 'ok',
    port: PORT,
    rooms: rooms.size,
    connections: peers.size,
    uptimeSeconds: Math.round(process.uptime()),
    lanAddresses: getLocalIpAddresses().map((ip) => `http://${ip}:${PORT}`),
  });
});

app.get('/network-info', (_req, res) => {
  res.json({
    port: PORT,
    lanAddresses: getLocalIpAddresses().map((ip) => `http://${ip}:${PORT}`),
    tunnelUrl: null,
    rooms: rooms.size,
    activeRooms: Array.from(rooms.keys()),
    connections: peers.size,
  });
});

/** Extensions this server will offer. Anything else in the directory is ignored. */
const INSTALLER_EXTENSIONS = ['.exe', '.msi', '.deb', '.rpm', '.appimage', '.dmg'];

const RELEASES_URL = 'https://github.com/Smileys-Helping-hand/myremotedesktop/releases';

function classifyInstaller(file: string): { platform: string; kind: string } {
  const lower = file.toLowerCase();
  if (lower.endsWith('.exe')) return { platform: 'windows', kind: 'exe' };
  if (lower.endsWith('.msi')) return { platform: 'windows', kind: 'msi' };
  if (lower.endsWith('.deb')) return { platform: 'linux', kind: 'deb' };
  if (lower.endsWith('.rpm')) return { platform: 'linux', kind: 'rpm' };
  if (lower.endsWith('.appimage')) return { platform: 'linux', kind: 'appimage' };
  if (lower.endsWith('.dmg')) return { platform: 'macos', kind: 'dmg' };
  return { platform: 'linux', kind: 'unknown' };
}

/**
 * Lists the installers actually present on disk.
 *
 * Read on each request rather than cached at boot, so dropping a freshly built
 * installer into the directory takes effect without a restart. Only the top
 * level is scanned — build output often leaves stray copies in subdirectories,
 * and offering two files with the same name from different folders is worse
 * than offering one.
 */
function listInstallers() {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(installersDir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((e) => e.isFile())
    .filter((e) => INSTALLER_EXTENSIONS.some((ext) => e.name.toLowerCase().endsWith(ext)))
    .map((e) => {
      const full = path.join(installersDir, e.name);
      let sizeBytes = 0;
      try {
        sizeBytes = fs.statSync(full).size;
      } catch {
        return null;
      }
      return {
        file: e.name,
        ...classifyInstaller(e.name),
        sizeBytes,
        url: `/download/${encodeURIComponent(e.name)}`,
      };
    })
    .filter((a): a is NonNullable<typeof a> => a !== null);
}

app.get('/api/downloads', (_req, res) => {
  const assets = listInstallers();
  const version =
    assets.map((a) => a.file.match(/\d+\.\d+\.\d+/)?.[0]).find(Boolean) ?? null;
  res.json({ version, assets, releasesUrl: RELEASES_URL });
});

/**
 * Serves one installer.
 *
 * The filename is resolved and then checked to be inside the installers
 * directory, so a crafted `..` path cannot reach the rest of the filesystem.
 */
app.get('/download/:file', (req, res) => {
  const requested = path.basename(req.params.file);
  const full = path.resolve(installersDir, requested);

  if (path.dirname(full) !== installersDir) {
    res.status(400).json({ error: 'invalid file name' });
    return;
  }
  if (!INSTALLER_EXTENSIONS.some((ext) => requested.toLowerCase().endsWith(ext))) {
    res.status(404).json({ error: 'not an installer' });
    return;
  }
  if (!fs.existsSync(full)) {
    res.status(404).json({ error: 'no such installer' });
    return;
  }

  // Force a download rather than letting the browser try to render it.
  res.download(full, requested, (err) => {
    if (err && !res.headersSent) res.status(500).end();
  });
});

// Serve the built web client when one exists, so a peer can join from a browser.
app.use(express.static(distDir, { fallthrough: true }));

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/rtc' });

wss.on('connection', (socket) => {
  const peerId = mintId('p');
  peers.set(peerId, { id: peerId, socket, alive: true });
  log(`peer connected: ${peerId}`);

  send(peerId, 'welcome', { peerId });

  socket.on('pong', () => {
    const peer = peers.get(peerId);
    if (peer) peer.alive = true;
  });

  socket.on('message', (raw) => {
    let frame: { event?: string; data?: unknown };
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!frame || typeof frame.event !== 'string') return;
    handleEvent(peerId, frame.event, frame.data ?? null);
  });

  socket.on('close', () => {
    log(`peer disconnected: ${peerId}`);
    removePeer(peerId);
    peers.delete(peerId);
    failedJoins.delete(peerId);
  });

  socket.on('error', (err) => log(`peer ${peerId} socket error:`, err));
});

// Half-open TCP connections would otherwise leave rooms owned by a host that is
// no longer there, so peers that miss a heartbeat are dropped.
const heartbeat = setInterval(() => {
  for (const peer of peers.values()) {
    if (!peer.alive) {
      peer.socket.terminate();
      continue;
    }
    peer.alive = false;
    try {
      peer.socket.ping();
    } catch {
      peer.socket.terminate();
    }
  }
}, HEARTBEAT_INTERVAL_MS);

httpServer.listen(PORT, HOST, () => {
  log(`Signaling relay listening on http://${HOST}:${PORT} (WebSocket at /rtc)`);
  const ips = getLocalIpAddresses();
  if (ips.length > 0) {
    log('Local network endpoints:');
    ips.forEach((ip) => log(`  -> http://${ip}:${PORT}`));
  }
  log(`Serving the built web client from ${distDir} (if built)`);
  const installerCount = listInstallers().length;
  log(
    installerCount > 0
      ? `Offering ${installerCount} desktop installer(s) from ${installersDir}`
      : `No desktop installers in ${installersDir}; the app will link to GitHub Releases instead`
  );
});

function shutdown(signal: string) {
  log(`received ${signal}, shutting down`);
  clearInterval(heartbeat);
  for (const peer of peers.values()) peer.socket.close(1001, 'server shutting down');
  wss.close(() => httpServer.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
