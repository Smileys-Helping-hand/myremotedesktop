import { useState, useEffect, useRef, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import {
  RemoteControlPacket,
  RemoteMouseMovePayload,
  SignalingMessage,
} from '../types/remoteControl';

export interface WebRTCOptions {
  role?: 'host' | 'client';
  roomId?: string;
  localStream?: MediaStream | null;
  serverUrl?: string;
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

// In-browser BroadcastChannel bus for seamless local peer testing & iframe demo
class LocalSignalingBus {
  private channel: BroadcastChannel | null = null;
  private listeners: Set<(msg: SignalingMessage) => void> = new Set();

  constructor() {
    if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
      try {
        this.channel = new BroadcastChannel('remotedesk_signaling_bus');
        this.channel.onmessage = (event) => {
          const msg = event.data as SignalingMessage;
          this.listeners.forEach((listener) => listener(msg));
        };
      } catch (err) {
        console.warn('BroadcastChannel not supported or restricted:', err);
      }
    }
  }

  public send(msg: SignalingMessage) {
    if (this.channel) {
      this.channel.postMessage(msg);
    }
  }

  public subscribe(listener: (msg: SignalingMessage) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

const localSignaling = new LocalSignalingBus();

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];

export function useWebRTC(options: WebRTCOptions = {}) {
  const {
    role: initialRole,
    roomId: initialRoomId,
    localStream,
    serverUrl = typeof window !== 'undefined' ? window.location.origin : '',
    onRemotePacket,
    onRemoteMouse,
    iceServers = DEFAULT_ICE_SERVERS,
  } = options;

  // State
  const [role, setRole] = useState<'host' | 'client' | null>(initialRole || null);
  const [roomId, setRoomId] = useState<string | null>(initialRoomId || null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [connectionState, setConnectionState] = useState<RTCPeerConnectionState>('new');
  const [iceConnectionState, setIceConnectionState] = useState<RTCIceConnectionState>('new');
  const [signalingState, setSignalingState] = useState<RTCSignalingState>('stable');
  const [isSocketConnected, setIsSocketConnected] = useState<boolean>(false);
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

  // References to prevent memory leaks and unnecessary re-creations
  const roleRef = useRef<'host' | 'client' | null>(initialRole || null);
  const roomIdRef = useRef<string | null>(initialRoomId || null);
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

  // Mutable packet counters to avoid 120Hz React state churn
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
    onRemotePacketRef.current = onRemotePacket;
  }, [onRemotePacket]);

  useEffect(() => {
    onRemoteMouseRef.current = onRemoteMouse;
  }, [onRemoteMouse]);

  // Sync localStream reference
  useEffect(() => {
    localStreamRef.current = localStream || null;
    if (peerConnectionRef.current && localStream) {
      // Add or replace tracks
      const senders = peerConnectionRef.current.getSenders();
      localStream.getTracks().forEach((track) => {
        const existingSender = senders.find((s) => s.track?.kind === track.kind);
        if (existingSender) {
          existingSender.replaceTrack(track);
        } else {
          peerConnectionRef.current?.addTrack(track, localStream);
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
        // Ignore close errors
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
        // Ignore close errors
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
        // Ignore close errors
      }
      peerConnectionRef.current = null;
    }

    iceCandidatesQueueRef.current = [];
    setRemoteStream(null);
    setConnectionState('closed');
    setIceConnectionState('closed');
    setDataChannelsReady({ mouse: false, events: false });
  }, []);

  // Send Signaling Message over Socket.io and BroadcastChannel fallback
  const sendSignalingMessage = useCallback(
    (msg: SignalingMessage) => {
      // 1. Socket.io
      if (socketRef.current && socketRef.current.connected) {
        socketRef.current.emit(msg.type, msg);
      }
      // 2. BroadcastChannel local bus
      localSignaling.send(msg);
    },
    []
  );

  // Setup Data Channel event listeners with zero-allocation message pipeline
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
        iceCandidatePoolSize: 2,
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

      // ICE Candidates
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          sendSignalingMessage({
            type: 'ice-candidate',
            roomId: targetRoomId,
            senderId: localClientIdRef.current,
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

      // If HOST: Add local media stream and create the two data channels
      if (currentRole === 'host') {
        if (localStreamRef.current) {
          localStreamRef.current.getTracks().forEach((track) => {
            pc.addTrack(track, localStreamRef.current!);
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

  // Handle Incoming Signaling Message (stable across role/roomId state changes via refs)
  const handleSignalingMessage = useCallback(
    async (msg: SignalingMessage) => {
      // Ignore our own messages or messages for other rooms
      if (msg.senderId === localClientIdRef.current) return;
      const currentRoomId = roomIdRef.current;
      const currentRole = roleRef.current;
      if (currentRoomId && msg.roomId !== currentRoomId) return;

      const pc = peerConnectionRef.current;

      switch (msg.type) {
        case 'peer-joined': {
          // If we are Host and a Client joined, initiate WebRTC Offer
          if (currentRole === 'host' && pc) {
            try {
              const offer = await pc.createOffer({
                offerToReceiveVideo: false,
                offerToReceiveAudio: false,
              });
              await pc.setLocalDescription(offer);
              sendSignalingMessage({
                type: 'offer',
                roomId: msg.roomId,
                senderId: localClientIdRef.current,
                data: offer,
              });
            } catch (err) {
              console.error('Failed to create offer:', err);
            }
          }
          break;
        }

        case 'offer': {
          // If we are Client, receive Offer and generate Answer
          if (currentRole === 'client') {
            try {
              const currentPc = pc || createPeerConnection(msg.roomId, 'client');
              await currentPc.setRemoteDescription(new RTCSessionDescription(msg.data));

              // Process any queued ICE candidates
              while (iceCandidatesQueueRef.current.length > 0) {
                const candidate = iceCandidatesQueueRef.current.shift();
                if (candidate) await currentPc.addIceCandidate(candidate);
              }

              const answer = await currentPc.createAnswer();
              await currentPc.setLocalDescription(answer);

              sendSignalingMessage({
                type: 'answer',
                roomId: msg.roomId,
                senderId: localClientIdRef.current,
                data: answer,
              });
            } catch (err) {
              console.error('Failed to handle offer:', err);
            }
          }
          break;
        }

        case 'answer': {
          // Host receives Answer from Client
          if (currentRole === 'host' && pc) {
            try {
              await pc.setRemoteDescription(new RTCSessionDescription(msg.data));

              // Process any queued ICE candidates
              while (iceCandidatesQueueRef.current.length > 0) {
                const candidate = iceCandidatesQueueRef.current.shift();
                if (candidate) await pc.addIceCandidate(candidate);
              }
            } catch (err) {
              console.error('Failed to set remote description answer:', err);
            }
          }
          break;
        }

        case 'ice-candidate': {
          if (msg.data) {
            const candidate = new RTCIceCandidate(msg.data);
            if (pc && pc.remoteDescription && pc.remoteDescription.type) {
              try {
                await pc.addIceCandidate(candidate);
              } catch (err) {
                console.error('Error adding ICE candidate:', err);
              }
            } else {
              iceCandidatesQueueRef.current.push(candidate);
            }
          }
          break;
        }

        case 'peer-left': {
          setRemoteStream(null);
          setConnectionState('disconnected');
          break;
        }
      }
    },
    [createPeerConnection, sendSignalingMessage]
  );

  // Initialize Socket.io connection & LocalSignaling listener once
  useEffect(() => {
    let socket: Socket | null = null;
    try {
      socket = io(serverUrl, {
        transports: ['websocket', 'polling'],
        autoConnect: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 1000,
      });

      socket.on('connect', () => {
        setIsSocketConnected(true);
      });

      socket.on('disconnect', () => {
        setIsSocketConnected(false);
      });

      socket.on('offer', (data) => handleSignalingMessage(data));
      socket.on('answer', (data) => handleSignalingMessage(data));
      socket.on('ice-candidate', (data) => handleSignalingMessage(data));
      socket.on('peer-joined', (data) => handleSignalingMessage(data));
      socket.on('peer-left', (data) => handleSignalingMessage(data));

      socketRef.current = socket;
    } catch (err) {
      console.warn('Socket.io connection initialization error (using local bus fallback):', err);
    }

    // Subscribe to local BroadcastChannel bus fallback
    const unsubscribeLocal = localSignaling.subscribe((msg) => {
      handleSignalingMessage(msg);
    });

    return () => {
      if (socket) {
        socket.off('connect');
        socket.off('disconnect');
        socket.off('offer');
        socket.off('answer');
        socket.off('ice-candidate');
        socket.off('peer-joined');
        socket.off('peer-left');
        socket.disconnect();
      }
      unsubscribeLocal();
    };
  }, [handleSignalingMessage, serverUrl]);

  // Join Room Action (Host or Client)
  const joinRoom = useCallback(
    async (targetRoomId: string, selectedRole: 'host' | 'client', pin?: string) => {
      setRole(selectedRole);
      setRoomId(targetRoomId);

      createPeerConnection(targetRoomId, selectedRole);

      // Notify signaling server / peers of join with optional rotating security PIN
      sendSignalingMessage({
        type: 'peer-joined',
        roomId: targetRoomId,
        senderId: localClientIdRef.current,
        pin: pin?.trim().toUpperCase(),
        data: { role: selectedRole, pin: pin?.trim().toUpperCase() },
      });
    },
    [createPeerConnection, sendSignalingMessage]
  );

  // Emergency Panic Button: Instantly sever all connections and lock down
  const severAllConnections = useCallback((reason: string = 'GLOBAL_PANIC_TRIGGERED') => {
    console.warn(`[WebRTC] EMERGENCY PANIC: Severing all peer connections! Reason: ${reason}`);
    
    // Broadcast panic packet before severing
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
        // Ignore send errors during emergency shutdown
      }
    }

    const currentRoomId = roomIdRef.current;
    if (currentRoomId) {
      sendSignalingMessage({
        type: 'leave',
        roomId: currentRoomId,
        senderId: localClientIdRef.current,
        data: { reason },
      });
    }

    cleanupPeerConnection();
    setRoomId(null);
  }, [cleanupPeerConnection, sendSignalingMessage]);

  // Leave Room Action
  const leaveRoom = useCallback(() => {
    const currentRoomId = roomIdRef.current;
    if (currentRoomId) {
      sendSignalingMessage({
        type: 'peer-left',
        roomId: currentRoomId,
        senderId: localClientIdRef.current,
      });
    }
    cleanupPeerConnection();
    setRoomId(null);
  }, [cleanupPeerConnection, sendSignalingMessage]);

  // Send High-Frequency Mouse Packet (Channel A: Unreliable / Unordered)
  const sendMousePacket = useCallback((packet: RemoteMouseMovePayload): boolean => {
    const channel = mouseChannelRef.current;
    if (channel && channel.readyState === 'open') {
      try {
        channel.send(JSON.stringify(packet));
        packetsSentRef.current += 1;
        return true;
      } catch (err) {
        console.warn('Failed to send mouse coordinate packet:', err);
        return false;
      }
    }
    return false;
  }, []);

  // Send Critical Event Packet (Channel B: Reliable / Ordered)
  const sendEventPacket = useCallback((packet: RemoteControlPacket): boolean => {
    const channel = eventsChannelRef.current;
    if (channel && channel.readyState === 'open') {
      try {
        channel.send(JSON.stringify(packet));
        packetsSentRef.current += 1;
        return true;
      } catch (err) {
        console.warn('Failed to send event packet:', err);
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
    isConnected: connectionState === 'connected' || (dataChannelsReady.mouse && dataChannelsReady.events),
    isConnecting: connectionState === 'connecting' || signalingState === 'have-local-offer' || signalingState === 'have-remote-offer',
    isSocketConnected,
    dataChannelsReady,
    stats,
    lastReceivedMousePacket,
    lastReceivedEventPacket,
    joinRoom,
    leaveRoom,
    severAllConnections,
    sendMousePacket,
    sendEventPacket,
    peerConnection: peerConnectionRef.current,
    getDataChannelBufferedAmount: () => eventsChannelRef.current?.bufferedAmount || 0,
  };
}
