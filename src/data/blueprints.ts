export interface BlueprintFile {
  id: string;
  filename: string;
  title: string;
  category: 'Native' | 'Signaling' | 'Math' | 'WebRTC' | 'Setup';
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
    description: 'Toolchain, per-OS build dependencies, and the packaging commands that produce Windows and Linux installers.',
    language: 'markdown',
    code: `# Build & Packaging Guide

## Prerequisites

- Node.js 20+
- A Rust toolchain (https://rustup.rs)

Windows additionally needs the WebView2 Runtime, which ships with Windows 11 and
current Windows 10. Nothing else.

Debian/Ubuntu needs the webview and the input-injection backends:

\`\`\`bash
sudo apt-get install -y \\
  libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \\
  librsvg2-dev libxkbcommon-dev libwayland-dev libdbus-1-dev \\
  libssl-dev build-essential
\`\`\`

## Install and run

\`\`\`bash
npm install
npm run dev          # Tauri dev: Rust host + Vite frontend
\`\`\`

The app embeds its own signaling server, so nothing else has to be running.

## Key dependencies

\`\`\`jsonc
// package.json - the frontend has no signaling library at all; the client is
// ~200 lines of WebSocket in src/utils/signaling.ts.
"dependencies": {
  "@tauri-apps/api": "^2.1.1",
  "react": "^19.0.1",
  "lucide-react": "^0.546.0"
}
\`\`\`

\`\`\`toml
# src-tauri/Cargo.toml
[dependencies]
tauri = { version = "2", features = ["tray-icon", "image-png"] }
enigo = "0.6"                     # OS-level input injection
axum = { version = "0.8", features = ["ws", "json"] }   # embedded signaling
tokio = { version = "1", features = ["rt-multi-thread", "net", "time"] }

# enigo defaults to X11 only. wayland adds the wlroots virtual-input protocols
# and libei_tokio the portal-based route, together covering the mainstream
# Wayland compositors. webkit2gtk is needed to switch on the webview settings
# that screen capture depends on.
[target.'cfg(target_os = "linux")'.dependencies]
enigo = { version = "0.6", features = ["wayland", "libei_tokio"] }
webkit2gtk = { version = "=2.0.2", features = ["v2_38"] }
\`\`\`

## Package installers

\`\`\`bash
npm run package
\`\`\`

Tauri builds for the machine it runs on: NSIS \`.exe\` on Windows,
\`.deb\` / \`.rpm\` / \`.AppImage\` on Linux. Output lands in
\`src-tauri/target/release/bundle/\`.

## Checks

\`\`\`bash
npm run lint             # tsc (app + server) and clippy -D warnings
npm test                 # frontend unit tests
npm run test:rust        # Rust unit tests
npm run check:signaling  # protocol conformance against a running server
\`\`\`

The conformance suite runs against either signaling implementation - the
embedded Rust one or the standalone Node relay - which is what keeps a Windows
host and a Linux client speaking the same protocol.
`
  },
  {
    id: 'signaling-server',
    filename: 'src-tauri/src/signaling.rs',
    title: '2. Embedded Signaling Server (Rust)',
    category: 'Signaling',
    description: 'The rendezvous point carrying SDP offers, answers and ICE candidates between peers. It runs inside the app itself, so an installed RemoteDesk can host with no other process running. Media never passes through it.',
    language: 'rust',
    code: `// Wire protocol: {"event": string, "data": value} as JSON over a WebSocket
// at /rtc. src/utils/signaling.ts is the matching client, and server/index.ts
// is an optional standalone relay speaking the same protocol.

struct Room {
    room_id: String,
    host: PeerId,
    clients: HashSet<PeerId>,
    /// AnyDesk-style plug-and-play: clients are admitted without prompting.
    unattended: bool,
    pin: Option<String>,
}

/// Resolves who should receive a signaling frame from peer_id. Both frame
/// shapes go through this, so the room-membership check cannot be bypassed by
/// using the other one.
fn signal_targets(hub: &Hub, peer_id: &str, target_id: Option<&str>) -> (Vec<PeerId>, String) {
    let Some(room) = hub.room_of(peer_id) else {
        return (Vec::new(), String::new());
    };
    let room_id = room.room_id.clone();

    if let Some(target) = target_id {
        // Only ever address a peer that is actually in the same room.
        let is_peer = room.host == target || room.clients.contains(target);
        let targets = if is_peer { vec![target.to_string()] } else { Vec::new() };
        return (targets, room_id);
    }

    // Untargeted frames go to the opposite role.
    let targets = if room.host == peer_id {
        room.clients.iter().cloned().collect()
    } else {
        vec![room.host.clone()]
    };
    (targets, room_id)
}

/// Binds 4000, walking up to 4009 so a second instance on the same machine
/// still comes up. The bound port is reported to the frontend at startup.
pub fn start() -> Result<SignalingHandle, String> {
    // axum router: /healthz, /network-info, /api/tunnel/start, /rtc
}
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

  // 8. Project onto Host Logical Points (for OS injection on High-DPI screens)
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
    id: 'native-input',
    filename: 'src-tauri/src/input.rs',
    title: '4. Native Input Injection & Authorization Gate (Rust)',
    category: 'Native',
    description: 'OS-level mouse and keyboard injection via enigo, behind the security boundary of the whole app: two pieces of state the webview cannot reach gate every single injection.',
    language: 'rust',
    code: `/// How long remote injection stays suspended after physical host input.
pub const KILL_SWITCH_COOLDOWN_MS: u64 = 2_500;

/// Cursor displacement that counts as deliberate physical movement rather than
/// rounding drift from our own injection.
const PHYSICAL_MOVEMENT_THRESHOLD_PX: i32 = 12;

impl InputState {
    /// The single gate every injection passes through. A compromised or buggy
    /// renderer cannot inject input the host has not authorized.
    fn authorize(&self) -> Result<(), String> {
        if !self.control_enabled.load(Ordering::SeqCst) {
            return Err("remote control is not authorized by the host".into());
        }
        let remaining = self.suspended_remaining_ms();
        if remaining > 0 {
            return Err(format!("kill switch active - suspended for {remaining}ms"));
        }
        Ok(())
    }

    /// Projects normalized [0,1] stream coordinates onto absolute desktop
    /// pixels, so the client never needs to know the host resolution.
    fn resolve(&self, norm_x: f64, norm_y: f64) -> (i32, i32) {
        let rect = self.target();
        let nx = norm_x.clamp(0.0, 1.0);
        let ny = norm_y.clamp(0.0, 1.0);
        // Subtract one pixel so norm = 1.0 lands on the last addressable pixel
        // rather than one past the edge of the monitor.
        let x = rect.x + (nx * (rect.width - 1).max(0) as f64).round() as i32;
        let y = rect.y + (ny * (rect.height - 1).max(0) as f64).round() as i32;
        (x, y)
    }

    pub fn move_mouse(&self, norm_x: f64, norm_y: f64) -> Result<(), String> {
        self.authorize()?;
        let (x, y) = self.resolve(norm_x, norm_y);
        self.with_enigo(|e| {
            e.move_mouse(x, y, Coordinate::Abs)
                .map_err(|err| format!("move_mouse failed: {err}"))
        })?;
        self.remember_injected(x, y);
        Ok(())
    }

    /// Reads the live cursor and reports whether it diverged from where we last
    /// put it - i.e. whether a human at the host machine moved the mouse.
    pub fn detect_physical_movement(&self) -> Option<(i32, i32)> {
        let expected_x = self.last_injected_x.load(Ordering::SeqCst);
        let expected_y = self.last_injected_y.load(Ordering::SeqCst);
        let (ax, ay) = self.with_enigo(|e| e.location().map_err(|e| e.to_string())).ok()?;

        if (ax - expected_x).abs() >= PHYSICAL_MOVEMENT_THRESHOLD_PX
            || (ay - expected_y).abs() >= PHYSICAL_MOVEMENT_THRESHOLD_PX
        {
            // Re-baseline so one physical nudge does not retrigger every poll.
            self.remember_injected(ax, ay);
            return Some((ax, ay));
        }
        None
    }
}
`
  },
  {
    id: 'platform-capabilities',
    filename: 'src-tauri/src/platform.rs',
    title: '5. Per-Platform Webview & Capability Setup (Rust)',
    category: 'Native',
    description: 'Capture and injection have materially different constraints per OS, and on Linux per display server. This enables what the Linux webview needs and reports what is actually detectable at runtime, rather than asserting capabilities it cannot verify.',
    language: 'rust',
    code: `// WebKitGTK ships enable-media-stream and enable-webrtc OFF by default, and
// neither Tauri nor wry turns them on. Without this, navigator.mediaDevices and
// RTCPeerConnection simply do not exist in the Linux webview, so a Linux machine
// can neither host nor connect. Windows (WebView2) needs none of it.
#[cfg(target_os = "linux")]
fn enable_linux_media_capture(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else { return };

    let _ = window.with_webview(|webview| {
        use webkit2gtk::{SettingsExt, WebViewExt};
        if let Some(settings) = WebViewExt::settings(&webview.inner()) {
            settings.set_enable_media_stream(true);
            settings.set_enable_mediasource(true);
            settings.set_enable_webrtc(true);
        }
    });
}

#[cfg(target_os = "linux")]
fn linux_diagnostics() -> Diagnostics {
    let is_wayland = std::env::var("XDG_SESSION_TYPE").unwrap_or_default() == "wayland"
        || std::env::var("WAYLAND_DISPLAY").is_ok();

    // Under Wayland there is no XTest. Injection goes through either the
    // RemoteDesktop portal (GNOME, KDE) or the wlroots virtual-input protocols
    // (Sway, Hyprland) - both compiled in, chosen at runtime.
    let mut notes = Vec::new();
    if is_wayland {
        notes.push("Wayland: capture via xdg-desktop-portal and PipeWire.".to_string());
    } else {
        notes.push("X11: XTest injection needs no extra permission.".to_string());
    }
    // ...
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
import { io, Socket } from '../utils/signaling';
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
