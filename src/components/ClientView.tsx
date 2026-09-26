import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Tv,
  Zap,
  Lock,
  Unlock,
  Maximize2,
  Minimize2,
  Keyboard,
  Compass,
  Power,
  AlertCircle,
  HardDrive,
  Clipboard,
  Send,
  AlertTriangle,
  Server,
  Settings,
  Wifi,
  WifiOff,
  Search,
  Loader2,
} from 'lucide-react';
import { useWebRTC, getDefaultSignalUrl, getHostSignalUrl } from '../hooks/useWebRTC';
import { calculateRemoteCoordinates, BoundingBox } from '../utils/coordinateMath';
import {
  HostScreenMetadata,
  CoordinateTranslationResult,
  RemoteMouseButton,
  RemoteMouseMovePayload,
  RemoteMouseButtonPayload,
  RemoteMouseWheelPayload,
  RemoteKeyboardPayload,
  RemoteControlPacket,
  StreamQualityProfile,
  AnnotationStrokePayload,
} from '../types/remoteControl';
import { useClipboardSync } from '../utils/clipboardSync';
import { FileTransferManager, ActiveFileTransfer } from '../utils/fileTransfer';
import { FileTransferModal } from './FileTransferModal';
import { StreamControls } from './StreamControls';
import { AnnotationCanvas, AnnotationMode } from './AnnotationCanvas';
import { TelemetryStatsPanel } from './TelemetryStatsPanel';
import { useToast } from './ToastSystem';
import {
  scanForHosts,
  isSharing,
  autofillDeskId,
  DiscoveredHost,
} from '../utils/hostDiscovery';
import { deviceKey, saveDevice, touchDevice } from '../utils/deviceBook';
import { loadProfile } from '../utils/machineProfile';
import { getPublicRelayUrl, isPublicRelay, shouldTryRelay } from '../utils/publicRelay';

/** A device the operator picked in the device book, to connect to now. */
export interface ClientConnectRequest {
  deviceId?: string;
  name: string;
  deskId: string;
  /** Tried in order, so a machine reachable on the LAN is never sent over a tunnel. */
  addresses: string[];
  pin?: string | null;
  /** Changes on every request, so picking the same device twice reconnects. */
  nonce: number;
}

interface ClientViewProps {
  initialRoomId?: string;
  initialPin?: string;
  connectRequest?: ClientConnectRequest | null;
  onSwitchToHost?: () => void;
}

/** How long one saved address gets to answer before the next is tried. */
const ADDRESS_TIMEOUT_MS = 6000;

