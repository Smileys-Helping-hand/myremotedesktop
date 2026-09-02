import { useState, useEffect, useRef, useCallback } from 'react';
import { io, Socket } from '../utils/signaling';
import {
  RemoteControlPacket,
  RemoteMouseMovePayload,
} from '../types/remoteControl';

export interface WebRTCOptions {
  role?: 'host' | 'client';
  roomId?: string;
  localStream?: MediaStream | null;
  serverUrl?: string;
  unattended?: boolean;
  pin?: string;
  onRemotePacket?: (packet: RemoteControlPacket) => void;
  onRemoteMouse?: (packet: RemoteMouseMovePayload) => void;
  iceServers?: RTCIceServer[];
}

export interface WebRTCStats {
  rttMs: number;
  fps: number;
  bitrateKbps: number;
  packetsSent: number;
  packetsReceived: number;
  resolution: { width: number; height: number };
}

// Local in-browser BroadcastChannel bus for testing in multiple tabs
class LocalSignalingBus {
  private channel: BroadcastChannel | null = null;
  private listeners: Set<(msg: any) => void> = new Set();

  constructor() {
    if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
      try {
        this.channel = new BroadcastChannel('remotedesk_signaling_bus');
        this.channel.onmessage = (event) => {
          const msg = event.data;
          this.listeners.forEach((listener) => listener(msg));
        };
      } catch (err) {
        console.warn('BroadcastChannel not supported:', err);
      }
    }
  }

  public send(msg: any) {
    if (this.channel) {
      try {
        this.channel.postMessage(msg);
      } catch (e) {
        // ignore clone error
      }
    }
  }

  public subscribe(listener: (msg: any) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

const localSignaling = new LocalSignalingBus();

/**
 * STUN servers used to discover this peer's public address.
 *
 * STUN alone is enough for the large majority of internet sessions: two peers
 * behind ordinary home routers can hole-punch a direct path once each knows its
 * own reflexive address, and the media then flows peer-to-peer.
 *
 * There is deliberately **no TURN server in this list**. TURN relays the actual
 * video, so it needs a server with a public IP and real bandwidth; the free
 * public relays that used to be pasted into projects like this one no longer
 * accept anonymous allocations, and shipping credentials that fail is worse
 * than shipping none — it looks like relay coverage exists when it does not.
 * `remotedesk_ice_servers` in localStorage overrides this whole list; see
 * `getCustomIceServers`, and the README for standing one up.
 */
export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

/**
 * Origin of the signaling server this app embeds, once resolved at startup.
 *
 * Cached at module scope so the URL getters can stay synchronous — the Tauri
 * command that reports it is async, and `useWebRTC` needs a URL at first render.
 */
/** Port the embedded server and the standalone relay both start from. */
const DEFAULT_SIGNAL_PORT = 4000;
/** Vite's dev server serves the frontend only; signaling lives elsewhere. */
const VITE_DEV_PORT = '1420';

let embeddedSignalUrl: string | null = null;

/** Called once during boot with the embedded server origin, or `null`. */
export function setEmbeddedSignalUrl(url: string | null): void {
  embeddedSignalUrl = url;
}

/**
 * Last-resort guess when no server has been chosen explicitly.
 *
 * A page served over http(s) was almost certainly served *by* a signaling
 * server — the host's embedded one, the standalone relay, or a quick tunnel —
 * so the origin it came from is the right place to signal back to. Taking the
 * whole origin rather than rebuilding it keeps the actual port (the embedded
 * server scans upward from 4000 when the port is taken, and the relay honours
 * `SIGNAL_PORT`) and the actual scheme, which matters over an https tunnel
 * where forcing `http:` would be blocked as mixed content.
 *
 * Two origins are not servers and fall back to the default port: Tauri's custom
 * protocol, and the Vite dev server, which only serves the frontend.
 */
function originSignalUrl(): string {
  const { protocol, origin, hostname, port } = window.location;
  const isHttp = protocol === 'http:' || protocol === 'https:';
  if (isHttp && port !== VITE_DEV_PORT) return origin;
  return `http://${hostname || 'localhost'}:${DEFAULT_SIGNAL_PORT}`;
}

/**
 * Signaling origin for *joining* a session. A URL the operator typed in the
 * client wins, because the client must meet the host on the host's server.
 */
export function getDefaultSignalUrl(): string {
  if (typeof window === 'undefined') return `http://localhost:${DEFAULT_SIGNAL_PORT}`;
  const saved = localStorage.getItem('remotedesk_signal_url');
  if (saved) return saved;
  if (embeddedSignalUrl) return embeddedSignalUrl;
  return originSignalUrl();
}

/**
 * Signaling origin for *hosting* a session — always this machine's own server.
 *
 * A URL saved from a previous outbound connection must not redirect our own
 * hosting to someone else's rendezvous point: the room would be registered on a
 * server no client of ours is looking at, and the session would simply never
 * connect with nothing to explain why.
 *
 * The origin is therefore consulted *before* the saved URL, not after. That
 * ordering matters on Linux, where the host UI runs as a browser page served by
 * the embedded server: there is no Tauri IPC to report the server's address, so
 * `embeddedSignalUrl` is null and the serving origin is the only correct
 * answer available.
 */
export function getHostSignalUrl(): string {
  if (typeof window === 'undefined') return `http://localhost:${DEFAULT_SIGNAL_PORT}`;
  if (embeddedSignalUrl) return embeddedSignalUrl;

  const { protocol, port } = window.location;
  const servedByASignalingServer =
    (protocol === 'http:' || protocol === 'https:') && port !== VITE_DEV_PORT;
  if (servedByASignalingServer) return window.location.origin;

  const saved = localStorage.getItem('remotedesk_signal_url');
  if (saved) return saved;
  return originSignalUrl();
}

export function getCustomIceServers(): RTCIceServer[] {
  if (typeof window === 'undefined') return DEFAULT_ICE_SERVERS;
  try {
    const saved = localStorage.getItem('remotedesk_ice_servers');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch {}
  return DEFAULT_ICE_SERVERS;
}

export function useWebRTC(options: WebRTCOptions = {}) {
  const {
    role: initialRole,
    roomId: initialRoomId,
    localStream,
    serverUrl = getDefaultSignalUrl(),
    unattended = true,
    pin: initialPin,
    onRemotePacket,
    onRemoteMouse,
    iceServers = getCustomIceServers(),
  } = options;

  // State
  const [role, setRole] = useState<'host' | 'client' | null>(initialRole || null);
  const [roomId, setRoomId] = useState<string | null>(initialRoomId || null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [connectionState, setConnectionState] = useState<RTCPeerConnectionState>('new');
  const [iceConnectionState, setIceConnectionState] = useState<RTCIceConnectionState>('new');
  const [signalingState, setSignalingState] = useState<RTCSignalingState>('stable');
  const [isSocketConnected, setIsSocketConnected] = useState<boolean>(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [dataChannelsReady, setDataChannelsReady] = useState<{ mouse: boolean; events: boolean }>({
    mouse: false,
    events: false,
  });

  const [stats, setStats] = useState<WebRTCStats>({
    rttMs: 12,
    fps: 60,
    bitrateKbps: 4500,
    packetsSent: 0,
    packetsReceived: 0,
    resolution: { width: 1920, height: 1080 },
  });

  const [lastReceivedMousePacket, setLastReceivedMousePacket] = useState<RemoteMouseMovePayload | null>(null);
  const [lastReceivedEventPacket, setLastReceivedEventPacket] = useState<RemoteControlPacket | null>(null);

  // References
  const roleRef = useRef<'host' | 'client' | null>(initialRole || null);
  const roomIdRef = useRef<string | null>(initialRoomId || null);
  const remotePeerIdRef = useRef<string | null>(null);
  const onRemotePacketRef = useRef(onRemotePacket);
  const onRemoteMouseRef = useRef(onRemoteMouse);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const mouseChannelRef = useRef<RTCDataChannel | null>(null);
  const eventsChannelRef = useRef<RTCDataChannel | null>(null);
  const localStreamRef = useRef<MediaStream | null>(localStream || null);
  const localClientIdRef = useRef<string>(`peer_${Math.random().toString(36).substring(2, 9)}`);
  const iceCandidatesQueueRef = useRef<RTCIceCandidateInit[]>([]);
  const statsIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const unattendedRef = useRef<boolean>(unattended);
  const pinRef = useRef<string | undefined>(initialPin);

  // Mutable packet counters
  const packetsSentRef = useRef<number>(0);
  const packetsReceivedRef = useRef<number>(0);

  // Sync references
  useEffect(() => {
    roleRef.current = role;
  }, [role]);

  useEffect(() => {
    roomIdRef.current = roomId;
  }, [roomId]);

  useEffect(() => {
    unattendedRef.current = unattended;
  }, [unattended]);

  useEffect(() => {
    pinRef.current = initialPin;
  }, [initialPin]);

  useEffect(() => {
    onRemotePacketRef.current = onRemotePacket;
  }, [onRemotePacket]);

  useEffect(() => {
    onRemoteMouseRef.current = onRemoteMouse;
  }, [onRemoteMouse]);

  // Sync localStream reference and update active peer connection tracks
  useEffect(() => {
    localStreamRef.current = localStream || null;
    const pc = peerConnectionRef.current;
    if (pc && localStream) {
      const senders = pc.getSenders();
      localStream.getTracks().forEach((track) => {
        const existingSender = senders.find((s) => s.track?.kind === track.kind);
        if (existingSender) {
          existingSender.replaceTrack(track).catch((err) => {
            console.warn('[WebRTC] replaceTrack error:', err);
          });
        } else {
          try {
            pc.addTrack(track, localStream);
          } catch (e) {
            // track already added
          }
        }
      });
    }
  }, [localStream]);

  // Clean up PeerConnection
  const cleanupPeerConnection = useCallback(() => {
    if (statsIntervalRef.current) {
      clearInterval(statsIntervalRef.current);
      statsIntervalRef.current = null;
    }

    if (mouseChannelRef.current) {
      try {
        mouseChannelRef.current.onopen = null;
        mouseChannelRef.current.onclose = null;
        mouseChannelRef.current.onerror = null;
        mouseChannelRef.current.onmessage = null;
        if (mouseChannelRef.current.readyState === 'open' || mouseChannelRef.current.readyState === 'connecting') {
          mouseChannelRef.current.close();
        }
      } catch (e) {
        // ignore
      }
      mouseChannelRef.current = null;
    }

    if (eventsChannelRef.current) {
      try {
        eventsChannelRef.current.onopen = null;
        eventsChannelRef.current.onclose = null;
        eventsChannelRef.current.onerror = null;
        eventsChannelRef.current.onmessage = null;
        if (eventsChannelRef.current.readyState === 'open' || eventsChannelRef.current.readyState === 'connecting') {
          eventsChannelRef.current.close();
        }
      } catch (e) {
        // ignore
      }
      eventsChannelRef.current = null;
    }

    if (peerConnectionRef.current) {
      peerConnectionRef.current.ontrack = null;
      peerConnectionRef.current.onicecandidate = null;
      peerConnectionRef.current.ondatachannel = null;
      peerConnectionRef.current.onconnectionstatechange = null;
      peerConnectionRef.current.oniceconnectionstatechange = null;
      peerConnectionRef.current.onsignalingstatechange = null;
      try {
        peerConnectionRef.current.close();
      } catch (e) {
        // ignore
      }
      peerConnectionRef.current = null;
    }

    iceCandidatesQueueRef.current = [];
    setRemoteStream(null);
    setConnectionState('closed');
    setIceConnectionState('closed');
    setDataChannelsReady({ mouse: false, events: false });
  }, []);

  // Send Signaling Message
  const sendSignalingMessage = useCallback(
    (msg: {
      type: 'offer' | 'answer' | 'ice-candidate' | 'peer-joined' | 'peer-left' | 'leave';
      roomId?: string;
      targetId?: string;
      senderId?: string;
      data?: any;
    }) => {
      const socket = socketRef.current;
      const targetRoomId = msg.roomId || roomIdRef.current || '';
      const payload = {
        ...msg,
        roomId: targetRoomId,
        senderId: localClientIdRef.current,
        targetId: msg.targetId || remotePeerIdRef.current,
      };

      if (socket && socket.connected) {
        // Send via unified signal event
        if (msg.type === 'offer' || msg.type === 'answer' || msg.type === 'ice-candidate') {
          socket.emit('signal', {
            targetId: payload.targetId,
            kind: msg.type,
            data: msg.data,
          });
        }
        // Also emit directly for full backward compatibility
        socket.emit(msg.type, payload);
      }

      // BroadcastChannel local bus fallback
      localSignaling.send(payload);
    },
    []
  );

  // Setup Data Channel event listeners
  const setupDataChannelEvents = useCallback(
    (channel: RTCDataChannel, type: 'mouse' | 'events') => {
      channel.onopen = () => {
        setDataChannelsReady((prev) => ({
          ...prev,
          [type]: true,
        }));
      };

      channel.onclose = () => {
        setDataChannelsReady((prev) => ({
          ...prev,
          [type]: false,
        }));
      };

      channel.onerror = (err) => {
        console.warn(`RTCDataChannel [${channel.label}] error:`, err);
      };

      channel.onmessage = (event) => {
        try {
          const packet = JSON.parse(event.data) as RemoteControlPacket;
          packetsReceivedRef.current += 1;

          if (packet.type === 'MOUSE_MOVE') {
            setLastReceivedMousePacket(packet);
            if (onRemoteMouseRef.current) {
              onRemoteMouseRef.current(packet);
            }
          } else {
            setLastReceivedEventPacket(packet);
          }

          if (onRemotePacketRef.current) {
            onRemotePacketRef.current(packet);
          }
        } catch (err) {
          console.error(`Failed to parse data on channel ${channel.label}:`, err);
        }
      };
    },
    []
  );

  // Create PeerConnection
  const createPeerConnection = useCallback(
    (targetRoomId: string, currentRole: 'host' | 'client'): RTCPeerConnection => {
      cleanupPeerConnection();

      const pc = new RTCPeerConnection({
        iceServers,
        iceCandidatePoolSize: 4,
      });
      peerConnectionRef.current = pc;

      // Handle Connection State changes
      pc.onconnectionstatechange = () => {
        setConnectionState(pc.connectionState);
      };

      pc.oniceconnectionstatechange = () => {
        setIceConnectionState(pc.iceConnectionState);
      };

      pc.onsignalingstatechange = () => {
        setSignalingState(pc.signalingState);
      };

      // Renegotiation.
      //
      // The Desk ID is live from the moment the host opens the app, so a client
      // can already be connected when the operator picks a screen to share.
      // `addTrack` then fires this. Without it the track joins the connection
      // but is never negotiated, and the client sits on a black frame forever.
      //
      // Only the host offers, only once there is a peer to offer to, and only
      // while the connection is idle — renegotiating mid-handshake would
      // clobber an in-flight description.
      pc.onnegotiationneeded = async () => {
        if (currentRole !== 'host') return;
        const peerId = remotePeerIdRef.current;
        if (!peerId || pc.signalingState !== 'stable') return;

        try {
          const offer = await pc.createOffer();
          // State can move while createOffer awaits.
          if (pc.signalingState !== 'stable') return;
          await pc.setLocalDescription(offer);
          sendSignalingMessage({
            type: 'offer',
            roomId: roomIdRef.current || undefined,
            targetId: peerId,
            data: offer,
          });
        } catch (err) {
          console.warn('[WebRTC] renegotiation failed:', err);
        }
      };

      // ICE Candidates
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          sendSignalingMessage({
            type: 'ice-candidate',
            roomId: targetRoomId,
            targetId: remotePeerIdRef.current || undefined,
            data: event.candidate.toJSON(),
          });
        }
      };

      // Remote Track (Client receiving Host's screen)
      pc.ontrack = (event) => {
        if (event.streams && event.streams[0]) {
          setRemoteStream(event.streams[0]);
          const videoTrack = event.streams[0].getVideoTracks()[0];
          if (videoTrack) {
            const settings = videoTrack.getSettings();
            if (settings.width && settings.height) {
              setStats((prev) => ({
                ...prev,
                resolution: { width: settings.width || 1920, height: settings.height || 1080 },
              }));
            }
          }
        }
      };

      // If HOST: Add local media stream and create data channels
      if (currentRole === 'host') {
        if (localStreamRef.current) {
          localStreamRef.current.getTracks().forEach((track) => {
            try {
              pc.addTrack(track, localStreamRef.current!);
            } catch (e) {
              // ignore
            }
          });
        }

        // 1. Channel A: Unreliable, Unordered for low-latency mouse coordinates (UDP mode)
        const mouseChannel = pc.createDataChannel('channel-mouse', {
          ordered: false,
          maxRetransmits: 0,
        });
        mouseChannelRef.current = mouseChannel;
        setupDataChannelEvents(mouseChannel, 'mouse');

        // 2. Channel B: Reliable, Ordered for clicks & keystrokes (TCP mode)
        const eventsChannel = pc.createDataChannel('channel-events', {
          ordered: true,
        });
        eventsChannelRef.current = eventsChannel;
        setupDataChannelEvents(eventsChannel, 'events');
      } else {
        // If CLIENT: Listen for incoming data channels created by Host
        pc.ondatachannel = (event) => {
          const channel = event.channel;
          if (channel.label === 'channel-mouse') {
            mouseChannelRef.current = channel;
            setupDataChannelEvents(channel, 'mouse');
          } else if (channel.label === 'channel-events') {
            eventsChannelRef.current = channel;
            setupDataChannelEvents(channel, 'events');
          }
        };
      }

      // WebRTC Stats Monitor Loop
      statsIntervalRef.current = setInterval(async () => {
        if (pc && pc.connectionState === 'connected') {
          try {
            const reports = await pc.getStats();
            let currentRtt = 12;
            let currentFps = 60;
            let currentBitrate = 4500;

            reports.forEach((report) => {
              if (report.type === 'candidate-pair' && report.currentRoundTripTime) {
                currentRtt = Math.round(report.currentRoundTripTime * 1000);
              }
              if (report.type === 'inbound-rtp' && report.kind === 'video') {
                currentFps = report.framesPerSecond || 60;
                currentBitrate = Math.round((report.bytesReceived * 8) / 1000 / 10) || 4500;
              }
            });

            setStats((prev) => ({
              ...prev,
              rttMs: currentRtt,
              fps: currentFps,
              bitrateKbps: currentBitrate,
              packetsSent: packetsSentRef.current,
              packetsReceived: packetsReceivedRef.current,
            }));
          } catch (e) {
            // Ignore stats poll error
          }
        }
      }, 1000);

      return pc;
    },
    [cleanupPeerConnection, iceServers, sendSignalingMessage, setupDataChannelEvents]
  );

  // Helper: Flush queued ICE candidates
  const drainIceCandidates = async (pc: RTCPeerConnection) => {
    while (iceCandidatesQueueRef.current.length > 0) {
      const candidate = iceCandidatesQueueRef.current.shift();
      if (candidate) {
        try {
          await pc.addIceCandidate(candidate);
        } catch (e) {
          console.warn('[WebRTC] Error adding queued ICE candidate:', e);
        }
      }
    }
  };

  // Handle incoming signaling message
  const handleSignaling = useCallback(
    async (kind: string, payload: any) => {
      const currentRoomId = roomIdRef.current;
      const currentRole = roleRef.current;
      const data = payload?.data ?? payload;
      const senderId = payload?.fromId || payload?.senderId;

      if (senderId && senderId === localClientIdRef.current) return;
      if (payload?.roomId && currentRoomId && payload.roomId !== currentRoomId) return;

      if (senderId) {
        remotePeerIdRef.current = senderId;
      }

      let pc = peerConnectionRef.current;

      switch (kind) {
        case 'peer-joined':
        case 'peer:joined': {
          const peerId = payload?.peerId || senderId;
          if (peerId) remotePeerIdRef.current = peerId;

          // If HOST and Client joined, initiate WebRTC Offer
          if (currentRole === 'host') {
            if (!pc) {
              pc = createPeerConnection(currentRoomId || 'default', 'host');
            }
            try {
              const offer = await pc.createOffer({
                offerToReceiveVideo: false,
                offerToReceiveAudio: false,
              });
              await pc.setLocalDescription(offer);
              sendSignalingMessage({
                type: 'offer',
                roomId: currentRoomId || undefined,
                targetId: peerId,
                data: offer,
              });
            } catch (err) {
              console.error('[WebRTC] Failed to create offer:', err);
            }
          }
          break;
        }

        case 'offer': {
          if (currentRole === 'client') {
            try {
              if (!pc) {
                pc = createPeerConnection(currentRoomId || 'default', 'client');
              }
              await pc.setRemoteDescription(new RTCSessionDescription(data));
              await drainIceCandidates(pc);

              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);

              sendSignalingMessage({
                type: 'answer',
                roomId: currentRoomId || undefined,
                targetId: senderId,
                data: answer,
              });
            } catch (err) {
              console.error('[WebRTC] Failed to handle offer:', err);
            }
          }
          break;
        }

        case 'answer': {
          if (currentRole === 'host' && pc) {
            try {
              await pc.setRemoteDescription(new RTCSessionDescription(data));
              await drainIceCandidates(pc);
            } catch (err) {
              console.error('[WebRTC] Failed to set remote answer:', err);
            }
          }
          break;
        }

        case 'ice-candidate': {
          if (data) {
            const candidate = new RTCIceCandidate(data);
            if (pc && pc.remoteDescription && pc.remoteDescription.type) {
              try {
                await pc.addIceCandidate(candidate);
              } catch (err) {
                console.warn('[WebRTC] Error adding ICE candidate:', err);
              }
            } else {
              iceCandidatesQueueRef.current.push(candidate);
            }
          }
          break;
        }

        case 'peer-left':
        case 'peer:left':
        case 'session:ended': {
          setRemoteStream(null);
          setConnectionState('disconnected');
          break;
        }
      }
    },
    [createPeerConnection, sendSignalingMessage]
  );

  // Initialize the signaling connection
  useEffect(() => {
    let socket: Socket | null = null;
    try {
      socket = io(serverUrl, {
        autoConnect: true,
        reconnectionAttempts: 20,
        reconnectionDelay: 1000,
        timeout: 8000,
      });

      socket.on('connect', () => {
        setIsSocketConnected(true);
        setJoinError(null);
        // If joinRoom or host room was requested, emit immediately upon connection!
        if (roomIdRef.current) {
          if (roleRef.current === 'host') {
            socket?.emit('host:create', {
              roomId: roomIdRef.current,
              unattended: unattendedRef.current,
              pin: pinRef.current,
            });
          } else if (roleRef.current === 'client') {
            socket?.emit('client:join', {
              roomId: roomIdRef.current,
              pin: pinRef.current,
            });
          }
        }
      });

      socket.on('connect_error', (err) => {
        console.warn(`[WebRTC] Socket connect_error to ${serverUrl}:`, err);
        setIsSocketConnected(false);
        setJoinError(`Cannot reach signaling server at ${serverUrl}`);
      });

      socket.on('disconnect', () => {
        setIsSocketConnected(false);
      });

      // Unified signal relay listener
      socket.on('signal', ({ fromId, kind, data }: { fromId: string; kind: string; data: any }) => {
        handleSignaling(kind, { fromId, data });
      });

      // Specific event listeners
      socket.on('offer', (data) => handleSignaling('offer', data));
      socket.on('answer', (data) => handleSignaling('answer', data));
      socket.on('ice-candidate', (data) => handleSignaling('ice-candidate', data));
      socket.on('peer-joined', (data) => handleSignaling('peer-joined', data));
      socket.on('peer:joined', (data) => handleSignaling('peer:joined', data));
      socket.on('peer:left', (data) => handleSignaling('peer:left', data));
      socket.on('session:ended', (data) => handleSignaling('session:ended', data));

      // Host receives join request
      socket.on('peer:join-request', ({ requestId, pin }: { requestId: string; peerId: string; pin: string }) => {
        // Auto-approve if unattended mode is on or PIN matches
        const isAuthorized = unattendedRef.current || !pinRef.current || pinRef.current === pin?.trim().toUpperCase();
        socket?.emit('host:auth-result', {
          requestId,
          granted: isAuthorized,
          reason: isAuthorized ? undefined : 'Invalid PIN',
        });
      });

      // Client receives join verdict
      socket.on('join:result', (res: { granted: boolean; roomId?: string; hostId?: string; peerId?: string; reason?: string }) => {
        if (res.granted) {
          setJoinError(null);
          if (res.hostId) {
            remotePeerIdRef.current = res.hostId;
          }
        } else {
          // Name the server that answered. "No host is sharing that Desk ID"
          // is indistinguishable from a typo until you know *which* machine was
          // asked — and the commonest cause is asking the wrong one, because
          // the field still points at this machine's own signaling server.
          const reason = res.reason || 'Join request rejected';
          setJoinError(`${reason} (asked ${serverUrl})`);
          setConnectionState('failed');
        }
      });

      socketRef.current = socket;
    } catch (err) {
      console.warn('Signaling connection initialization error:', err);
    }

    // Subscribe to local BroadcastChannel fallback
    const unsubscribeLocal = localSignaling.subscribe((msg) => {
      handleSignaling(msg.type || msg.kind, msg);
    });

    return () => {
      if (socket) {
        socket.disconnect();
      }
      unsubscribeLocal();
    };
  }, [handleSignaling, serverUrl]);

  // Join Room Action
  const joinRoom = useCallback(
    async (targetRoomId: string, selectedRole: 'host' | 'client', pin?: string, isUnattended = true) => {
      setJoinError(null);
      setRole(selectedRole);
      setRoomId(targetRoomId);
      roleRef.current = selectedRole;
      roomIdRef.current = targetRoomId;
      unattendedRef.current = isUnattended;
      pinRef.current = pin;

      createPeerConnection(targetRoomId, selectedRole);

      const socket = socketRef.current;
      if (socket) {
        if (socket.connected) {
          if (selectedRole === 'host') {
            socket.emit('host:create', {
              roomId: targetRoomId,
              unattended: isUnattended,
              pin: pin?.trim().toUpperCase(),
            });
          } else {
            socket.emit('client:join', {
              roomId: targetRoomId,
              pin: pin?.trim().toUpperCase(),
            });
          }
        } else {
          socket.connect();
        }
      }

      // Notify local bus
      sendSignalingMessage({
        type: 'peer-joined',
        roomId: targetRoomId,
        senderId: localClientIdRef.current,
        data: { role: selectedRole, pin: pin?.trim().toUpperCase() },
      });
    },
    [createPeerConnection, sendSignalingMessage]
  );

  /**
   * Publishes (or updates) this machine's Desk ID on the signaling server.
   *
   * Separate from `joinRoom` because it must not disturb an established
   * session: `joinRoom` rebuilds the peer connection, which would drop a
   * connected client just because the operator toggled unattended access.
   *
   * The host calls this as soon as its view opens, so the Desk ID shown on
   * screen is one a client can actually connect to. Registering only when
   * screen sharing began was the reason a client was told "no host is sharing
   * that Desk ID" while the host had the ID plainly displayed in front of them.
   *
   * Reconnects are covered by the socket's `connect` handler, which re-emits
   * from these same refs.
   */
  const registerHost = useCallback(
    (targetRoomId: string, pin?: string, isUnattended = true) => {
      roleRef.current = 'host';
      roomIdRef.current = targetRoomId;
      unattendedRef.current = isUnattended;
      pinRef.current = pin?.trim().toUpperCase();

      setRole('host');
      setRoomId(targetRoomId);

      const socket = socketRef.current;
      if (socket?.connected) {
        socket.emit('host:create', {
          roomId: targetRoomId,
          unattended: isUnattended,
          pin: pinRef.current,
        });
      } else {
        // Not connected yet — the `connect` handler re-emits from the refs set
        // above, so the registration is not lost.
        socket?.connect();
      }
    },
    []
  );

  // Emergency Panic Button
  const severAllConnections = useCallback(
    (reason: string = 'GLOBAL_PANIC_TRIGGERED') => {
      console.warn(`[WebRTC] EMERGENCY PANIC: Severing all peer connections! Reason: ${reason}`);

      if (eventsChannelRef.current && eventsChannelRef.current.readyState === 'open') {
        try {
          eventsChannelRef.current.send(
            JSON.stringify({
              type: 'PANIC_SEVER_CONNECTION',
              reason,
              timestamp: Date.now(),
            })
          );
        } catch (e) {
          // ignore
        }
      }

      const currentRoomId = roomIdRef.current;
      if (currentRoomId) {
        sendSignalingMessage({
          type: 'leave',
          roomId: currentRoomId,
          data: { reason },
        });
      }

      cleanupPeerConnection();
      setRoomId(null);
    },
    [cleanupPeerConnection, sendSignalingMessage]
  );

  // Leave Room
  const leaveRoom = useCallback(() => {
    const currentRoomId = roomIdRef.current;
    if (currentRoomId) {
      sendSignalingMessage({
        type: 'peer-left',
        roomId: currentRoomId,
      });
    }
    const socket = socketRef.current;
    if (socket && socket.connected) {
      socket.emit('leave');
    }
    cleanupPeerConnection();
    setRoomId(null);
  }, [cleanupPeerConnection, sendSignalingMessage]);

  // Send High-Frequency Mouse Packet
  const sendMousePacket = useCallback((packet: RemoteMouseMovePayload): boolean => {
    const channel = mouseChannelRef.current;
    if (channel && channel.readyState === 'open') {
      try {
        channel.send(JSON.stringify(packet));
        packetsSentRef.current += 1;
        return true;
      } catch (err) {
        return false;
      }
    }
    return false;
  }, []);

  // Send Critical Event Packet
  const sendEventPacket = useCallback((packet: RemoteControlPacket): boolean => {
    const channel = eventsChannelRef.current;
    if (channel && channel.readyState === 'open') {
      try {
        channel.send(JSON.stringify(packet));
        packetsSentRef.current += 1;
        return true;
      } catch (err) {
        return false;
      }
    }
    return false;
  }, []);

  return {
    role,
    roomId,
    remoteStream,
    connectionState,
    iceConnectionState,
    signalingState,
    joinError,
    isConnected: connectionState === 'connected' || (dataChannelsReady.mouse && dataChannelsReady.events),
    isConnecting:
      connectionState === 'connecting' ||
      signalingState === 'have-local-offer' ||
      signalingState === 'have-remote-offer',
    isSocketConnected,
    dataChannelsReady,
    stats,
    lastReceivedMousePacket,
    lastReceivedEventPacket,
    joinRoom,
    registerHost,
    leaveRoom,
    severAllConnections,
    sendMousePacket,
    sendEventPacket,
    peerConnection: peerConnectionRef.current,
    getDataChannelBufferedAmount: () => eventsChannelRef.current?.bufferedAmount || 0,
  };
}
