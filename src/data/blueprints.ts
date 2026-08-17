export interface BlueprintFile {
  id: string;
  filename: string;
  title: string;
  category: 'Electron' | 'Signaling' | 'Math' | 'WebRTC' | 'Setup';
  description: string;
  language: string;
  code: string;
}

export const BLUEPRINT_FILES: BlueprintFile[] = [
  {
    id: 'scaffold-setup',
    filename: 'setup-guide.md',
    title: '1. Project Scaffold & Dependencies',
    category: 'Setup',
    description: 'Terminal commands, Electron + Vite setup, and package.json configuration with native build tools.',
    language: 'markdown',
    code: `# Project Initialization & Setup Guide

## Step 1: Scaffold Vite + React + Electron + TypeScript
\`\`\`bash
# Create directory and initialize project
mkdir remotedesk-app && cd remotedesk-app
npm init -y

# Install Core Frontend Dependencies
npm install react react-dom lucide-react socket.io-client
npm install -D vite @vitejs/plugin-react typescript @types/react @types/react-dom tailwindcss @tailwindcss/vite

# Install Electron & Native OS Automation Tooling
npm install electron-is-dev
npm install @nut-tree/nut-js
npm install -D electron electron-builder @types/node concurrently cross-env tsx esbuild
\`\`\`

## Step 2: Configure Native Module Rebuilding for \`@nut-tree/nut-js\`
\`@nut-tree/nut-js\` relies on native C++ bindings for libuiohook / OS accessibility APIs.
Add this script to your \`package.json\`:

\`\`\`json
{
  "name": "remotedesk-app",
  "version": "1.0.0",
  "main": "dist-electron/main.js",
  "scripts": {
    "dev": "concurrently -k \\"vite\\" \\"tsx watch electron/main.ts\\"",
    "build:electron": "esbuild electron/main.ts --bundle --platform=node --outfile=dist-electron/main.js --external:electron --external:@nut-tree/nut-js && esbuild electron/preload.ts --bundle --platform=node --outfile=dist-electron/preload.js --external:electron",
    "build": "vite build && npm run build:electron && electron-builder",
    "postinstall": "electron-builder install-app-deps"
  }
}
\`\`\`

## Step 3: Signaling Server Initialization
In a separate backend folder (or sub-package):
\`\`\`bash
mkdir signaling-server && cd signaling-server
npm init -y
npm install express socket.io cors dotenv
npm install -D typescript @types/express @types/node @types/cors tsx
\`\`\`
`
  },
  {
    id: 'signaling-server',
    filename: 'server/signalingServer.ts',
    title: '2. Node.js + Socket.io Signaling Server',
    category: 'Signaling',
    description: 'Production-ready WebRTC signaling server handling Room lifecycle, Session IDs, SDP Offer/Answer relay, and ICE candidate trickling with STUN/TURN fallback.',
    language: 'typescript',
    code: `import express from 'express';
import http from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  pingInterval: 10000,
  pingTimeout: 5000,
});

const PORT = process.env.PORT || 4000;

interface RoomSession {
  roomId: string;
  hostSocketId: string;
  clientSocketId: string | null;
  createdAt: number;
  hostMetadata?: {
    width: number;
    height: number;
    devicePixelRatio: number;
  };
}

// Active Sessions Store
const rooms = new Map<string, RoomSession>();
const socketToRoom = new Map<string, string>();

/**
 * WebRTC Public STUN & TURN Infrastructure Configuration
 */
export const ICE_SERVERS_CONFIG: RTCConfiguration = {
  iceServers: [
    // Free Public Google STUN servers (Primary for NAT discovery)
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    
    // TURN Server Stub (Required for Symmetric NAT / Strict Corporate Firewalls)
    // In production, provision coturn (e.g. on AWS EC2 or Twilio Network Traversal)
    {
      urls: 'turn:turn.example.com:3478?transport=udp',
      username: process.env.TURN_USERNAME || 'remote_guest',
      credential: process.env.TURN_PASSWORD || 'turn_secret_token_123',
    },
  ],
  iceCandidatePoolSize: 10,
};

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    activeRooms: rooms.size,
    timestamp: Date.now(),
  });
});

app.get('/api/ice-servers', (req, res) => {
  res.json(ICE_SERVERS_CONFIG);
});

io.on('connection', (socket: Socket) => {
  console.log(\`[Signaling] Socket connected: \${socket.id}\`);

  // 1. Host creates a unique 6-digit or UUID Session ID
  socket.on('create-room', ({ roomId, hostMetadata }, callback) => {
    if (rooms.has(roomId)) {
      callback({ success: false, message: 'Room ID already in use.' });
      return;
    }

    const session: RoomSession = {
      roomId,
      hostSocketId: socket.id,
      clientSocketId: null,
      createdAt: Date.now(),
      hostMetadata,
    };

    rooms.set(roomId, session);
    socketToRoom.set(socket.id, roomId);
    socket.join(roomId);

    console.log(\`[Signaling] Room created: \${roomId} by Host: \${socket.id}\`);
    callback({ success: true, roomId, iceServers: ICE_SERVERS_CONFIG });
  });

  // 2. Client joins the Session ID
  socket.on('join-room', ({ roomId }, callback) => {
    const session = rooms.get(roomId);
    if (!session) {
      callback({ success: false, message: 'Session ID not found or expired.' });
      return;
    }

    if (session.clientSocketId && session.clientSocketId !== socket.id) {
      callback({ success: false, message: 'Session is full. Another client is connected.' });
      return;
    }

    session.clientSocketId = socket.id;
    socketToRoom.set(socket.id, roomId);
    socket.join(roomId);

    console.log(\`[Signaling] Client \${socket.id} joined Room \${roomId}\`);

    // Notify Host that Client is ready for WebRTC Offer
    io.to(session.hostSocketId).emit('client-joined', {
      clientId: socket.id,
    });

    callback({
      success: true,
      roomId,
      hostMetadata: session.hostMetadata,
      iceServers: ICE_SERVERS_CONFIG,
    });
  });

  // 3. WebRTC SDP Offer Relay (Host -> Client or Client -> Host)
  socket.on('sdp-offer', ({ roomId, sdp }) => {
    const session = rooms.get(roomId);
    if (!session) return;

    const targetSocketId = socket.id === session.hostSocketId ? session.clientSocketId : session.hostSocketId;
    if (targetSocketId) {
      io.to(targetSocketId).emit('sdp-offer', { sdp, senderId: socket.id });
    }
  });

  // 4. WebRTC SDP Answer Relay (Client -> Host)
  socket.on('sdp-answer', ({ roomId, sdp }) => {
    const session = rooms.get(roomId);
    if (!session) return;

    const targetSocketId = socket.id === session.hostSocketId ? session.clientSocketId : session.hostSocketId;
    if (targetSocketId) {
      io.to(targetSocketId).emit('sdp-answer', { sdp, senderId: socket.id });
    }
  });

  // 5. ICE Candidate Trickling Relay
  socket.on('ice-candidate', ({ roomId, candidate }) => {
    const session = rooms.get(roomId);
    if (!session) return;

    const targetSocketId = socket.id === session.hostSocketId ? session.clientSocketId : session.hostSocketId;
    if (targetSocketId) {
      io.to(targetSocketId).emit('ice-candidate', { candidate, senderId: socket.id });
    }
  });

  // 6. Host Screen Resolution / Scale Update
  socket.on('update-host-metadata', ({ roomId, metadata }) => {
    const session = rooms.get(roomId);
    if (session && socket.id === session.hostSocketId) {
      session.hostMetadata = metadata;
      if (session.clientSocketId) {
        io.to(session.clientSocketId).emit('host-metadata-updated', metadata);
      }
    }
  });

  // 7. Cleanup on Disconnect
  socket.on('disconnect', () => {
    const roomId = socketToRoom.get(socket.id);
    if (!roomId) return;

    const session = rooms.get(roomId);
    if (session) {
      if (socket.id === session.hostSocketId) {
        // Host disconnected: notify client and close room
        if (session.clientSocketId) {
          io.to(session.clientSocketId).emit('peer-disconnected', { reason: 'Host closed session.' });
        }
        rooms.delete(roomId);
      } else if (socket.id === session.clientSocketId) {
        // Client disconnected: reset client slot and inform host
        session.clientSocketId = null;
        io.to(session.hostSocketId).emit('peer-disconnected', { reason: 'Client disconnected.' });
      }
    }

    socketToRoom.delete(socket.id);
    console.log(\`[Signaling] Socket disconnected: \${socket.id}\`);
  });
});

server.listen(PORT, () => {
  console.log(\`⚡ [Signaling Server] Running on http://localhost:\${PORT}\`);
});
`
  },
  {
    id: 'coordinate-math',
    filename: 'src/utils/coordinateMath.ts',
    title: '3. Coordinate Normalization & Aspect Ratio Math',
    category: 'Math',
    description: 'Exact mathematical translation from Client pointer clicks on letterboxed/pillarboxed <video> elements to Host physical/logical pixels.',
    language: 'typescript',
    code: `export interface HostScreenMetadata {
  width: number;             // Physical width in pixels (e.g. 3840, 2560, 1920)
  height: number;            // Physical height in pixels (e.g. 2160, 1440, 1080)
  devicePixelRatio: number;  // Host OS scaling factor (e.g. 1.0, 1.25, 1.5, 2.0)
}

export interface BoundingBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface CoordinateTranslationResult {
  elementWidth: number;
  elementHeight: number;
  renderedWidth: number;
  renderedHeight: number;
  offsetX: number;
  offsetY: number;
  isPillarboxed: boolean;
  isLetterboxed: boolean;
  normalizedX: number;
  normalizedY: number;
  isOutOfBounds: boolean;
  hostPhysicalX: number;
  hostPhysicalY: number;
  hostLogicalX: number;
  hostLogicalY: number;
}

/**
 * Computes rendered sub-rectangle inside a <video> element with CSS 'object-fit: contain'
 */
export function getContainedVideoRect(
  containerWidth: number,
  containerHeight: number,
  sourceWidth: number,
  sourceHeight: number
) {
  if (containerWidth <= 0 || containerHeight <= 0 || sourceWidth <= 0 || sourceHeight <= 0) {
    return { renderedWidth: 0, renderedHeight: 0, offsetX: 0, offsetY: 0, isPillarboxed: false, isLetterboxed: false };
  }

  const containerAspect = containerWidth / containerHeight;
  const sourceAspect = sourceWidth / sourceHeight;
  const EPSILON = 0.0001;

  let renderedWidth = 0;
  let renderedHeight = 0;
  let offsetX = 0;
  let offsetY = 0;
  let isPillarboxed = false;
  let isLetterboxed = false;

  if (containerAspect > sourceAspect + EPSILON) {
    // Container is WIDER than source -> PILLARBOXING (black bars on Left & Right)
    renderedHeight = containerHeight;
    renderedWidth = containerHeight * sourceAspect;
    offsetX = (containerWidth - renderedWidth) / 2;
    offsetY = 0;
    isPillarboxed = true;
  } else if (containerAspect < sourceAspect - EPSILON) {
    // Container is TALLER than source -> LETTERBOXING (black bars on Top & Bottom)
    renderedWidth = containerWidth;
    renderedHeight = containerWidth / sourceAspect;
    offsetX = 0;
    offsetY = (containerHeight - renderedHeight) / 2;
    isLetterboxed = true;
  } else {
    // Perfect match
    renderedWidth = containerWidth;
    renderedHeight = containerHeight;
    offsetX = 0;
    offsetY = 0;
  }

  return { renderedWidth, renderedHeight, offsetX, offsetY, isPillarboxed, isLetterboxed };
}

/**
 * Translates a client pointer event into Host absolute physical and logical coordinates.
 */
export function calculateRemoteCoordinates(
  clientX: number,
  clientY: number,
  videoRect: BoundingBox,
  hostMetadata: HostScreenMetadata
): CoordinateTranslationResult {
  const { width: containerWidth, height: containerHeight, left: containerLeft, top: containerTop } = videoRect;
  const hostWidth = hostMetadata.width;
  const hostHeight = hostMetadata.height;
  const hostDPR = hostMetadata.devicePixelRatio || 1.0;

  // 1. Convert viewport coordinates to container-relative coordinates
  const pointerInsideContainerX = clientX - containerLeft;
  const pointerInsideContainerY = clientY - containerTop;

  // 2. Compute the CSS \`object-fit: contain\` rendered video dimensions and offset
  const {
    renderedWidth,
    renderedHeight,
    offsetX,
    offsetY,
    isPillarboxed,
    isLetterboxed,
  } = getContainedVideoRect(containerWidth, containerHeight, hostWidth, hostHeight);

  // 3. Subtract letterbox/pillarbox offset to get coordinates relative to active video stream
  const videoRelativeX = pointerInsideContainerX - offsetX;
  const videoRelativeY = pointerInsideContainerY - offsetY;

  // 4. Check whether click occurred within active video area or on the black letterbox borders
  const isOutOfBounds =
    videoRelativeX < 0 ||
    videoRelativeX > renderedWidth ||
    videoRelativeY < 0 ||
    videoRelativeY > renderedHeight;

  // 5. Clamp to [0, renderedWidth] and [0, renderedHeight] to avoid runaway values during drag/drop
  const clampedX = Math.max(0, Math.min(renderedWidth, videoRelativeX));
  const clampedY = Math.max(0, Math.min(renderedHeight, videoRelativeY));

  // 6. Calculate Normalized Unit Coordinates (u, v) ∈ [0.0, 1.0]
  const normalizedX = renderedWidth > 0 ? clampedX / renderedWidth : 0;
  const normalizedY = renderedHeight > 0 ? clampedY / renderedHeight : 0;

  // 7. Project onto Host Physical Monitor Pixels
  const hostPhysicalX = Math.round(normalizedX * hostWidth);
  const hostPhysicalY = Math.round(normalizedY * hostHeight);

  // 8. Project onto Host Logical Points (for nut-js OS automation on High-DPI screens)
  const hostLogicalX = Math.round(hostPhysicalX / hostDPR);
  const hostLogicalY = Math.round(hostPhysicalY / hostDPR);

  return {
    elementWidth: containerWidth,
    elementHeight: containerHeight,
    renderedWidth,
    renderedHeight,
    offsetX,
    offsetY,
    isPillarboxed,
    isLetterboxed,
    normalizedX: parseFloat(normalizedX.toFixed(6)),
    normalizedY: parseFloat(normalizedY.toFixed(6)),
    isOutOfBounds,
    hostPhysicalX,
    hostPhysicalY,
    hostLogicalX,
    hostLogicalY,
  };
}
`
  },
  {
    id: 'electron-main',
    filename: 'electron/main.ts',
    title: '4. Electron Main Process & Input Injection Engine',
    category: 'Electron',
    description: 'Production Electron main process integrating @nut-tree/nut-js OS automation, native mouse/keyboard injection, Kill-Switch safety override, and screen capture sources.',
    language: 'typescript',
    code: `import { app, BrowserWindow, ipcMain, desktopCapturer, screen, dialog } from 'electron';
import path from 'path';
import isDev from 'electron-is-dev';
import { mouse, keyboard, Key, Button, Point } from '@nut-tree/nut-js';

// Configure @nut-tree/nut-js for ultra-low latency input injection
mouse.config.autoDelayMs = 0;
mouse.config.mouseSpeed = 1000;
keyboard.config.autoDelayMs = 0;

let mainWindow: BrowserWindow | null = null;

// Remote Control Permission State
let isRemoteControlAllowed = false;
let activeRemoteClientId: string | null = null;

// ============================================================================
// KILL-SWITCH SAFETY SYSTEM
// ============================================================================
// If the Host physically moves their physical mouse, immediately suspend remote
// inputs for 2000ms to allow the Host to regain full OS control.
let isInputSuspended = false;
let suspendUntil = 0;
let lastKnownHostMousePos: { x: number; y: number } | null = null;
const SUSPEND_DURATION_MS = 2000;

function startHostKillSwitchMonitor() {
  setInterval(async () => {
    try {
      const currentPos = screen.getCursorScreenPoint();
      if (lastKnownHostMousePos) {
        const dx = Math.abs(currentPos.x - lastKnownHostMousePos.x);
        const dy = Math.abs(currentPos.y - lastKnownHostMousePos.y);

        // Host moved mouse manually (threshold > 15px to avoid jitter)
        if ((dx > 15 || dy > 15) && !isInjectingInput) {
          const now = Date.now();
          suspendUntil = now + SUSPEND_DURATION_MS;
          isInputSuspended = true;

          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('kill-switch-triggered', {
              suspendedUntil: suspendUntil,
            });
          }
        }
      }
      lastKnownHostMousePos = currentPos;
    } catch (err) {
      console.error('Kill switch poll error:', err);
    }
  }, 100);
}

let isInjectingInput = false;

function checkKillSwitch(): boolean {
  if (Date.now() < suspendUntil) {
    return true; // Input is suspended
  }
  isInputSuspended = false;
  return false;
}

// ============================================================================
// ELECTRON WINDOW CREATION
// ============================================================================
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: 'RemoteDesk - Ultra-Low Latency Remote Access',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,       // CRITICAL: Prevent XSS from accessing Node APIs
      nodeIntegration: false,        // CRITICAL: Disable Node in renderer
      sandbox: false,                // Needed for preload IPC bridge
      webSecurity: true,
    },
  });

  const url = isDev
    ? 'http://localhost:3000'
    : \`file://\${path.join(__dirname, '../dist/index.html')}\`;

  mainWindow.loadURL(url);

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  startHostKillSwitchMonitor();
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// ============================================================================
// IPC HANDLERS: SCREEN CAPTURE & METADATA
// ============================================================================

// 1. Get Primary Display Resolution & DPI scale
ipcMain.handle('get-primary-display-metadata', () => {
  const primaryDisplay = screen.getPrimaryDisplay();
  return {
    width: primaryDisplay.size.width * primaryDisplay.scaleFactor, // Physical width
    height: primaryDisplay.size.height * primaryDisplay.scaleFactor, // Physical height
    logicalWidth: primaryDisplay.size.width,
    logicalHeight: primaryDisplay.size.height,
    devicePixelRatio: primaryDisplay.scaleFactor,
    id: primaryDisplay.id.toString(),
  };
});

// 2. Get Desktop Capture Sources for WebRTC Screen Share
ipcMain.handle('get-screen-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 480, height: 270 },
  });

  return sources.map((src) => ({
    id: src.id,
    name: src.name,
    thumbnail: src.thumbnail.toDataURL(),
    displayId: src.display_id,
  }));
});

// 3. Security: Host Permission Dialog for Remote Control
ipcMain.handle('request-remote-permission', async (event, { clientName, clientId }) => {
  if (!mainWindow) return false;

  const result = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['Accept & Grant Control', 'Deny'],
    defaultId: 0,
    cancelId: 1,
    title: 'Remote Control Request',
    message: \`Incoming Remote Control Request\`,
    detail: \`"\${clientName || 'Remote Client'}" is requesting control of your keyboard and mouse.\\n\\nYou can override control at any time by moving your mouse.\`,
  });

  isRemoteControlAllowed = result.response === 0;
  if (isRemoteControlAllowed) {
    activeRemoteClientId = clientId;
  }
  return isRemoteControlAllowed;
});

ipcMain.handle('revoke-remote-permission', () => {
  isRemoteControlAllowed = false;
  activeRemoteClientId = null;
  return true;
});

// ============================================================================
// IPC HANDLERS: OS AUTOMATION INPUT INJECTION (@nut-tree/nut-js)
// ============================================================================

// Map JS button strings to nut-js Button enums
function getNutButton(button: 'left' | 'middle' | 'right'): Button {
  switch (button) {
    case 'middle': return Button.MIDDLE;
    case 'right': return Button.RIGHT;
    default: return Button.LEFT;
  }
}

// Map Web standard KeyboardEvent.code to nut-js Key enums
function mapKeyCodeToNutKey(code: string): Key | null {
  const codeMap: Record<string, Key> = {
    'KeyA': Key.A, 'KeyB': Key.B, 'KeyC': Key.C, 'KeyD': Key.D, 'KeyE': Key.E,
    'KeyF': Key.F, 'KeyG': Key.G, 'KeyH': Key.H, 'KeyI': Key.I, 'KeyJ': Key.J,
    'KeyK': Key.K, 'KeyL': Key.L, 'KeyM': Key.M, 'KeyN': Key.N, 'KeyO': Key.O,
    'KeyP': Key.P, 'KeyQ': Key.Q, 'KeyR': Key.R, 'KeyS': Key.S, 'KeyT': Key.T,
    'KeyU': Key.U, 'KeyV': Key.V, 'KeyW': Key.W, 'KeyX': Key.X, 'KeyY': Key.Y,
    'KeyZ': Key.Z,
    'Digit0': Key.Num0, 'Digit1': Key.Num1, 'Digit2': Key.Num2, 'Digit3': Key.Num3,
    'Digit4': Key.Num4, 'Digit5': Key.Num5, 'Digit6': Key.Num6, 'Digit7': Key.Num7,
    'Digit8': Key.Num8, 'Digit9': Key.Num9,
    'Enter': Key.Enter, 'Escape': Key.Escape, 'Backspace': Key.Backspace,
    'Tab': Key.Tab, 'Space': Key.Space, 'ArrowUp': Key.Up, 'ArrowDown': Key.Down,
    'ArrowLeft': Key.Left, 'ArrowRight': Key.Right, 'ControlLeft': Key.LeftControl,
    'ControlRight': Key.RightControl, 'ShiftLeft': Key.LeftShift, 'ShiftRight': Key.RightShift,
    'AltLeft': Key.LeftAlt, 'AltRight': Key.RightAlt, 'MetaLeft': Key.LeftSuper,
    'MetaRight': Key.RightSuper,
  };
  return codeMap[code] ?? null;
}

// 1. Mouse Movement Handler (Sub-millisecond direct injection)
ipcMain.on('inject-mouse-move', async (event, { x, y }) => {
  if (!isRemoteControlAllowed || checkKillSwitch()) return;

  try {
    isInjectingInput = true;
    const targetPoint = new Point(Math.round(x), Math.round(y));
    await mouse.setPosition(targetPoint);
    lastKnownHostMousePos = { x: targetPoint.x, y: targetPoint.y };
  } catch (err) {
    console.error('Error injecting mouse move:', err);
  } finally {
    isInjectingInput = false;
  }
});

// 2. Mouse Click / Mouse Down / Mouse Up Handler
ipcMain.on('inject-mouse-button', async (event, { type, button, clicks, x, y }) => {
  if (!isRemoteControlAllowed || checkKillSwitch()) return;

  try {
    isInjectingInput = true;
    if (typeof x === 'number' && typeof y === 'number') {
      await mouse.setPosition(new Point(Math.round(x), Math.round(y)));
      lastKnownHostMousePos = { x: Math.round(x), y: Math.round(y) };
    }

    const nutBtn = getNutButton(button);

    if (type === 'MOUSE_DOWN') {
      await mouse.pressButton(nutBtn);
    } else if (type === 'MOUSE_UP') {
      await mouse.releaseButton(nutBtn);
      if (clicks === 2) {
        await mouse.doubleClick(nutBtn);
      }
    }
  } catch (err) {
    console.error('Error injecting mouse button:', err);
  } finally {
    isInjectingInput = false;
  }
});

// 3. Mouse Wheel Scroll Handler
ipcMain.on('inject-mouse-wheel', async (event, { deltaX, deltaY }) => {
  if (!isRemoteControlAllowed || checkKillSwitch()) return;

  try {
    isInjectingInput = true;
    if (deltaY > 0) {
      await mouse.scrollDown(Math.abs(Math.round(deltaY / 20)));
    } else if (deltaY < 0) {
      await mouse.scrollUp(Math.abs(Math.round(deltaY / 20)));
    }
    if (deltaX > 0) {
      await mouse.scrollRight(Math.abs(Math.round(deltaX / 20)));
    } else if (deltaX < 0) {
      await mouse.scrollLeft(Math.abs(Math.round(deltaX / 20)));
    }
  } catch (err) {
    console.error('Error injecting mouse wheel:', err);
  } finally {
    isInjectingInput = false;
  }
});

// 4. Keyboard Keystroke Handler
ipcMain.on('inject-keyboard', async (event, { type, code }) => {
  if (!isRemoteControlAllowed || checkKillSwitch()) return;

  try {
    const nutKey = mapKeyCodeToNutKey(code);
    if (!nutKey) return;

    if (type === 'KEY_DOWN') {
      await keyboard.pressKey(nutKey);
    } else if (type === 'KEY_UP') {
      await keyboard.releaseKey(nutKey);
    }
  } catch (err) {
    console.error('Error injecting keyboard key:', err);
  }
});
`
  },
  {
    id: 'electron-preload',
    filename: 'electron/preload.ts',
    title: '5. Electron Preload Script (ContextBridge IPC)',
    category: 'Electron',
    description: 'Strictly-typed IPC bridge exposing native desktopCapturer sources, primary display resolution, and OS input injection to the React renderer securely.',
    language: 'typescript',
    code: `import { contextBridge, ipcRenderer } from 'electron';

export interface ScreenSource {
  id: string;
  name: string;
  thumbnail: string;
  displayId?: string;
}

export interface HostDisplayMetadata {
  width: number;
  height: number;
  logicalWidth: number;
  logicalHeight: number;
  devicePixelRatio: number;
  id: string;
}

export const electronAPI = {
  // Screen Sources
  getScreenSources: (): Promise<ScreenSource[]> => {
    return ipcRenderer.invoke('get-screen-sources');
  },

  // Display Resolution & Scale Factor
  getPrimaryDisplayMetadata: (): Promise<HostDisplayMetadata> => {
    return ipcRenderer.invoke('get-primary-display-metadata');
  },

  // Security Permissions
  requestRemotePermission: (payload: { clientName: string; clientId: string }): Promise<boolean> => {
    return ipcRenderer.invoke('request-remote-permission', payload);
  },

  revokeRemotePermission: (): Promise<boolean> => {
    return ipcRenderer.invoke('revoke-remote-permission');
  },

  onKillSwitchTriggered: (callback: (data: { suspendedUntil: number }) => void) => {
    const subscription = (_event: any, data: { suspendedUntil: number }) => callback(data);
    ipcRenderer.on('kill-switch-triggered', subscription);
    return () => ipcRenderer.removeListener('kill-switch-triggered', subscription);
  },

  // Input Injection (Called on Host when receiving WebRTC DataChannel packets)
  injectMouseMove: (coords: { x: number; y: number }) => {
    ipcRenderer.send('inject-mouse-move', coords);
  },

  injectMouseButton: (payload: {
    type: 'MOUSE_DOWN' | 'MOUSE_UP';
    button: 'left' | 'middle' | 'right';
    clicks?: number;
    x?: number;
    y?: number;
  }) => {
    ipcRenderer.send('inject-mouse-button', payload);
  },

  injectMouseWheel: (payload: { deltaX: number; deltaY: number }) => {
    ipcRenderer.send('inject-mouse-wheel', payload);
  },

  injectKeyboard: (payload: {
    type: 'KEY_DOWN' | 'KEY_UP';
    code: string;
    key: string;
  }) => {
    ipcRenderer.send('inject-keyboard', payload);
  },
};

// Expose safe, isolated API to React renderer window.electronAPI
contextBridge.exposeInMainWorld('electronAPI', electronAPI);

declare global {
  interface Window {
    electronAPI?: typeof electronAPI;
  }
}
`
  },
  {
    id: 'webrtc-hooks',
    filename: 'src/hooks/useWebRTCRemoteControl.ts',
    title: '6. WebRTC & RTCDataChannel React Hooks',
    category: 'WebRTC',
    description: 'React custom hooks for establishing low-latency WebRTC peer connections, RTCDataChannel tuning (ordered vs unordered), and high-frequency input batching.',
    language: 'typescript',
    code: `import { useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import {
  RemoteControlPacket,
  HostScreenMetadata,
  RemoteMouseMovePayload,
  RemoteMouseButtonPayload,
  RemoteKeyboardPayload,
} from '../types/remoteControl';
import { calculateRemoteCoordinates } from '../utils/coordinateMath';

interface UseWebRTCClientOptions {
  signalingUrl: string;
  roomId: string;
  onHostMetadataReceived?: (metadata: HostScreenMetadata) => void;
}

export function useWebRTCClient({ signalingUrl, roomId, onHostMetadataReceived }: UseWebRTCClientOptions) {
  const [isConnected, setIsConnected] = useState(false);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [hostMetadata, setHostMetadata] = useState<HostScreenMetadata | null>(null);
  const [isControlActive, setIsControlActive] = useState(false);
  const [latencyMs, setLatencyMs] = useState<number>(0);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const dataChannelUnreliableRef = useRef<RTCDataChannel | null>(null); // For MOUSE_MOVE (ordered: false, maxRetransmits: 0)
  const dataChannelReliableRef = useRef<RTCDataChannel | null>(null);   // For CLICKS, KEYS, PERMISSIONS (ordered: true)

  // Throttle mouse moves to ~60fps (16ms) to prevent network buffer congestion
  const lastMouseMoveTimeRef = useRef<number>(0);

  useEffect(() => {
    const socket = io(signalingUrl);
    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('Connected to signaling server');
      socket.emit('join-room', { roomId }, (response: any) => {
        if (!response.success) {
          console.error('Failed to join room:', response.message);
          return;
        }

        if (response.hostMetadata) {
          setHostMetadata(response.hostMetadata);
          onHostMetadataReceived?.(response.hostMetadata);
        }

        initializePeerConnection(response.iceServers);
      });
    });

    socket.on('sdp-offer', async ({ sdp }) => {
      if (!pcRef.current) return;
      await pcRef.current.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await pcRef.current.createAnswer();
      await pcRef.current.setLocalDescription(answer);
      socket.emit('sdp-answer', { roomId, sdp: answer });
    });

    socket.on('ice-candidate', async ({ candidate }) => {
      if (pcRef.current && candidate) {
        await pcRef.current.addIceCandidate(new RTCIceCandidate(candidate));
      }
    });

    socket.on('host-metadata-updated', (meta: HostScreenMetadata) => {
      setHostMetadata(meta);
      onHostMetadataReceived?.(meta);
    });

    return () => {
      socket.disconnect();
      pcRef.current?.close();
    };
  }, [signalingUrl, roomId]);

  const initializePeerConnection = (iceServersConfig: RTCConfiguration) => {
    const pc = new RTCPeerConnection(iceServersConfig);
    pcRef.current = pc;

    // Handle Incoming Screen Stream
    pc.ontrack = (event) => {
      if (event.streams && event.streams[0]) {
        setRemoteStream(event.streams[0]);
        setIsConnected(true);
      }
    };

    // ICE Candidate Exchange
    pc.onicecandidate = (event) => {
      if (event.candidate && socketRef.current) {
        socketRef.current.emit('ice-candidate', { roomId, candidate: event.candidate });
      }
    };

    // 1. Unreliable DataChannel for High-Frequency Mouse Moves (Zero retransmission delay)
    const dcUnreliable = pc.createDataChannel('control-mouse-moves', {
      ordered: false,
      maxRetransmits: 0,
    });
    dataChannelUnreliableRef.current = dcUnreliable;

    // 2. Reliable DataChannel for Critical Input (Clicks, Keystrokes, Commands)
    const dcReliable = pc.createDataChannel('control-reliable-events', {
      ordered: true,
    });
    dcReliable.onopen = () => setIsControlActive(true);
    dcReliable.onclose = () => setIsControlActive(false);
    dcReliable.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'PONG') {
          setLatencyMs(Date.now() - msg.clientTimestamp);
        }
      } catch (err) {}
    };
    dataChannelReliableRef.current = dcReliable;
  };

  // Send Mouse Move Event
  const sendMouseMove = useCallback((normX: number, normY: number) => {
    const now = performance.now();
    if (now - lastMouseMoveTimeRef.current < 16) return; // 60fps limit
    lastMouseMoveTimeRef.current = now;

    const packet: RemoteMouseMovePayload = {
      type: 'MOUSE_MOVE',
      normX,
      normY,
      timestamp: Date.now(),
    };

    if (dataChannelUnreliableRef.current?.readyState === 'open') {
      dataChannelUnreliableRef.current.send(JSON.stringify(packet));
    }
  }, []);

  // Send Mouse Button Event (Click / Down / Up)
  const sendMouseButton = useCallback((
    type: 'MOUSE_DOWN' | 'MOUSE_UP',
    button: 'left' | 'middle' | 'right',
    normX: number,
    normY: number,
    clicks = 1
  ) => {
    const packet: RemoteMouseButtonPayload = {
      type,
      button,
      normX,
      normY,
      clicks,
      timestamp: Date.now(),
    };

    if (dataChannelReliableRef.current?.readyState === 'open') {
      dataChannelReliableRef.current.send(JSON.stringify(packet));
    }
  }, []);

  // Send Keyboard Event
  const sendKeyboard = useCallback((
    type: 'KEY_DOWN' | 'KEY_UP',
    e: React.KeyboardEvent
  ) => {
    const packet: RemoteKeyboardPayload = {
      type,
      key: e.key,
      code: e.code,
      altKey: e.altKey,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      metaKey: e.metaKey,
      timestamp: Date.now(),
    };

    if (dataChannelReliableRef.current?.readyState === 'open') {
      dataChannelReliableRef.current.send(JSON.stringify(packet));
    }
  }, []);

  return {
    isConnected,
    remoteStream,
    hostMetadata,
    isControlActive,
    latencyMs,
    sendMouseMove,
    sendMouseButton,
    sendKeyboard,
  };
}
`
  }
];