export const ClientView: React.FC<ClientViewProps> = ({
  initialRoomId,
  initialPin,
  connectRequest,
}) => {
  const { showToast } = useToast();
  const [roomIdInput, setRoomIdInput] = useState<string>(initialRoomId || '');
  const [pinInput, setPinInput] = useState<string>(initialPin || '');
  const [serverUrlInput, setServerUrlInput] = useState<string>(() => getDefaultSignalUrl());
  const [showServerSettings, setShowServerSettings] = useState<boolean>(false);

  const [isJoined, setIsJoined] = useState<boolean>(false);
  const [isControlLocked, setIsControlLocked] = useState<boolean>(true);
  const [showCoordinateHUD, setShowCoordinateHUD] = useState<boolean>(false);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);

  // Host Emergency Panic Alert
  const [panicAlert, setPanicAlert] = useState<string | null>(null);

  // Host Screen Metadata
  const [hostMetadata] = useState<HostScreenMetadata>({
    width: 1920,
    height: 1080,
    devicePixelRatio: 1.0,
  });

  // Quality Preset
  const [currentQualityProfile, setCurrentQualityProfile] = useState<StreamQualityProfile['id']>('performance');

  // Real-time Coordinate Translation State
  const [lastCoordResult, setLastCoordResult] = useState<CoordinateTranslationResult | null>(null);
  const lastCoordResultRef = useRef<CoordinateTranslationResult | null>(null);
  const rafIdRef = useRef<number | null>(null);

  // Annotation & Laser Pointer State
  const [annotationMode, setAnnotationMode] = useState<AnnotationMode>('remote');
  const [incomingAnnotation, setIncomingAnnotation] = useState<AnnotationStrokePayload | null>(null);

  // File Transfer State
  const [isFileModalOpen, setIsFileModalOpen] = useState<boolean>(false);
  const [activeTransfers, setActiveTransfers] = useState<ActiveFileTransfer[]>([]);
  const fileTransferManagerRef = useRef<FileTransferManager>(new FileTransferManager());

  // Clipboard sync input
  const [manualClipInput, setManualClipInput] = useState('');

  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoElementRef = useRef<HTMLVideoElement | null>(null);

  const [isScanningLan, setIsScanningLan] = useState<boolean>(false);
  const [scanProgress, setScanProgress] = useState<{ done: number; total: number } | null>(null);
  const [discoveredHosts, setDiscoveredHosts] = useState<DiscoveredHost[]>([]);
  const [scanSummary, setScanSummary] = useState<string | null>(null);
  /** The device being dialled, and which of its addresses is being tried. */
  const [dialing, setDialing] = useState<{ request: ClientConnectRequest; index: number } | null>(
    null
  );
  /**
   * The desk the relay has already been tried for, so a desk that is not on
   * the relay either is reported once instead of retried forever.
   */
  const relayTriedRef = useRef<string | null>(null);
  /** What to call the machine being reached, in messages about it. */
  const targetNameRef = useRef<string | null>(null);
  /** This machine's name, which the host is shown when we knock. */
  const [myName, setMyName] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadProfile().then((profile) => {
      if (!cancelled) setMyName(profile.name);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Update room ID if initialRoomId prop changes or from URL hash
  useEffect(() => {
    if (initialRoomId) setRoomIdInput(initialRoomId);
    if (initialPin) setPinInput(initialPin);
    if (typeof window !== 'undefined' && window.location.hash) {
      const hash = window.location.hash.replace('#', '').trim();
      if (hash) setRoomIdInput(hash);
    }
  }, [initialPin, initialRoomId]);

  /** Saves a discovered machine to the device book, so next time is one click. */
  const rememberHost = async (host: DiscoveredHost) => {
    const deskId = autofillDeskId(host) ?? roomIdInput.replace(/\s+/g, '').trim();
    const device = await saveDevice({
      id: deviceKey(deskId, [host.origin]),
      name: host.origin.replace(/^https?:\/\//, ''),
      deskId,
      addresses: [host.origin],
      // The PIN in the box is the one that just worked, if the operator typed
      // one; saving it is the difference between one click and two next time.
      pin: pinInput.trim() ? pinInput.trim() : null,
    });
    showToast({
      title: 'Saved to My Devices',
      description: `${device.name} — open the My Devices tab to connect in one click.`,
      type: 'success',
      duration: 5000,
    });
  };

  /** Points the client at a discovered host, filling in whatever it published. */
  const applyDiscoveredHost = (host: DiscoveredHost) => {
    setServerUrlInput(host.origin);
    localStorage.setItem('remotedesk_signal_url', host.origin);

    const deskId = autofillDeskId(host);
    if (deskId) setRoomIdInput(deskId);

    showToast({
      title: 'Host Found',
      description: deskId
        ? `${host.origin} — Desk ID ${deskId} filled in. Press Connect.`
        : `${host.origin} — now enter the Desk ID shown on that machine.`,
      type: 'success',
      duration: 6000,
    });
  };

  /**
   * Sweeps the local network for a host and shows what it found.
   *
   * Everything that makes this correct lives in `hostDiscovery`; what matters
   * here is that the result is *shown*. The previous version set the server
   * address to the first thing that answered — which, on a machine running the
   * app, is its own embedded server — and announced a discovery with nothing
   * behind it to connect to.
   */
  const handleScanLan = async () => {
    setIsScanningLan(true);
    setDiscoveredHosts([]);
    setScanSummary(null);
    setScanProgress({ done: 0, total: 0 });

    try {
      const { hosts, scanned, networks } = await scanForHosts({
        // This machine's own server, never the one saved from a previous
        // connection: the scan has to run here, and a remote host refuses to
        // scan its network on our behalf.
        selfOrigin: getHostSignalUrl(),
        onProgress: (done, total) => setScanProgress({ done, total }),
        onHost: (host) =>
          setDiscoveredHosts((current) =>
            [...current, host].sort((a, b) => b.rooms - a.rooms || a.origin.localeCompare(b.origin))
          ),
      });

      const sharing = hosts.filter(isSharing);

      if (sharing.length === 1) {
        // One unambiguous answer: fill the form in rather than making the
        // operator retype what the scan already knows.
        applyDiscoveredHost(sharing[0]);
      } else if (sharing.length === 0 && hosts.length === 0) {
        setScanSummary(
          scanned === 0
            ? 'No local network address was found on this machine, so there was nothing to scan. Type the host address manually.'
            : `Nothing answered on ${networks.join(', ') || 'this network'} (${scanned} addresses checked). Check the host is running and both machines are on the same Wi-Fi.`
        );
        showToast({
          title: 'No Host Found',
          description: "Type the host's address, e.g. http://192.168.x.x:4000",
          type: 'warning',
          duration: 5000,
        });
      } else if (sharing.length === 0) {
        setScanSummary(
          `Found ${hosts.length} machine(s) running RemoteDesk, but none is sharing a screen yet. Start sharing on the host, then scan again.`
        );
      } else {
        setScanSummary(`${sharing.length} hosts are sharing. Pick the one you want.`);
      }
    } catch (error) {
      setScanSummary(`Scan failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsScanningLan(false);
      setScanProgress(null);
    }
  };

  // WebRTC Hook
  const {
    remoteStream,
    connectionState,
    signalingState,
    isSocketConnected,
    joinError,
    dataChannelsReady,
    stats,
    joinRoom,
    leaveRoom,
    isAdmitted,
    sendMousePacket,
    sendEventPacket,
    getDataChannelBufferedAmount,
  } = useWebRTC({
    role: 'client',
    serverUrl: serverUrlInput,
    clientName: myName ?? undefined,
    onRemotePacket: (packet) => handleIncomingPacket(packet),
    onRemoteMouse: () => {},
  });

  // Clipboard Synchronization
  const {
    lastSyncText,
    syncCount,
    lastSyncTime,
    lastSource,
    handleRemoteClipboardPacket,
    manualSyncText,
  } = useClipboardSync({
    role: 'client',
    enabled: true,
    onSendClipboardPacket: (packet) => {
      sendEventPacket(packet);
    },
  });

  // Wire up FileTransferManager
  useEffect(() => {
    fileTransferManagerRef.current.setCallbacks(
      (packet) => sendEventPacket(packet),
      getDataChannelBufferedAmount,
      (transfers) => setActiveTransfers(transfers)
    );
  }, [getDataChannelBufferedAmount, sendEventPacket]);

  // Ingress packets on client
  const handleIncomingPacket = useCallback(
    (packet: RemoteControlPacket) => {
      if (packet.type === 'PANIC_SEVER_CONNECTION') {
        setPanicAlert(packet.reason || 'Host initiated emergency disconnect.');
        setIsJoined(false);
        leaveRoom();
        return;
      }

      if (packet.type === 'CLIPBOARD_UPDATE') {
        handleRemoteClipboardPacket(packet);
        return;
      }
      if (
        packet.type === 'FILE_TRANSFER_START' ||
        packet.type === 'FILE_TRANSFER_CHUNK' ||
        packet.type === 'FILE_TRANSFER_COMPLETE' ||
        packet.type === 'FILE_TRANSFER_CANCEL'
      ) {
        fileTransferManagerRef.current.handleIncomingPacket(packet);
        return;
      }
      if (packet.type === 'ANNOTATION_STROKE') {
        setIncomingAnnotation(packet);
        return;
      }
    },
    [handleRemoteClipboardPacket, leaveRoom]
  );

  // Attach Remote Stream to Video Element
  useEffect(() => {
    const video = videoElementRef.current;
    if (video && remoteStream) {
      video.srcObject = remoteStream;
      video.play().catch((e) => {
        console.warn('[ClientView] Autoplay blocked, waiting for user interaction:', e);
      });
    }
  }, [remoteStream]);

  // Clean up RAF on unmount
  useEffect(() => {
    return () => {
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, []);

  // Handle Room Join
  /**
   * Points the client at a saved device and starts dialling its first address.
   *
   * Keyed on the nonce rather than the device, so picking the same machine
   * again after a disconnect reconnects instead of doing nothing.
   */
  useEffect(() => {
    if (!connectRequest || connectRequest.addresses.length === 0) return;
    relayTriedRef.current = null;
    targetNameRef.current = connectRequest.name;
    const first = connectRequest.addresses[0];
    setRoomIdInput(connectRequest.deskId);
    setPinInput(connectRequest.pin ?? '');
    setServerUrlInput(first);
    localStorage.setItem('remotedesk_signal_url', first);
    setDialing({ request: connectRequest, index: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectRequest?.nonce]);

  /**
   * Walks the saved addresses until one answers.
   *
   * A machine that is sometimes on this network and sometimes reached through a
   * tunnel has both saved. Trying them in order is what makes one saved device
   * work from anywhere — and why the LAN address must come first, or every
   * local session would be routed over the internet.
   */
  useEffect(() => {
    if (!dialing) return;
    const target = dialing.request.addresses[dialing.index];
    // Wait until the state carrying this address has actually landed, or the
    // socket we are about to judge is still the previous server's.
    if (serverUrlInput !== target) return;

    if (isSocketConnected) {
      setDialing(null);
      void connectNow(dialing.request);
      return;
    }

    const timer = setTimeout(() => {
      const next = dialing.index + 1;
      if (next < dialing.request.addresses.length) {
        const address = dialing.request.addresses[next];
        setServerUrlInput(address);
        // The relay is a fallback, not a default: saving it would send every
        // later connection over the internet, even to a machine in the room.
        if (!isPublicRelay(address)) localStorage.setItem('remotedesk_signal_url', address);
        setDialing({ request: dialing.request, index: next });
        showToast({
          title: `Trying ${dialing.request.name} elsewhere`,
          description: `No answer at ${target}. Trying ${address}.`,
          type: 'info',
          duration: 4000,
        });
      } else {
        setDialing(null);
        // Every saved address is somewhere the machine used to be; the relay
        // finds it wherever it is now.
        if (tryRelay()) return;
        showToast({
          title: `Could not reach ${dialing.request.name}`,
          description:
            'No saved address answered. Check the machine is awake and running RemoteDesk — if it has moved networks, scan again or paste its new connect link.',
          type: 'error',
          duration: 8000,
        });
      }
    }, ADDRESS_TIMEOUT_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialing, isSocketConnected, serverUrlInput]);

  /**
   * Looks for the desk on the public relay instead.
   *
   * Every address we know is a local one, so "no host is sharing that Desk ID"
   * or an address that never answers usually just means the other machine is
   * on a different network. The host registers on the relay too, so the same
   * Desk ID finds it there — no address, no tunnel, nothing to set up.
   */
  const tryRelay = useCallback((): boolean => {
    const relay = getPublicRelayUrl();
    const deskId = roomIdInput.replace(/\s+/g, '').trim();
    if (!relay || !deskId || isPublicRelay(serverUrlInput) || relayTriedRef.current === deskId) {
      return false;
    }
    relayTriedRef.current = deskId;
    const name = targetNameRef.current || `Desk ${deskId}`;

    leaveRoom();
    setServerUrlInput(relay);
    setDialing({
      request: { name, deskId, addresses: [relay], pin: pinInput, nonce: Date.now() },
      index: 0,
    });
    showToast({
      title: `${name} is not on this network`,
      description: 'Looking for it over the internet instead.',
      type: 'info',
      duration: 4000,
    });
    return true;
  }, [leaveRoom, pinInput, roomIdInput, serverUrlInput, showToast]);

  // The server we asked has never heard of this desk: try the relay.
  useEffect(() => {
    if (!isJoined || dialing || !shouldTryRelay(joinError)) return;
    tryRelay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joinError, isJoined]);

  // The server we asked never answered at all: try the relay.
  useEffect(() => {
    if (!isJoined || isSocketConnected || dialing || isPublicRelay(serverUrlInput)) return;
    const timer = setTimeout(() => tryRelay(), ADDRESS_TIMEOUT_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isJoined, isSocketConnected, dialing, serverUrlInput]);

  /** Joins the desk a saved device names, once its server is reachable. */
  const connectNow = async (request: ClientConnectRequest) => {
    showToast({
      title: `Connecting to ${request.name}`,
      description: `Desk ${request.deskId}`,
      type: 'info',
      duration: 3000,
    });
    setPanicAlert(null);
    await joinRoom(request.deskId, 'client', (request.pin ?? '').trim().toUpperCase(), false);
    setIsJoined(true);
    if (request.deviceId) void touchDevice(request.deviceId);
  };

  const handleJoin = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    relayTriedRef.current = null;
    targetNameRef.current = null;
    let cleanRoomId = roomIdInput.replace(/\s+/g, '').trim();
    let currentServer = serverUrlInput.trim();

    // Auto-detect if user pasted a full URL or ID@Server into Desk ID box
    if (cleanRoomId.includes('http://') || cleanRoomId.includes('https://')) {
      try {
        const url = new URL(cleanRoomId);
        if (url.hash) {
          cleanRoomId = url.hash.replace('#', '').trim();
        } else if (url.pathname && url.pathname.length > 1) {
          cleanRoomId = url.pathname.replace('/', '').trim();
        } else {
          cleanRoomId = '784920';
        }
        currentServer = `${url.protocol}//${url.host}`;
        setServerUrlInput(currentServer);
        setRoomIdInput(cleanRoomId);
      } catch {
        // ignore parse error
      }
    } else if (cleanRoomId.includes('@')) {
      const [idPart, hostPart] = cleanRoomId.split('@');
      cleanRoomId = idPart.trim();
      currentServer = hostPart.startsWith('http') ? hostPart.trim() : `http://${hostPart.trim()}`;
      setServerUrlInput(currentServer);
      setRoomIdInput(cleanRoomId);
    }

    if (!cleanRoomId || cleanRoomId.length < 3) {
      showToast({
        title: 'Invalid Desk ID',
        description: 'Please enter a valid 6-digit Desk ID (e.g. 559 346).',
        type: 'warning',
      });
      return;
    }

    // Save server URL preference
    localStorage.setItem('remotedesk_signal_url', currentServer);

    if (!isSocketConnected) {
      showToast({
        title: 'Reaching Server...',
        description: `Connecting to ${currentServer}... If this stays connecting, ensure Server Address is set to your Windows PC's IP or Cloudflare URL.`,
        type: 'warning',
        duration: 6000,
      });
    } else {
      showToast({
        title: 'Connecting to Host',
        description: `Negotiating WebRTC stream with Desk ${cleanRoomId}...`,
        type: 'info',
        duration: 3000,
      });
    }

    setPanicAlert(null);
    await joinRoom(cleanRoomId, 'client', pinInput.trim().toUpperCase(), false);
    setIsJoined(true);
  };

  // Handle Disconnect
  const handleDisconnect = () => {
    leaveRoom();
    setIsJoined(false);
    setLastCoordResult(null);
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
    showToast({
      title: 'Disconnected',
      description: 'Remote session ended.',
      type: 'info',
      duration: 3000,
    });
  };

  // Extract Bounding Box
  const getVideoBoundingBox = useCallback((): BoundingBox | null => {
    const el = videoElementRef.current || containerRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    };
  }, []);

  // 1. Mouse Move Pipeline
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!isControlLocked || annotationMode !== 'remote') return;
      const bbox = getVideoBoundingBox();
      if (!bbox) return;

      const result = calculateRemoteCoordinates(e.clientX, e.clientY, bbox, hostMetadata);
      lastCoordResultRef.current = result;

      if (showCoordinateHUD) {
        if (rafIdRef.current === null) {
          rafIdRef.current = requestAnimationFrame(() => {
            if (lastCoordResultRef.current) {
              setLastCoordResult(lastCoordResultRef.current);
            }
            rafIdRef.current = null;
          });
        }
      }

      if (!result.isOutOfBounds) {
        const packet: RemoteMouseMovePayload = {
          type: 'MOUSE_MOVE',
          normX: result.normalizedX,
          normY: result.normalizedY,
          timestamp: Date.now(),
        };
        sendMousePacket(packet);
      }
    },
    [annotationMode, getVideoBoundingBox, hostMetadata, isControlLocked, sendMousePacket, showCoordinateHUD]
  );

  // 2. Mouse Down Pipeline
  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!isControlLocked || annotationMode !== 'remote') return;
      e.preventDefault();
      containerRef.current?.focus();

      const bbox = getVideoBoundingBox();
      if (!bbox) return;

      const result = calculateRemoteCoordinates(e.clientX, e.clientY, bbox, hostMetadata);
      setLastCoordResult(result);

      if (!result.isOutOfBounds) {
        let button: RemoteMouseButton = 'left';
        if (e.button === 1) button = 'middle';
        if (e.button === 2) button = 'right';

        const packet: RemoteMouseButtonPayload = {
          type: 'MOUSE_DOWN',
          button,
          normX: result.normalizedX,
          normY: result.normalizedY,
          clicks: e.detail || 1,
          timestamp: Date.now(),
        };

        sendEventPacket(packet);
      }
    },
    [annotationMode, getVideoBoundingBox, hostMetadata, isControlLocked, sendEventPacket]
  );

  // 3. Mouse Up Pipeline
  const handleMouseUp = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!isControlLocked || annotationMode !== 'remote') return;
      e.preventDefault();

      const bbox = getVideoBoundingBox();
      if (!bbox) return;

      const result = calculateRemoteCoordinates(e.clientX, e.clientY, bbox, hostMetadata);

      let button: RemoteMouseButton = 'left';
      if (e.button === 1) button = 'middle';
      if (e.button === 2) button = 'right';

      const packet: RemoteMouseButtonPayload = {
        type: 'MOUSE_UP',
        button,
        normX: result.normalizedX,
        normY: result.normalizedY,
        timestamp: Date.now(),
      };

      sendEventPacket(packet);
    },
    [annotationMode, getVideoBoundingBox, hostMetadata, isControlLocked, sendEventPacket]
  );

  // 4. Prevent Context Menu
  const handleContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  // 5. Mouse Wheel
  const handleWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      if (!isControlLocked || annotationMode !== 'remote') return;
      e.preventDefault();

      const packet: RemoteMouseWheelPayload = {
        type: 'MOUSE_WHEEL',
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        timestamp: Date.now(),
      };

      sendEventPacket(packet);
    },
    [annotationMode, isControlLocked, sendEventPacket]
  );

  // 6. Keyboard Down & Up
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!isControlLocked || annotationMode !== 'remote') return;

      if (
        e.key === 'Tab' ||
        e.key === 'Alt' ||
        e.key === 'Meta' ||
        (e.ctrlKey && (e.key === 'w' || e.key === 'r' || e.key === 't' || e.key === 'f'))
      ) {
        e.preventDefault();
      }

      const packet: RemoteKeyboardPayload = {
        type: 'KEY_DOWN',
        key: e.key,
        code: e.code,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        shiftKey: e.shiftKey,
        metaKey: e.metaKey,
        timestamp: Date.now(),
      };

      sendEventPacket(packet);
    },
    [annotationMode, isControlLocked, sendEventPacket]
  );

  const handleKeyUp = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!isControlLocked || annotationMode !== 'remote') return;
      e.preventDefault();

      const packet: RemoteKeyboardPayload = {
        type: 'KEY_UP',
        key: e.key,
        code: e.code,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        shiftKey: e.shiftKey,
        metaKey: e.metaKey,
        timestamp: Date.now(),
      };

      sendEventPacket(packet);
    },
    [annotationMode, isControlLocked, sendEventPacket]
  );

  // Toggle Fullscreen
  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().catch((err) => {
        console.warn('Fullscreen error:', err);
      });
      setIsFullscreen(true);
    } else {
      document.exitFullscreen().catch((err) => {
        console.warn('Exit fullscreen error:', err);
      });
      setIsFullscreen(false);
    }
  };

  const handleManualSyncClipboard = (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualClipInput.trim()) return;
    manualSyncText(manualClipInput.trim());
    setManualClipInput('');
  };

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-2">
      {/* Panic Severance Alert */}
      {panicAlert && (
        <div className="bg-rose-950/90 border-2 border-rose-500 rounded-2xl p-4 shadow-[0_0_30px_rgba(244,63,94,0.35)] backdrop-blur-xl flex items-center justify-between gap-4 animate-fadeIn">
          <div className="flex items-center space-x-3 text-rose-200">
            <div className="p-2 bg-rose-500/20 rounded-xl border border-rose-500/40">
              <AlertTriangle className="w-5 h-5 text-rose-400" />
            </div>
            <div>
              <h4 className="font-bold text-white text-sm">Host Ended Session</h4>
              <p className="text-xs font-mono text-rose-300">{panicAlert}</p>
            </div>
          </div>
          <button
            onClick={() => setPanicAlert(null)}
            className="px-3.5 py-1.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-mono text-xs font-semibold"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Join Error Banner */}
      {joinError && (
        <div className="bg-amber-950/80 border border-amber-500/80 rounded-2xl p-4 shadow-lg backdrop-blur-xl flex items-center justify-between gap-3 animate-fadeIn">
          <div className="flex items-center gap-2.5 text-xs text-amber-200 font-mono">
            <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
            <span>
              Connection Warning: {joinError}
              {isPublicRelay(serverUrlInput) && shouldTryRelay(joinError) && (
                <span className="block mt-1 text-amber-300/80">
                  Checked this network and the internet. Make sure RemoteDesk is open on that
                  machine and its Host tab says "Reachable from anywhere" — a desk set to "Anyone
                  with ID" can only be reached on its own network.
                </span>
              )}
            </span>
          </div>
          <button
            onClick={() => handleJoin()}
            className="px-3 py-1 bg-amber-600/80 hover:bg-amber-500 text-white rounded-lg text-xs font-semibold"
          >
            Retry
          </button>
        </div>
      )}

      {/* Top Banner with AnyDesk Connect Bar */}
      <div className="bg-[#0c0e18]/95 border border-cyan-500/25 rounded-2xl p-6 shadow-[0_8px_32px_rgba(0,0,0,0.5)] backdrop-blur-xl relative overflow-hidden">
        <div className="absolute -right-16 -top-16 w-64 h-64 bg-cyan-500/10 rounded-full blur-3xl pointer-events-none" />
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-5 relative z-10">
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 flex items-center gap-1.5">
                <Compass className="w-3.5 h-3.5 text-cyan-400 animate-pulse" />
                Remote Controller
              </span>
              <span className="text-xs text-slate-400 font-mono">
                Sub-Millisecond Direct Control & Screen Stream
              </span>
            </div>
            <h2 className="text-2xl font-bold text-white tracking-tight flex items-center gap-2">
              <span className="bg-gradient-to-r from-white via-cyan-100 to-cyan-300 bg-clip-text text-transparent">
                Connect to Remote Desk
              </span>
            </h2>
            <p className="text-sm text-slate-300 max-w-2xl leading-relaxed">
              Enter the Host Desk ID below to start high-performance 60 FPS remote control.
            </p>
          </div>

          {/* AnyDesk Style One-Click Connection Form */}
          <form onSubmit={handleJoin} className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 self-start lg:self-center">
            <div className="flex items-center gap-2">
              <input
                type="text"
                id="room-id-input"
                placeholder="Desk ID (e.g. 784 920)"
                value={roomIdInput}
                onChange={(e) => setRoomIdInput(e.target.value)}
                disabled={isJoined && connectionState === 'connected'}
                maxLength={14}
                className="bg-[#07080f] border border-cyan-500/40 rounded-xl px-4 py-2.5 text-base font-mono font-bold text-cyan-200 placeholder-slate-500 focus:outline-none focus:border-cyan-400 w-48 tracking-widest text-center shadow-inner"
              />
              <input
                type="text"
                id="pin-auth-input"
                placeholder="PIN (Optional)"
                value={pinInput}
                onChange={(e) => setPinInput(e.target.value.toUpperCase())}
                disabled={isJoined && connectionState === 'connected'}
                maxLength={6}
                className="bg-[#07080f] border border-emerald-500/30 rounded-xl px-3 py-2.5 text-xs font-mono text-emerald-300 placeholder-slate-500 focus:outline-none focus:border-emerald-400 w-28 tracking-widest text-center uppercase shadow-inner"
                title="Optional PIN if Host unattended access is disabled"
              />
            </div>

            <div className="flex items-center gap-2">
              {!isJoined || connectionState === 'failed' || connectionState === 'closed' ? (
                <button
                  id="join-room-button"
                  type="submit"
                  className="px-6 py-2.5 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-slate-950 font-extrabold text-sm flex items-center justify-center gap-2 shadow-[0_0_20px_rgba(6,182,212,0.4)] transition-all font-mono shrink-0"
                >
                  <Zap className="w-4 h-4 fill-current" />
                  <span>Connect</span>
                </button>
              ) : (
                <button
                  id="disconnect-room-button"
                  type="button"
                  onClick={handleDisconnect}
                  className="px-5 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs flex items-center justify-center gap-2 shadow-lg transition-all font-mono shrink-0"
                >
                  <Power className="w-4 h-4" />
                  <span>Disconnect</span>
                </button>
              )}

              <button
                type="button"
                onClick={() => setShowServerSettings(!showServerSettings)}
                className="p-2.5 rounded-xl bg-[#07080f] border border-cyan-500/30 text-slate-400 hover:text-cyan-300 transition-colors"
                title="Signaling Server URL Settings"
              >
                <Settings className="w-4 h-4" />
              </button>
            </div>
          </form>
        </div>

        {/* Host Server Address Bar (Always Accessible with Live Status) */}
        <div className="mt-4 pt-3 border-t border-cyan-500/15 flex flex-wrap items-center justify-between gap-3 text-xs font-mono">
          <div className="flex flex-wrap items-center gap-2 flex-1 min-w-72">
            <span className="text-slate-300 flex items-center gap-1.5 shrink-0 font-semibold">
              <Server className="w-3.5 h-3.5 text-cyan-400" />
              Host Server / Cloudflare Address:
            </span>
            <input
              type="text"
              id="server-url-input"
              value={serverUrlInput}
              onChange={(e) => {
                setServerUrlInput(e.target.value);
                localStorage.setItem('remotedesk_signal_url', e.target.value);
              }}
              placeholder="http://192.168.x.x:4000 or https://xxxx.trycloudflare.com"
              className="bg-[#07080f] border border-cyan-500/30 rounded-lg px-3 py-1.5 text-cyan-200 flex-1 min-w-56 focus:outline-none focus:border-cyan-400 shadow-inner text-xs"
            />
            <button
              type="button"
              onClick={handleScanLan}
              disabled={isScanningLan}
              className="px-2.5 py-1.5 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/30 text-cyan-300 flex items-center gap-1 transition-colors cursor-pointer disabled:opacity-50"
              title="Auto-scan local Wi-Fi / LAN for running RemoteDesk Host"
            >
              {isScanningLan ? <Loader2 className="w-3 h-3 animate-spin" /> : <Search className="w-3 h-3" />}
              <span>
                {isScanningLan
                  ? scanProgress && scanProgress.total > 0
                    ? `Scanning ${scanProgress.done}/${scanProgress.total}`
                    : 'Scanning...'
                  : 'Scan LAN'}
              </span>
            </button>
          </div>

          <div className="flex items-center gap-2">
            <span className={`px-2.5 py-1 rounded-full text-[11px] font-bold border flex items-center gap-1.5 ${
              isSocketConnected
                ? 'bg-emerald-950/60 border-emerald-500/40 text-emerald-300'
                : 'bg-rose-950/60 border-rose-500/40 text-rose-300 animate-pulse'
            }`}>
              {isSocketConnected ? (
                <>
                  <Wifi className="w-3 h-3 text-emerald-400" />
                  <span>Server Connected</span>
                </>
              ) : (
                <>
                  <WifiOff className="w-3 h-3 text-rose-400" />
                  <span>Server Unreachable (Set Host IP)</span>
                </>
              )}
            </span>
          </div>
        </div>

        {/* Hosts found on this network — the result of a scan, made pickable */}
        {(discoveredHosts.length > 0 || scanSummary) && (
          <div className="mt-3 rounded-xl border border-cyan-500/20 bg-[#07080f]/80 p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-bold font-mono text-cyan-300 flex items-center gap-1.5">
                <Compass className="w-3.5 h-3.5" />
                Hosts On This Network
              </span>
              <button
                type="button"
                onClick={() => {
                  setDiscoveredHosts([]);
                  setScanSummary(null);
                }}
                className="text-[11px] font-mono text-slate-500 hover:text-slate-300 transition-colors"
              >
                Clear
              </button>
            </div>

            {discoveredHosts.map((host) => {
              const deskId = autofillDeskId(host);
              const sharing = isSharing(host);
              return (
                <div
                  key={host.origin}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-cyan-500/15 bg-[#0c0e18] px-3 py-2"
                >
                  <div className="min-w-0 space-y-0.5">
                    <div className="font-mono text-xs text-cyan-200 truncate">{host.origin}</div>
                    <div className="text-[11px] text-slate-400 font-mono">
                      {!sharing
                        ? 'Running, but not sharing a screen yet'
                        : deskId
                          ? `Sharing Desk ID ${deskId}`
                          : host.desks.length > 0
                            ? 'Sharing — read the Desk ID off that machine'
                            : `Sharing ${host.rooms} desk(s) — read the Desk ID off that machine`}
                      {host.desks.some((d) => d.requiresPin) && ' · PIN required'}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => applyDiscoveredHost(host)}
                      disabled={!sharing}
                      className="px-3 py-1.5 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/30 text-cyan-300 text-[11px] font-bold font-mono transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Use This Host
                    </button>
                    <button
                      type="button"
                      onClick={() => rememberHost(host)}
                      className="px-3 py-1.5 rounded-lg bg-[#07080f] border border-cyan-500/25 text-slate-300 hover:text-cyan-300 text-[11px] font-bold font-mono transition-colors"
                      title="Save this machine to My Devices"
                    >
                      Save
                    </button>
                  </div>
                </div>
              );
            })}

            {scanSummary && (
              <p className="text-[11px] text-slate-400 font-mono leading-relaxed">{scanSummary}</p>
            )}
          </div>
        )}
      </div>

      {/* Main Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Remote Stream & Video Player (8 Cols) */}
        <div className="lg:col-span-8 space-y-6">
          <div className="bg-[#0c0e18]/95 border border-cyan-500/20 rounded-2xl p-5 space-y-4 shadow-xl backdrop-blur-xl">
            {/* Viewport Header Controls */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-cyan-500/15 pb-4">
              <div className="flex items-center space-x-2">
                <Tv className="w-4 h-4 text-cyan-400" />
                <h3 className="font-bold text-white text-base">Remote Screen Output</h3>
                {isJoined && (
                  <span
                    className={`flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium ${
                      connectionState === 'connected'
                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 animate-pulse'
                        : 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                    }`}
                  >
                    <span
                      className={`w-2 h-2 rounded-full ${
                        connectionState === 'connected' ? 'bg-emerald-400' : 'bg-amber-400'
                      }`}
                    />
                    {connectionState === 'connected' ? 'LIVE (60 FPS)' : connectionState.toUpperCase()}
                  </span>
                )}
              </div>

              {/* Viewport Control Actions */}
              <div className="flex items-center space-x-2 flex-wrap">
                <button
                  id="client-open-files-button"
                  onClick={() => setIsFileModalOpen(true)}
                  className="px-3 py-1.5 rounded-xl bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-300 border border-cyan-500/30 text-xs font-medium flex items-center gap-1.5 transition-colors"
                >
                  <HardDrive className="w-3.5 h-3.5" />
                  <span>Files ({activeTransfers.length})</span>
                </button>

                <button
                  id="toggle-control-lock-button"
                  onClick={() => setIsControlLocked(!isControlLocked)}
                  className={`px-3 py-1.5 rounded-xl text-xs font-medium flex items-center gap-1.5 border transition-all ${
                    isControlLocked
                      ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300'
                      : 'bg-slate-800 border-slate-700 text-slate-400'
                  }`}
                  title="Toggle Remote Input Forwarding"
                >
                  {isControlLocked ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
                  <span>{isControlLocked ? 'Input Active' : 'Input Paused'}</span>
                </button>

                <button
                  id="toggle-hud-button"
                  onClick={() => setShowCoordinateHUD(!showCoordinateHUD)}
                  className={`px-3 py-1.5 rounded-xl text-xs font-medium border transition-colors ${
                    showCoordinateHUD
                      ? 'bg-cyan-500/20 border-cyan-500/40 text-cyan-300'
                      : 'bg-slate-800 border-slate-700 text-slate-400'
                  }`}
                >
                  HUD: {showCoordinateHUD ? 'ON' : 'OFF'}
                </button>

                <button
                  id="toggle-fullscreen-button"
                  onClick={toggleFullscreen}
                  className="p-2 rounded-xl bg-[#090b16] hover:bg-cyan-950/40 text-slate-300 border border-cyan-500/20 transition-colors"
                  title="Toggle Fullscreen"
                >
                  {isFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>

            {/* Interactive Remote Desktop Container */}
            <div
              ref={containerRef}
              id="client-viewport-container"
              tabIndex={0}
              onMouseMove={handleMouseMove}
              onMouseDown={handleMouseDown}
              onMouseUp={handleMouseUp}
              onContextMenu={handleContextMenu}
              onWheel={handleWheel}
              onKeyDown={handleKeyDown}
              onKeyUp={handleKeyUp}
              className={`relative aspect-video w-full rounded-xl overflow-hidden bg-[#04060a] border border-cyan-500/30 shadow-2xl flex items-center justify-center select-none outline-none ${
                isControlLocked && annotationMode === 'remote' ? 'cursor-default' : ''
              }`}
            >
              {/* HTML5 Video Element */}
              <video
                ref={videoElementRef}
                autoPlay
                playsInline
                muted
                className="w-full h-full object-contain pointer-events-none"
              />

              {/* Annotation & Laser Pointer Layer */}
              <AnnotationCanvas
                mode={annotationMode}
                onModeChange={setAnnotationMode}
                onSendStroke={(stroke) => sendEventPacket(stroke)}
                isHost={false}
                incomingStroke={incomingAnnotation}
              />

              {/* Idle Placeholder */}
              {!remoteStream && (
                <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center space-y-3 bg-[#04060a]/90 backdrop-blur-sm pointer-events-none">
                  <div className="p-4 rounded-full bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 w-16 h-16 flex items-center justify-center">
                    <Tv className="w-8 h-8 opacity-75" />
                  </div>
                  <div>
                    {/* Joined but nothing arriving means the other machine has
                        not started sharing — a different situation from not
                        being connected, and the one people read as a failure
                        when the panel says nothing. */}
                    <p className="text-base font-semibold text-slate-200">
                      {isAdmitted
                        ? 'Waiting for the other machine to share'
                        : isJoined
                          ? 'Waiting to be let in'
                          : 'No Stream Connected'}
                    </p>
                    <p className="text-xs text-slate-400 max-w-sm mx-auto mt-1">
                      {isAdmitted
                        ? connectRequest?.name
                          ? `You are connected to ${connectRequest.name}. It will appear here as soon as someone there presses Allow and share, or Start Real Screen Share.`
                          : 'You are connected. The screen appears here as soon as the other machine starts sharing.'
                        : isJoined
                          ? `Somebody at ${connectRequest?.name ?? 'the other machine'} has to press Allow. This waits until they do.`
                          : 'Enter the Host’s Desk ID above and click “Connect” to begin remote control.'}
                    </p>
                  </div>
                </div>
              )}

              {/* Coordinate HUD */}
              {showCoordinateHUD && lastCoordResult && (
                <div className="absolute bottom-3 left-3 z-30 bg-[#07080f]/90 backdrop-blur-md p-3 rounded-xl border border-cyan-500/30 text-[11px] font-mono text-cyan-200 space-y-1 shadow-2xl pointer-events-none">
                  <div className="text-[10px] uppercase text-slate-400 font-bold border-b border-cyan-500/20 pb-1">
                    Coordinate HUD
                  </div>
                  <div>
                    Normalized: ({lastCoordResult.normalizedX.toFixed(3)}, {lastCoordResult.normalizedY.toFixed(3)})
                  </div>
                  <div>
                    Host Pixel: ({lastCoordResult.hostLogicalX}px, {lastCoordResult.hostLogicalY}px)
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Quality Preset Selection */}
          <StreamControls
            currentProfile={currentQualityProfile}
            onSelectProfile={(p) => setCurrentQualityProfile(p)}
            isHost={false}
          />

          {/* Client Clipboard Sync */}
          <div className="bg-[#0c0e18]/95 border border-cyan-500/20 rounded-2xl p-5 space-y-4 shadow-xl backdrop-blur-xl">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <Clipboard className="w-4 h-4 text-cyan-400" />
                <h3 className="font-bold text-white text-base">Client Clipboard Synchronizer</h3>
              </div>
              <span className="text-xs font-mono px-2 py-0.5 rounded bg-cyan-950/60 border border-cyan-500/20 text-cyan-300">
                Auto-Synced: {syncCount} items
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="p-3 bg-[#07080f] rounded-xl border border-cyan-500/20 space-y-1 text-xs font-mono">
                <span className="text-slate-400 block text-[11px]">Last Synced Clipboard Text</span>
                <p className="text-cyan-200 truncate bg-[#0d101a] p-2 rounded border border-slate-800">
                  {lastSyncText || '(No clipboard text received yet)'}
                </p>
                <div className="text-[10px] text-slate-400 flex justify-between pt-1">
                  <span>Source: {lastSource.toUpperCase()}</span>
                  <span>Time: {lastSyncTime || '--:--:--'}</span>
                </div>
              </div>

              <form onSubmit={handleManualSyncClipboard} className="p-3 bg-[#07080f] rounded-xl border border-cyan-500/20 space-y-2 text-xs">
                <span className="text-slate-400 block font-medium">Send Text to Server Clipboard</span>
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="Type text to paste into Host clipboard..."
                    value={manualClipInput}
                    onChange={(e) => setManualClipInput(e.target.value)}
                    className="flex-1 bg-[#05060b] border border-cyan-500/30 rounded px-2.5 py-1.5 text-slate-200 text-xs font-mono focus:outline-none focus:border-cyan-400"
                  />
                  <button
                    type="submit"
                    className="px-3 py-1.5 rounded bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 border border-cyan-500/40 text-xs font-medium flex items-center gap-1"
                  >
                    <Send className="w-3.5 h-3.5" />
                    <span>Send</span>
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>

        {/* Right Column: Telemetry & Connection Stats (4 Cols) */}
        <div className="lg:col-span-4 space-y-6">
          <TelemetryStatsPanel
            stats={stats}
            isConnected={connectionState === 'connected'}
            isConnecting={connectionState === 'connecting' || signalingState === 'have-remote-offer'}
            isSocketConnected={isSocketConnected}
            dataChannelsReady={dataChannelsReady}
          />

          {/* Quick Keyboard Hotkeys reference */}
          <div className="bg-[#0c0e18]/95 border border-cyan-500/20 rounded-2xl p-5 space-y-3 shadow-xl backdrop-blur-xl text-xs font-mono">
            <div className="flex items-center space-x-2 border-b border-cyan-500/15 pb-2.5">
              <Keyboard className="w-4 h-4 text-cyan-400" />
              <h4 className="font-bold text-white">Remote Input Controls</h4>
            </div>
            <div className="space-y-2 text-slate-300">
              <div className="flex justify-between items-center">
                <span>Direct Mouse Injection:</span>
                <span className="text-cyan-300 font-bold">Sub-ms UDP</span>
              </div>
              <div className="flex justify-between items-center">
                <span>Keyboard & Modifiers:</span>
                <span className="text-emerald-400 font-bold">Full Passthrough</span>
              </div>
              <div className="flex justify-between items-center">
                <span>Fullscreen Toggle:</span>
                <span className="text-slate-400 font-bold">F11 / Button</span>
              </div>
              <div className="flex justify-between items-center">
                <span>Clipboard Sync:</span>
                <span className="text-indigo-300 font-bold">Bidirectional</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* File Transfer Modal */}
      <FileTransferModal
        isOpen={isFileModalOpen}
        onClose={() => setIsFileModalOpen(false)}
        transfers={activeTransfers}
        onUploadFiles={(files) => {
          Array.from(files).forEach((file) => {
            fileTransferManagerRef.current.sendFile(file);
          });
        }}
        onCancelTransfer={(id) => fileTransferManagerRef.current.cancelTransfer(id)}
      />
    </div>
  );
};
