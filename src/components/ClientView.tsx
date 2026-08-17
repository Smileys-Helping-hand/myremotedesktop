import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Monitor,
  Tv,
  Zap,
  Shield,
  Radio,
  Lock,
  Unlock,
  Maximize2,
  Minimize2,
  Keyboard,
  MousePointer,
  Activity,
  Compass,
  CornerDownLeft,
  Command,
  Sliders,
  Check,
  Power,
  RefreshCw,
  AlertCircle,
  HardDrive,
  Clipboard,
  Send,
  Sparkles,
  PenTool,
  KeyRound,
  AlertTriangle,
} from 'lucide-react';
import { useWebRTC } from '../hooks/useWebRTC';
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
import { StreamControls, QUALITY_PROFILES } from './StreamControls';
import { AnnotationCanvas, AnnotationMode } from './AnnotationCanvas';
import { useToast } from './ToastSystem';

interface ClientViewProps {
  initialRoomId?: string;
  initialPin?: string;
  onSwitchToHost?: () => void;
}

export const ClientView: React.FC<ClientViewProps> = ({ initialRoomId, initialPin, onSwitchToHost }) => {
  const { showToast } = useToast();
  const [roomIdInput, setRoomIdInput] = useState<string>(initialRoomId || '');
  const [pinInput, setPinInput] = useState<string>(initialPin || '');
  const [isJoined, setIsJoined] = useState<boolean>(false);
  const [isControlLocked, setIsControlLocked] = useState<boolean>(true); // true = remote control active
  const [showCoordinateHUD, setShowCoordinateHUD] = useState<boolean>(true);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);

  // Phase 4: Host Emergency Panic & UAC Alerts
  const [panicAlert, setPanicAlert] = useState<string | null>(null);
  const [isUACPaused, setIsUACPaused] = useState<boolean>(false);

  // Host Screen Metadata (default 1080p, dynamically adjustable)
  const [hostMetadata, setHostMetadata] = useState<HostScreenMetadata>({
    width: 1920,
    height: 1080,
    devicePixelRatio: 1.0,
  });

  // Quality Preset
  const [currentQualityProfile, setCurrentQualityProfile] = useState<StreamQualityProfile['id']>('performance');

  // Real-time Coordinate Translation State (Throttled for 60fps render loop)
  const [lastCoordResult, setLastCoordResult] = useState<CoordinateTranslationResult | null>(null);
  const lastCoordResultRef = useRef<CoordinateTranslationResult | null>(null);
  const rafIdRef = useRef<number | null>(null);

  // Clean up RAF on unmount
  useEffect(() => {
    return () => {
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, []);

  // Phase 3: Annotation & Laser Pointer State
  const [annotationMode, setAnnotationMode] = useState<AnnotationMode>('remote');
  const [incomingAnnotation, setIncomingAnnotation] = useState<AnnotationStrokePayload | null>(null);

  // Phase 3: File Transfer State
  const [isFileModalOpen, setIsFileModalOpen] = useState<boolean>(false);
  const [activeTransfers, setActiveTransfers] = useState<ActiveFileTransfer[]>([]);
  const fileTransferManagerRef = useRef<FileTransferManager>(new FileTransferManager());

  // Phase 3: Manual Clipboard input for demo
  const [manualClipInput, setManualClipInput] = useState('');

  // Modifier Keys State
  const [activeModifiers, setActiveModifiers] = useState<{
    ctrl: boolean;
    alt: boolean;
    shift: boolean;
    meta: boolean;
  }>({
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
  });

  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoElementRef = useRef<HTMLVideoElement | null>(null);

  // WebRTC Hook
  const {
    remoteStream,
    connectionState,
    isSocketConnected,
    dataChannelsReady,
    stats,
    joinRoom,
    leaveRoom,
    sendMousePacket,
    sendEventPacket,
    getDataChannelBufferedAmount,
  } = useWebRTC({
    role: 'client',
    roomId: isJoined ? roomIdInput : undefined,
    onRemotePacket: (packet) => handleIncomingPacket(packet),
  });

  // Phase 3: Clipboard Synchronization
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

  // Wire up FileTransferManager callbacks
  useEffect(() => {
    fileTransferManagerRef.current.setCallbacks(
      (packet) => sendEventPacket(packet),
      getDataChannelBufferedAmount,
      (transfers) => setActiveTransfers(transfers)
    );
  }, [getDataChannelBufferedAmount, sendEventPacket]);

  // Handle incoming remote packets on client side
  const handleIncomingPacket = useCallback(
    (packet: RemoteControlPacket) => {
      if (packet.type === 'PANIC_SEVER_CONNECTION') {
        setPanicAlert(packet.reason || 'Host initiated emergency panic severance.');
        setIsJoined(false);
        leaveRoom();
        return;
      }

      if (packet.type === 'HOST_UAC_PAUSED') {
        setIsUACPaused(packet.isPaused);
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
    if (videoElementRef.current && remoteStream) {
      videoElementRef.current.srcObject = remoteStream;
    }
  }, [remoteStream]);

  // Handle Room Join Action
  const handleJoin = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const cleanRoomId = roomIdInput.trim();
    if (!cleanRoomId || cleanRoomId.length < 4) {
      showToast({
        title: 'Invalid Session ID',
        description: 'Please enter a valid 6-digit Session ID.',
        type: 'warning',
      });
      return;
    }

    setPanicAlert(null);
    showToast({
      title: 'Connecting to Host',
      description: `Joining session ${cleanRoomId}...`,
      type: 'info',
      duration: 3000,
    });
    await joinRoom(cleanRoomId, 'client', pinInput.trim().toUpperCase());
    setIsJoined(true);
  };

  // Handle Disconnect
  const handleDisconnect = () => {
    leaveRoom();
    setIsJoined(false);
    setLastCoordResult(null);
    showToast({
      title: 'Session Disconnected',
      description: 'WebRTC P2P channels closed.',
      type: 'info',
      duration: 3000,
    });
  };

  // Extract Bounding Box of the Container / Video
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

  // 1. Mouse Move Pipeline (High-frequency 120Hz zero-latency stream)
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!isControlLocked || annotationMode !== 'remote') return;
      const bbox = getVideoBoundingBox();
      if (!bbox) return;

      const result = calculateRemoteCoordinates(e.clientX, e.clientY, bbox, hostMetadata);
      lastCoordResultRef.current = result;

      // Throttle React state HUD update to display refresh rate
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

      // If pointer is inside active letterboxed area, send over channel-mouse (Unreliable 0ms UDP)
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

  // 2. Mouse Down Pipeline (Clicks)
  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!isControlLocked || annotationMode !== 'remote') return;
      e.preventDefault();

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

  // 4. Context Menu (Prevent local right click browser menu)
  const handleContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  // 5. Mouse Wheel Pipeline
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

  // 6. Keyboard Down & Up Pipeline
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!isControlLocked || annotationMode !== 'remote') return;

      if (
        e.key === 'Tab' ||
        e.key === 'Alt' ||
        e.key === 'Meta' ||
        (e.ctrlKey && (e.key === 'w' || e.key === 'r' || e.key === 't'))
      ) {
        e.preventDefault();
      }

      const packet: RemoteKeyboardPayload = {
        type: 'KEY_DOWN',
        key: e.key,
        code: e.code,
        ctrlKey: e.ctrlKey || activeModifiers.ctrl,
        altKey: e.altKey || activeModifiers.alt,
        shiftKey: e.shiftKey || activeModifiers.shift,
        metaKey: e.metaKey || activeModifiers.meta,
        timestamp: Date.now(),
      };

      sendEventPacket(packet);
    },
    [activeModifiers, annotationMode, isControlLocked, sendEventPacket]
  );

  const handleKeyUp = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!isControlLocked || annotationMode !== 'remote') return;
      e.preventDefault();

      const packet: RemoteKeyboardPayload = {
        type: 'KEY_UP',
        key: e.key,
        code: e.code,
        ctrlKey: e.ctrlKey || activeModifiers.ctrl,
        altKey: e.altKey || activeModifiers.alt,
        shiftKey: e.shiftKey || activeModifiers.shift,
        metaKey: e.metaKey || activeModifiers.meta,
        timestamp: Date.now(),
      };

      sendEventPacket(packet);
    },
    [activeModifiers, annotationMode, isControlLocked, sendEventPacket]
  );

  // Keyboard shortcut simulator (e.g. Ctrl+Alt+Del, Win Key, etc.)
  const dispatchSpecialKey = (key: string, code: string, modifiers?: Partial<typeof activeModifiers>) => {
    const packetDown: RemoteKeyboardPayload = {
      type: 'KEY_DOWN',
      key,
      code,
      ctrlKey: modifiers?.ctrl || activeModifiers.ctrl,
      altKey: modifiers?.alt || activeModifiers.alt,
      shiftKey: modifiers?.shift || activeModifiers.shift,
      metaKey: modifiers?.meta || activeModifiers.meta,
      timestamp: Date.now(),
    };
    sendEventPacket(packetDown);

    setTimeout(() => {
      const packetUp: RemoteKeyboardPayload = {
        type: 'KEY_UP',
        key,
        code,
        ctrlKey: modifiers?.ctrl || activeModifiers.ctrl,
        altKey: modifiers?.alt || activeModifiers.alt,
        shiftKey: modifiers?.shift || activeModifiers.shift,
        metaKey: modifiers?.meta || activeModifiers.meta,
        timestamp: Date.now(),
      };
      sendEventPacket(packetUp);
    }, 80);
  };

  // Toggle Fullscreen on video element
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

  const handleClientUploadFiles = (files: FileList) => {
    Array.from(files).forEach((file) => {
      fileTransferManagerRef.current.sendFile(file);
    });
  };

  const handleManualSyncClipboard = (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualClipInput.trim()) return;
    manualSyncText(manualClipInput.trim());
    setManualClipInput('');
  };

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-2">
      {/* Emergency Panic Severance Alert Banner */}
      {panicAlert && (
        <div className="bg-rose-950/80 border-2 border-rose-500 rounded-2xl p-4 shadow-[0_0_30px_rgba(244,63,94,0.35)] backdrop-blur-xl flex items-center justify-between gap-4 animate-fadeIn">
          <div className="flex items-center space-x-3 text-rose-200">
            <div className="p-2 bg-rose-500/20 rounded-xl border border-rose-500/40 animate-pulse">
              <AlertTriangle className="w-5 h-5 text-rose-400" />
            </div>
            <div>
              <h4 className="font-bold text-white text-sm">Host Triggered Emergency Panic Severance</h4>
              <p className="text-xs font-mono text-rose-300">{panicAlert}</p>
            </div>
          </div>
          <button
            onClick={() => setPanicAlert(null)}
            className="px-3.5 py-1.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-mono text-xs font-semibold transition-all shrink-0"
          >
            Dismiss Alert
          </button>
        </div>
      )}

      {/* Windows UAC Paused Alert */}
      {isUACPaused && (
        <div className="bg-amber-950/80 border border-amber-500/80 rounded-2xl p-4 shadow-lg backdrop-blur-xl flex items-center gap-3 animate-fadeIn">
          <AlertCircle className="w-5 h-5 text-amber-400 shrink-0 animate-bounce" />
          <div className="text-xs text-amber-200 font-mono">
            <span className="font-bold text-white">Host in Windows Secure Desktop (UAC Prompt):</span> Stream and remote inputs are temporarily suspended until the Host dismisses the prompt.
          </div>
        </div>
      )}

      {/* Top Banner */}
      <div className="bg-[#0c0e18]/90 border border-cyan-500/20 rounded-2xl p-6 shadow-[0_8px_32px_rgba(0,0,0,0.5)] backdrop-blur-xl relative overflow-hidden">
        <div className="absolute -right-16 -top-16 w-64 h-64 bg-cyan-500/10 rounded-full blur-3xl pointer-events-none" />
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 relative z-10">
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 shadow-[0_0_10px_rgba(0,210,255,0.15)] flex items-center gap-1.5">
                <Compass className="w-3.5 h-3.5 text-cyan-400 animate-pulse" />
                Client Remote Controller (Phase 4)
              </span>
              <span className="text-xs text-slate-400 font-mono">
                Dual-Layer TOTP Auth & Zero-Latency Ingress Control
              </span>
            </div>
            <h2 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
              <span className="bg-gradient-to-r from-white via-cyan-100 to-cyan-300 bg-clip-text text-transparent">
                High-Precision Remote Desktop Viewer & Control Hub
              </span>
            </h2>
            <p className="text-sm text-slate-300 max-w-2xl leading-relaxed">
              Connect to any Host session ID with real-time 4-character rotating PIN verification, laser pointer overlays, and sub-millisecond input control.
            </p>
          </div>

          {/* Quick Room Connect Form with Session ID & Rotating PIN */}
          <form onSubmit={handleJoin} className="flex flex-wrap sm:flex-nowrap items-center gap-2 self-start lg:self-center">
            <div className="flex items-center gap-2">
              <input
                type="text"
                id="room-id-input"
                placeholder="6-Digit Session"
                value={roomIdInput}
                onChange={(e) => setRoomIdInput(e.target.value)}
                disabled={isJoined}
                maxLength={12}
                className="bg-[#07080f] border border-cyan-500/30 rounded-xl px-3 py-2 text-sm font-mono text-cyan-200 placeholder-slate-500 focus:outline-none focus:border-cyan-400 w-36 tracking-widest text-center"
              />
              <input
                type="text"
                id="pin-auth-input"
                placeholder="4-Char PIN"
                value={pinInput}
                onChange={(e) => setPinInput(e.target.value.toUpperCase())}
                disabled={isJoined}
                maxLength={4}
                className="bg-[#07080f] border border-emerald-500/30 rounded-xl px-2.5 py-2 text-sm font-mono text-emerald-300 placeholder-slate-500 focus:outline-none focus:border-emerald-400 w-28 tracking-widest text-center uppercase"
                title="4-Character Rotating Security PIN provided by Host"
              />
            </div>
            {!isJoined ? (
              <button
                id="join-room-button"
                type="submit"
                className="px-4 py-2 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-slate-950 font-bold text-xs flex items-center gap-2 shadow-[0_0_20px_rgba(6,182,212,0.4)] transition-all font-mono shrink-0"
              >
                <Zap className="w-4 h-4 fill-current" />
                <span>Connect</span>
              </button>
            ) : (
              <button
                id="disconnect-room-button"
                type="button"
                onClick={handleDisconnect}
                className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs flex items-center gap-2 shadow-lg transition-all font-mono shrink-0"
              >
                <Power className="w-4 h-4" />
                <span>Disconnect</span>
              </button>
            )}
          </form>
        </div>
      </div>

      {/* Main Grid Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Remote Stream & Canvas Viewport (8 Cols) */}
        <div className="lg:col-span-8 space-y-6">
          <div className="bg-[#0c0e18]/90 border border-cyan-500/20 rounded-2xl p-5 space-y-4 shadow-xl backdrop-blur-xl">
            {/* Viewport Header Controls */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-cyan-500/15 pb-4">
              <div className="flex items-center space-x-2">
                <Tv className="w-4 h-4 text-cyan-400" />
                <h3 className="font-bold text-white text-base">Remote Screen Viewport</h3>
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
                    {connectionState === 'connected' ? 'STREAM CONNECTED' : 'INITIALIZING'}
                  </span>
                )}
              </div>

              {/* Viewport Control Actions */}
              <div className="flex items-center space-x-2 flex-wrap">
                {/* File Transfer Trigger Button */}
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

            {/* Interactive Remote Desktop Container with Annotation Layer */}
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

              {/* Phase 3: Interactive Annotation & Laser Pointer Layer */}
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
                    <p className="text-base font-semibold text-slate-200">No Active Stream Connected</p>
                    <p className="text-xs text-slate-400 max-w-sm mx-auto mt-1">
                      Enter the Host&apos;s 6-digit Room ID above or start a simulation on the Host tab to begin remote control.
                    </p>
                  </div>
                </div>
              )}

              {/* Coordinate Normalization Real-Time HUD Overlay */}
              {showCoordinateHUD && lastCoordResult && (
                <div className="absolute bottom-3 left-3 z-30 bg-[#07080f]/90 backdrop-blur-md p-3 rounded-xl border border-cyan-500/30 text-[11px] font-mono text-cyan-200 space-y-1 shadow-2xl pointer-events-none">
                  <div className="text-[10px] uppercase text-slate-400 font-bold border-b border-cyan-500/20 pb-1">
                    Coordinate Math HUD
                  </div>
                  <div>
                    Normalized (u, v):{' '}
                    <span className="text-cyan-400 font-bold">
                      ({lastCoordResult.normalizedX.toFixed(4)}, {lastCoordResult.normalizedY.toFixed(4)})
                    </span>
                  </div>
                  <div>
                    Target Host Screen:{' '}
                    <span className="text-emerald-400 font-bold">
                      ({lastCoordResult.hostLogicalX}px, {lastCoordResult.hostLogicalY}px)
                    </span>
                  </div>
                  <div className="text-slate-400 text-[10px]">
                    Active Video Area: {Math.round(lastCoordResult.renderedWidth)}x{Math.round(lastCoordResult.renderedHeight)} (Offset: X={Math.round(lastCoordResult.offsetX)}, Y={Math.round(lastCoordResult.offsetY)})
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Stream Quality Controls */}
          <StreamControls
            currentProfile={currentQualityProfile}
            onSelectProfile={(p) => {
              setCurrentQualityProfile(p);
              const profile = QUALITY_PROFILES.find((q) => q.id === p);
              if (profile) {
                setHostMetadata((prev) => ({
                  ...prev,
                  width: profile.resolution.width,
                  height: profile.resolution.height,
                }));
              }
            }}
            isHost={false}
          />

          {/* Phase 3: Client Clipboard Sync Station */}
          <div className="bg-[#0c0e18]/90 border border-cyan-500/20 rounded-2xl p-5 space-y-4 shadow-xl backdrop-blur-xl">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <Clipboard className="w-4 h-4 text-cyan-400" />
                <h3 className="font-bold text-white text-base">Client OS Clipboard Bridge</h3>
              </div>
              <span className="text-xs font-mono px-2 py-0.5 rounded bg-cyan-950/60 border border-cyan-500/20 text-cyan-300">
                Bidirectional Sync • {syncCount} Updates
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="p-3 bg-[#07080f] rounded-xl border border-cyan-500/20 space-y-1.5 text-xs font-mono">
                <span className="text-slate-400 block text-[11px]">Last Synced Clipboard Payload</span>
                <p className="text-cyan-200 truncate bg-[#0d101a] p-2 rounded border border-slate-800">
                  {lastSyncText || '(No clipboard text synced yet)'}
                </p>
                <div className="text-[10px] text-slate-400 flex justify-between">
                  <span>Source: {lastSource.toUpperCase()}</span>
                  <span>Time: {lastSyncTime || '--:--:--'}</span>
                </div>
              </div>

              {/* Manual Send to Host */}
              <form onSubmit={handleManualSyncClipboard} className="p-3 bg-[#07080f] rounded-xl border border-cyan-500/20 space-y-2 text-xs">
                <span className="text-slate-400 block font-medium">Broadcast Text to Host Clipboard</span>
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="Type text to send to Host clipboard..."
                    value={manualClipInput}
                    onChange={(e) => setManualClipInput(e.target.value)}
                    className="flex-1 bg-[#05060b] border border-cyan-500/30 rounded px-2.5 py-1.5 text-slate-200 text-xs font-mono focus:outline-none focus:border-cyan-400"
                  />
                  <button
                    type="submit"
                    className="px-3 py-1.5 rounded bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 border border-cyan-500/40 text-xs font-medium flex items-center gap-1"
                  >
                    <Send className="w-3 h-3" />
                    <span>Sync</span>
                  </button>
                </div>
              </form>
            </div>
          </div>

          {/* Quick Remote Keyboard Shortcuts Bar */}
          <div className="bg-[#0b0d17]/90 border border-cyan-500/20 rounded-2xl p-4 shadow-xl backdrop-blur-xl space-y-2.5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-bold text-white flex items-center gap-1.5">
                <Keyboard className="w-4 h-4 text-cyan-400" />
                Quick Host Keyboard Shortcuts (Forwarded over channel-events)
              </span>
              <span className="text-slate-400 font-mono text-[11px]">Reliable TCP Mode</span>
            </div>

            <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
              <button
                onClick={() => dispatchSpecialKey('Delete', 'Delete', { ctrl: true, alt: true })}
                className="px-2.5 py-1.5 rounded-lg bg-[#07080f] hover:bg-cyan-950/60 text-cyan-300 border border-cyan-500/20 text-xs font-mono font-semibold transition-all text-center"
              >
                Ctrl+Alt+Del
              </button>
              <button
                onClick={() => dispatchSpecialKey('Meta', 'MetaLeft', { meta: true })}
                className="px-2.5 py-1.5 rounded-lg bg-[#07080f] hover:bg-cyan-950/60 text-cyan-300 border border-cyan-500/20 text-xs font-mono font-semibold transition-all text-center"
              >
                Win / ⌘ Key
              </button>
              <button
                onClick={() => dispatchSpecialKey('Tab', 'Tab', { alt: true })}
                className="px-2.5 py-1.5 rounded-lg bg-[#07080f] hover:bg-cyan-950/60 text-cyan-300 border border-cyan-500/20 text-xs font-mono font-semibold transition-all text-center"
              >
                Alt+Tab
              </button>
              <button
                onClick={() => dispatchSpecialKey('Escape', 'Escape')}
                className="px-2.5 py-1.5 rounded-lg bg-[#07080f] hover:bg-cyan-950/60 text-cyan-300 border border-cyan-500/20 text-xs font-mono font-semibold transition-all text-center"
              >
                Escape (Esc)
              </button>
              <button
                onClick={() => dispatchSpecialKey('c', 'KeyC', { ctrl: true })}
                className="px-2.5 py-1.5 rounded-lg bg-[#07080f] hover:bg-cyan-950/60 text-cyan-300 border border-cyan-500/20 text-xs font-mono font-semibold transition-all text-center"
              >
                Ctrl + C
              </button>
              <button
                onClick={() => dispatchSpecialKey('v', 'KeyV', { ctrl: true })}
                className="px-2.5 py-1.5 rounded-lg bg-[#07080f] hover:bg-cyan-950/60 text-cyan-300 border border-cyan-500/20 text-xs font-mono font-semibold transition-all text-center"
              >
                Ctrl + V
              </button>
            </div>
          </div>
        </div>

        {/* Right Column: Connection Diagnostics & Host Screen Target Config (4 Cols) */}
        <div className="lg:col-span-4 space-y-6">
          {/* Target Host Screen Config */}
          <div className="bg-[#0b0d17]/90 border border-cyan-500/20 rounded-2xl p-5 space-y-4 shadow-xl backdrop-blur-xl">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-white text-base flex items-center gap-2">
                <Sliders className="w-4 h-4 text-cyan-400" />
                Target Monitor Settings
              </h3>
              <span className="text-xs font-mono text-cyan-400/80 bg-cyan-950/40 px-2 py-0.5 rounded border border-cyan-500/20">
                Resolution
              </span>
            </div>

            <p className="text-xs text-slate-300 leading-relaxed">
              Coordinates are calculated relative to the Host&apos;s physical resolution and DPR factor:
            </p>

            <div className="space-y-3 p-3 bg-[#07080f] rounded-xl border border-cyan-500/15 text-xs">
              <div>
                <label className="text-slate-400 font-medium block mb-1">Host Resolution Preset</label>
                <div className="grid grid-cols-2 gap-2 font-mono">
                  <button
                    onClick={() => setHostMetadata({ width: 1920, height: 1080, devicePixelRatio: 1.0 })}
                    className={`p-2 rounded-lg border transition-all text-left ${
                      hostMetadata.width === 1920
                        ? 'bg-cyan-500/20 border-cyan-400 text-cyan-200'
                        : 'bg-[#0d101a] border-slate-800 text-slate-400'
                    }`}
                  >
                    1080p FHD (1920x1080)
                  </button>
                  <button
                    onClick={() => setHostMetadata({ width: 3840, height: 2160, devicePixelRatio: 2.0 })}
                    className={`p-2 rounded-lg border transition-all text-left ${
                      hostMetadata.width === 3840
                        ? 'bg-cyan-500/20 border-cyan-400 text-cyan-200'
                        : 'bg-[#0d101a] border-slate-800 text-slate-400'
                    }`}
                  >
                    4K UHD (3840x2160)
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 pt-1">
                <div>
                  <span className="text-slate-400 block text-[10px]">Width (px)</span>
                  <input
                    type="number"
                    value={hostMetadata.width}
                    onChange={(e) => setHostMetadata((prev) => ({ ...prev, width: parseInt(e.target.value) || 1920 }))}
                    className="w-full bg-[#05060b] border border-cyan-500/20 rounded px-2 py-1 text-white font-mono"
                  />
                </div>
                <div>
                  <span className="text-slate-400 block text-[10px]">Height (px)</span>
                  <input
                    type="number"
                    value={hostMetadata.height}
                    onChange={(e) => setHostMetadata((prev) => ({ ...prev, height: parseInt(e.target.value) || 1080 }))}
                    className="w-full bg-[#05060b] border border-cyan-500/20 rounded px-2 py-1 text-white font-mono"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* WebRTC Diagnostics & Telemetry */}
          <div className="bg-[#0b0d17]/90 border border-cyan-500/20 rounded-2xl p-5 space-y-4 shadow-xl backdrop-blur-xl">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-white text-base flex items-center gap-2">
                <Activity className="w-4 h-4 text-emerald-400" />
                Connection Telemetry
              </h3>
              <span className="text-xs font-mono text-emerald-400 font-bold">
                {stats.rttMs} ms RTT
              </span>
            </div>

            <div className="space-y-2 font-mono text-xs">
              <div className="p-2.5 bg-[#07080f] rounded-xl border border-cyan-500/15 flex justify-between items-center">
                <span className="text-slate-400">Stream FPS:</span>
                <span className="text-emerald-400 font-bold">{stats.fps} FPS</span>
              </div>
              <div className="p-2.5 bg-[#07080f] rounded-xl border border-cyan-500/15 flex justify-between items-center">
                <span className="text-slate-400">Bitrate:</span>
                <span className="text-cyan-300 font-bold">{stats.bitrateKbps} kbps</span>
              </div>
              <div className="p-2.5 bg-[#07080f] rounded-xl border border-cyan-500/15 flex justify-between items-center">
                <span className="text-slate-400">Packets Emitted:</span>
                <span className="text-slate-200 font-bold">{stats.packetsSent}</span>
              </div>
              <div className="p-2.5 bg-[#07080f] rounded-xl border border-cyan-500/15 flex justify-between items-center">
                <span className="text-slate-400">Mouse Channel:</span>
                <span className={dataChannelsReady.mouse ? 'text-emerald-400' : 'text-slate-500'}>
                  {dataChannelsReady.mouse ? 'OPEN (UDP Mode)' : 'Connecting'}
                </span>
              </div>
              <div className="p-2.5 bg-[#07080f] rounded-xl border border-cyan-500/15 flex justify-between items-center">
                <span className="text-slate-400">Events Channel:</span>
                <span className={dataChannelsReady.events ? 'text-emerald-400' : 'text-slate-500'}>
                  {dataChannelsReady.events ? 'OPEN (TCP Mode)' : 'Connecting'}
                </span>
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
        onUploadFiles={handleClientUploadFiles}
        onCancelTransfer={(id) => fileTransferManagerRef.current.cancelTransfer(id)}
        onClearCompleted={() => fileTransferManagerRef.current.clearCompleted()}
        isPeerConnected={connectionState === 'connected'}
      />
    </div>
  );
};
