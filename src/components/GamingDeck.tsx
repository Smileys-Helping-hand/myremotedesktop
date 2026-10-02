import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Gamepad2,
  Tv,
  Zap,
  Sliders,
  Volume2,
  VolumeX,
  Crosshair,
  Keyboard,
  Radio,
  Play,
  Square,
  ShieldCheck,
  Cpu,
} from 'lucide-react';
import { useWebRTC, getDefaultSignalUrl } from '../hooks/useWebRTC';
import {
  GamepadStatePayload,
  RemoteMouseRelativePayload,
  Player2KeymapConfig,
  VigemStatus,
} from '../types/remoteControl';
import {
  DEFAULT_PLAYER2_KEYMAP,
  ARCADE_PLAYER2_KEYMAP,
  GamepadPoller,
  HostPlayer2Dispatcher,
  gamepadStateToX360Report,
} from '../utils/gamepadManager';
import {
  tauriVigemStatus,
  tauriVigemPlugin,
  tauriVigemUnplug,
  tauriVigemUpdateX360,
  tauriInjectMouseRelative,
} from '../utils/tauriBridge';
import { useToast } from './ToastSystem';

interface GamingDeckProps {
  initialRoomId?: string;
  initialPin?: string;
}

export const GamingDeck: React.FC<GamingDeckProps> = ({
  initialRoomId = '784920',
  initialPin = '',
}) => {
  const { showToast } = useToast();

  // Mode: Client (Laptop Controller) vs Host (Gaming Rig Receiver)
  const [activeRole, setActiveRole] = useState<'client' | 'host'>('client');
  const [roomIdInput, setRoomIdInput] = useState<string>(initialRoomId);
  const [pinInput, setPinInput] = useState<string>(initialPin);
  const [serverUrlInput] = useState<string>(() => getDefaultSignalUrl());

  // Gamepad State
  const [detectedGamepadName, setDetectedGamepadName] = useState<string | null>(null);
  const [virtualKeyboardEnabled, setVirtualKeyboardEnabled] = useState<boolean>(true);
  const [playerIndex, setPlayerIndex] = useState<number>(1); // Player 2 by default
  const [deadzone, setDeadzone] = useState<number>(0.12);
  const [packetsSentCount, setPacketsSentCount] = useState<number>(0);
  const [pointerLockActive, setPointerLockActive] = useState<boolean>(false);
  const [isAudioMuted, setIsAudioMuted] = useState<boolean>(false);

  // Live Controller HUD state
  const [activeButtons, setActiveButtons] = useState<boolean[]>(new Array(17).fill(false));
  const [triggerValues, setTriggerValues] = useState<{ lt: number; rt: number }>({ lt: 0, rt: 0 });
  const [axesValues, setAxesValues] = useState<number[]>([0, 0, 0, 0]);

  // Host Player 2 Keymap & ViGEm State
  const [selectedKeymapPreset, setSelectedKeymapPreset] = useState<'numpad' | 'arcade'>('numpad');
  const [vigemStatus, setVigemStatus] = useState<VigemStatus | null>(null);
  const [vigemActive, setVigemActive] = useState<boolean>(false);
  const hostDispatcherRef = useRef<HostPlayer2Dispatcher>(
    new HostPlayer2Dispatcher(DEFAULT_PLAYER2_KEYMAP)
  );

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Probe ViGEm capabilities on mount
  useEffect(() => {
    let cancelled = false;
    tauriVigemStatus().then((status) => {
      if (cancelled || !status) return;
      setVigemStatus(status);
      if (status.controllerPlugged) {
        setVigemActive(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [activeRole]);

  const handleToggleVigem = async () => {
    if (!vigemStatus?.driverInstalled) {
      showToast({
        title: 'ViGEmBus Driver Not Installed',
        description:
          'Install ViGEmBus driver to emulate physical Xbox 360 controllers on Windows. Falling back to Driverless DirectInput / Numpad co-op mode.',
        type: 'warning',
        duration: 7000,
      });
      return;
    }

    if (vigemActive) {
      await tauriVigemUnplug();
      setVigemActive(false);
      showToast({
        title: 'Virtual Controller Disconnected',
        description: 'Switched to Driverless DirectInput / Numpad co-op mode.',
        type: 'info',
        duration: 4000,
      });
    } else {
      const ok = await tauriVigemPlugin();
      if (ok) {
        setVigemActive(true);
        showToast({
          title: 'Virtual Xbox 360 Controller Active',
          description: 'Windows games will now detect Player 2 as a physical controller.',
          type: 'success',
          duration: 5000,
        });
      } else {
        showToast({
          title: 'Controller Connection Failed',
          description: 'Could not connect virtual controller. Check ViGEmBus service.',
          type: 'error',
          duration: 6000,
        });
      }
    }
  };

  // WebRTC Hook
  const {
    remoteStream,
    connectionState,
    stats,
    joinRoom,
    registerHost,
    leaveRoom,
    sendGamepadPacket,
    sendMouseRelativePacket,
  } = useWebRTC({
    role: activeRole,
    roomId: roomIdInput,
    pin: pinInput,
    serverUrl: serverUrlInput,
    onRemoteGamepad: (packet) => {
      if (activeRole === 'host') {
        if (vigemActive) {
          tauriVigemUpdateX360(gamepadStateToX360Report(packet));
        } else {
          hostDispatcherRef.current.dispatch(packet);
        }
        // Update local HUD preview on host
        const btns = packet.buttons.map((b) => b.pressed);
        setActiveButtons(btns);
        setTriggerValues({
          lt: packet.buttons[6]?.value ?? 0,
          rt: packet.buttons[7]?.value ?? 0,
        });
        setAxesValues(packet.axes);
      }
    },
    onRemoteMouseRelative: (packet) => {
      if (activeRole === 'host') {
        tauriInjectMouseRelative(packet.dx, packet.dy);
      }
    },
  });

  // Switch Keymap Preset on Host
  useEffect(() => {
    const keymap: Player2KeymapConfig =
      selectedKeymapPreset === 'numpad' ? DEFAULT_PLAYER2_KEYMAP : ARCADE_PLAYER2_KEYMAP;
    hostDispatcherRef.current.setKeymap(keymap);
  }, [selectedKeymapPreset]);

  // Connect remote stream to video
  useEffect(() => {
    if (videoRef.current && remoteStream) {
      videoRef.current.srcObject = remoteStream;
      videoRef.current.muted = isAudioMuted;
      videoRef.current.play().catch(() => {});
    }
  }, [remoteStream, isAudioMuted]);

  // Handle Gamepad Poller
  const handleGamepadState = useCallback(
    (state: GamepadStatePayload) => {
      // Update local HUD
      const btns = state.buttons.map((b) => b.pressed);
      setActiveButtons(btns);
      setTriggerValues({
        lt: state.buttons[6]?.value ?? 0,
        rt: state.buttons[7]?.value ?? 0,
      });
      setAxesValues(state.axes);

      // Transmit over WebRTC DataChannel (UDP Mode: Zero Latency)
      if (activeRole === 'client' && connectionState === 'connected') {
        const sent = sendGamepadPacket(state);
        if (sent) {
          setPacketsSentCount((prev) => prev + 1);
        }
      }
    },
    [activeRole, connectionState, sendGamepadPacket]
  );

  // Initialize Poller
  useEffect(() => {
    const poller = new GamepadPoller(handleGamepadState, playerIndex, deadzone);
    poller.start();

    // Gamepad Connection Listeners
    const onConnect = (e: GamepadEvent) => {
      setDetectedGamepadName(e.gamepad.id);
      showToast({
        title: 'Gamepad Connected',
        description: `${e.gamepad.id} assigned as Player ${playerIndex + 1}`,
        type: 'success',
      });
    };
    const onDisconnect = () => {
      setDetectedGamepadName(null);
      showToast({
        title: 'Gamepad Disconnected',
        description: 'Falling back to Virtual Laptop Keyboard Controller.',
        type: 'warning',
      });
    };

    window.addEventListener('gamepadconnected', onConnect);
    window.addEventListener('gamepaddisconnected', onDisconnect);

    return () => {
      poller.stop();
      window.removeEventListener('gamepadconnected', onConnect);
      window.removeEventListener('gamepaddisconnected', onDisconnect);
    };
  }, [handleGamepadState, playerIndex, deadzone, showToast]);

  // Keyboard Virtual Gamepad Handler (when Laptop has no physical controller)
  useEffect(() => {
    if (!virtualKeyboardEnabled || activeRole !== 'client') return;

    const pressedVirtualKeys = new Set<string>();

    const updateVirtualGamepad = () => {
      const buttons = new Array(17).fill(null).map(() => ({ pressed: false, value: 0 }));
      const axes = [0, 0, 0, 0];

      // D-Pad / Left Stick: WASD or Arrows
      if (pressedVirtualKeys.has('KeyW') || pressedVirtualKeys.has('ArrowUp')) {
        axes[1] = -1;
        buttons[12] = { pressed: true, value: 1 };
      }
      if (pressedVirtualKeys.has('KeyS') || pressedVirtualKeys.has('ArrowDown')) {
        axes[1] = 1;
        buttons[13] = { pressed: true, value: 1 };
      }
      if (pressedVirtualKeys.has('KeyA') || pressedVirtualKeys.has('ArrowLeft')) {
        axes[0] = -1;
        buttons[14] = { pressed: true, value: 1 };
      }
      if (pressedVirtualKeys.has('KeyD') || pressedVirtualKeys.has('ArrowRight')) {
        axes[0] = 1;
        buttons[15] = { pressed: true, value: 1 };
      }

      // Face Buttons: Space (A), K (B), J (X), I (Y)
      if (pressedVirtualKeys.has('Space')) buttons[0] = { pressed: true, value: 1 };
      if (pressedVirtualKeys.has('KeyK')) buttons[1] = { pressed: true, value: 1 };
      if (pressedVirtualKeys.has('KeyJ')) buttons[2] = { pressed: true, value: 1 };
      if (pressedVirtualKeys.has('KeyI')) buttons[3] = { pressed: true, value: 1 };

      // Shoulders & Triggers: U (LB), O (RB), Q (LT), E (RT)
      if (pressedVirtualKeys.has('KeyU')) buttons[4] = { pressed: true, value: 1 };
      if (pressedVirtualKeys.has('KeyO')) buttons[5] = { pressed: true, value: 1 };
      if (pressedVirtualKeys.has('KeyQ')) buttons[6] = { pressed: true, value: 1 };
      if (pressedVirtualKeys.has('KeyE')) buttons[7] = { pressed: true, value: 1 };

      // Select / Start
      if (pressedVirtualKeys.has('Tab') || pressedVirtualKeys.has('Backspace'))
        buttons[8] = { pressed: true, value: 1 };
      if (pressedVirtualKeys.has('Enter')) buttons[9] = { pressed: true, value: 1 };

      handleGamepadState({
        type: 'GAMEPAD_STATE',
        playerIndex,
        id: 'Laptop Virtual Keyboard Controller',
        buttons,
        axes,
        timestamp: Date.now(),
      });
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      // Avoid stealing input if typing in an input element
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;

      const trackedKeys = [
        'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
        'Space', 'KeyK', 'KeyJ', 'KeyI', 'KeyU', 'KeyO', 'KeyQ', 'KeyE', 'Enter', 'Tab',
      ];
      if (trackedKeys.includes(e.code)) {
        e.preventDefault();
        pressedVirtualKeys.add(e.code);
        updateVirtualGamepad();
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (pressedVirtualKeys.has(e.code)) {
        pressedVirtualKeys.delete(e.code);
        updateVirtualGamepad();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [virtualKeyboardEnabled, activeRole, playerIndex, handleGamepadState]);

  // Pointer Lock for FPS Games
  const togglePointerLock = () => {
    if (!containerRef.current) return;
    if (document.pointerLockElement) {
      document.exitPointerLock();
      setPointerLockActive(false);
    } else {
      containerRef.current.requestPointerLock();
      setPointerLockActive(true);
      showToast({
        title: 'FPS Pointer Lock Active',
        description: 'Mouse captured. Press ESC to unlock.',
        type: 'info',
      });
    }
  };

  useEffect(() => {
    const onPointerLockChange = () => {
      setPointerLockActive(!!document.pointerLockElement);
    };
    document.addEventListener('pointerlockchange', onPointerLockChange);
    return () => {
      document.removeEventListener('pointerlockchange', onPointerLockChange);
    };
  }, []);

  const handleMouseMove = (e: React.MouseEvent) => {
    if (pointerLockActive && connectionState === 'connected') {
      const packet: RemoteMouseRelativePayload = {
        type: 'MOUSE_RELATIVE',
        dx: e.movementX,
        dy: e.movementY,
        timestamp: Date.now(),
      };
      sendMouseRelativePacket(packet);
    }
  };

  // Rumble test
  const handleTestRumble = () => {
    const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const gp of gamepads) {
      if (gp && gp.vibrationActuator) {
        (gp.vibrationActuator as any)
          .playEffect('dual-rumble', {
            startDelay: 0,
            duration: 350,
            weakMagnitude: 0.8,
            strongMagnitude: 0.6,
          })
          .catch(() => {});
        showToast({
          title: 'Haptic Feedback Sent',
          description: `Vibrated ${gp.id}`,
          type: 'success',
        });
        return;
      }
    }
    showToast({
      title: 'No Vibration Actuator',
      description: 'Connected controller does not support W3C dual-rumble API.',
      type: 'info',
    });
  };

  // Join or Host Game Session
  const handleStartSession = async () => {
    if (activeRole === 'client') {
      await joinRoom(roomIdInput.trim(), 'client', pinInput.trim().toUpperCase(), false);
      showToast({
        title: 'Connecting as Player 2 Controller',
        description: `Negotiating low-latency gaming stream with Desk ${roomIdInput}...`,
        type: 'info',
      });
    } else {
      registerHost(roomIdInput.trim(), pinInput.trim().toUpperCase(), true);
      showToast({
        title: 'Host Game Rig Active',
        description: `Desk ID ${roomIdInput} ready for Player 2 connection.`,
        type: 'success',
      });
    }
  };

  const handleDisconnect = () => {
    leaveRoom();
    showToast({
      title: 'Gaming Session Closed',
      description: 'Controller unmapped and connection severed.',
      type: 'info',
    });
  };

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-8">
      {/* 1. Header Banner */}
      <div className="bg-[#090b16]/95 border border-cyan-500/25 rounded-2xl p-6 shadow-2xl backdrop-blur-xl relative overflow-hidden">
        <div className="absolute -right-20 -top-20 w-80 h-80 bg-gradient-to-br from-cyan-500/10 via-indigo-500/10 to-transparent rounded-full blur-3xl pointer-events-none" />

        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-5 relative z-10">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="px-3 py-1 rounded-full text-xs font-semibold bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 flex items-center gap-1.5 shadow-sm">
                <Gamepad2 className="w-4 h-4 text-cyan-400" />
                Dedicated Gaming Deck • Player 2 Co-op
              </span>
              <span className="text-xs text-emerald-300 font-mono bg-emerald-950/50 border border-emerald-500/30 px-2.5 py-0.5 rounded-full flex items-center gap-1">
                <Zap className="w-3.5 h-3.5 text-emerald-400" />
                Sub-Millisecond UDP Input Channel
              </span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
              Laptop Controller & Co-op Arena
            </h1>
            <p className="text-sm text-slate-300 max-w-2xl leading-relaxed">
              Use your laptop as a zero-latency second local controller for PC games, emulators, or local co-op titles.
              Supports physical Xbox/PlayStation gamepads and on-screen virtual keyboard controls over local Wi-Fi or outside WAN connections.
            </p>
          </div>

          {/* Role Pill Selector */}
          <div className="flex items-center bg-[#060810] border border-cyan-500/30 p-1.5 rounded-xl shadow-inner">
            <button
              onClick={() => setActiveRole('client')}
              className={`px-4 py-2 rounded-lg text-xs font-bold font-mono transition-all duration-200 flex items-center gap-2 ${
                activeRole === 'client'
                  ? 'bg-gradient-to-r from-cyan-500/20 to-blue-500/20 text-cyan-200 border border-cyan-400/40 shadow-md'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Gamepad2 className="w-4 h-4" />
              <span>Player 2 (Laptop)</span>
            </button>
            <button
              onClick={() => setActiveRole('host')}
              className={`px-4 py-2 rounded-lg text-xs font-bold font-mono transition-all duration-200 flex items-center gap-2 ${
                activeRole === 'host'
                  ? 'bg-gradient-to-r from-indigo-500/20 to-purple-500/20 text-indigo-200 border border-indigo-400/40 shadow-md'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Radio className="w-4 h-4" />
              <span>Host Rig (Game Host)</span>
            </button>
          </div>
        </div>

        {/* Connection Bar */}
        <div className="mt-6 pt-4 border-t border-cyan-500/15 flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center space-x-2">
              <span className="text-xs font-mono text-slate-400">Desk ID:</span>
              <input
                type="text"
                value={roomIdInput}
                onChange={(e) => setRoomIdInput(e.target.value)}
                placeholder="6-digit ID"
                className="w-28 px-2.5 py-1.5 rounded-lg bg-[#070912] border border-cyan-500/30 font-mono text-sm text-cyan-300 font-bold focus:outline-none focus:border-cyan-400"
              />
            </div>
            <div className="flex items-center space-x-2">
              <span className="text-xs font-mono text-slate-400">PIN (Optional):</span>
              <input
                type="text"
                value={pinInput}
                onChange={(e) => setPinInput(e.target.value)}
                placeholder="PIN"
                className="w-20 px-2 py-1.5 rounded-lg bg-[#070912] border border-cyan-500/30 font-mono text-xs text-slate-200 focus:outline-none focus:border-cyan-400"
              />
            </div>

            {connectionState !== 'connected' ? (
              <button
                onClick={handleStartSession}
                className="px-4 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-xs transition-colors flex items-center gap-1.5 shadow-md shadow-cyan-500/20"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                <span>{activeRole === 'client' ? 'Connect Controller' : 'Start Hosting'}</span>
              </button>
            ) : (
              <button
                onClick={handleDisconnect}
                className="px-4 py-1.5 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/40 text-rose-300 font-bold text-xs transition-colors flex items-center gap-1.5"
              >
                <Square className="w-3.5 h-3.5 fill-current" />
                <span>Disconnect</span>
              </button>
            )}
          </div>

          {/* Connection Status Badge */}
          <div className="flex items-center space-x-3 text-xs font-mono">
            <span className="flex items-center gap-1.5">
              <span
                className={`w-2.5 h-2.5 rounded-full ${
                  connectionState === 'connected'
                    ? 'bg-emerald-400 animate-pulse'
                    : connectionState === 'connecting'
                    ? 'bg-amber-400 animate-ping'
                    : 'bg-slate-600'
                }`}
              />
              <span className="text-slate-300 uppercase">{connectionState}</span>
            </span>

            {stats && (
              <span className="text-cyan-300 bg-cyan-950/60 border border-cyan-500/25 px-2.5 py-0.5 rounded-md">
                RTT: {Math.round(stats.rttMs || 0)} ms • {stats.fps} FPS
              </span>
            )}
          </div>
        </div>
      </div>

      {/* 2. Main Grid: Controller Visualizer & Game Stream */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column (5 Cols): Live Gamepad HUD & Input Controls */}
        <div className="lg:col-span-5 space-y-6">
          {/* Controller Visualizer Card */}
          <div className="bg-[#080a14]/90 border border-cyan-500/20 rounded-2xl p-5 shadow-xl backdrop-blur-md space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <Gamepad2 className="w-5 h-5 text-cyan-400" />
                <h3 className="font-bold text-sm text-slate-100">Controller State Visualizer</h3>
              </div>
              <button
                onClick={() => setPlayerIndex(playerIndex === 1 ? 0 : 1)}
                className="text-[10px] font-mono px-2.5 py-0.5 rounded-full bg-cyan-950/80 border border-cyan-500/30 text-cyan-300 hover:bg-cyan-900/80 transition-colors cursor-pointer"
                title="Click to toggle Player 1 / Player 2 slot"
              >
                Player {playerIndex + 1} (Click to switch)
              </button>
            </div>

            {/* Hardware Status Banner */}
            <div className="bg-[#05070e] border border-slate-800 rounded-xl p-3 flex items-center justify-between">
              <div>
                <div className="text-[11px] font-mono text-slate-400">Detected Input Device:</div>
                <div className="text-xs font-bold text-cyan-300 truncate max-w-[220px]">
                  {detectedGamepadName || (virtualKeyboardEnabled ? 'Virtual Keyboard Controller' : 'No Gamepad Detected')}
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={handleTestRumble}
                  className="px-2.5 py-1 rounded bg-indigo-500/20 hover:bg-indigo-500/30 border border-indigo-400/30 text-indigo-300 text-[11px] font-mono transition-colors"
                  title="Test Controller Vibration"
                >
                  Rumble
                </button>
              </div>
            </div>

            {/* SVG Interactive Gamepad Diagram */}
            <div className="relative w-full aspect-[16/10] bg-[#04050a] border border-cyan-500/20 rounded-xl p-4 flex flex-col justify-between overflow-hidden shadow-inner">
              {/* Top Shoulder & Trigger Bars */}
              <div className="flex items-center justify-between px-4">
                {/* Left Shoulder & Trigger */}
                <div className="space-y-1">
                  <div className="flex items-center gap-1.5 text-[10px] font-mono text-slate-400">
                    <span>LT:</span>
                    <div className="w-16 h-2 bg-slate-800 rounded-full overflow-hidden border border-slate-700">
                      <div
                        className="h-full bg-cyan-400 transition-all duration-75"
                        style={{ width: `${Math.round(triggerValues.lt * 100)}%` }}
                      />
                    </div>
                  </div>
                  <span
                    className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold font-mono border ${
                      activeButtons[4]
                        ? 'bg-cyan-500/30 border-cyan-400 text-cyan-200'
                        : 'bg-slate-900 border-slate-800 text-slate-500'
                    }`}
                  >
                    LB
                  </span>
                </div>

                {/* Right Shoulder & Trigger */}
                <div className="space-y-1 text-right">
                  <div className="flex items-center justify-end gap-1.5 text-[10px] font-mono text-slate-400">
                    <div className="w-16 h-2 bg-slate-800 rounded-full overflow-hidden border border-slate-700">
                      <div
                        className="h-full bg-cyan-400 transition-all duration-75 ml-auto"
                        style={{ width: `${Math.round(triggerValues.rt * 100)}%` }}
                      />
                    </div>
                    <span>RT:</span>
                  </div>
                  <span
                    className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold font-mono border ${
                      activeButtons[5]
                        ? 'bg-cyan-500/30 border-cyan-400 text-cyan-200'
                        : 'bg-slate-900 border-slate-800 text-slate-500'
                    }`}
                  >
                    RB
                  </span>
                </div>
              </div>

              {/* Middle Section: D-Pad, Center Buttons, Face Buttons */}
              <div className="flex items-center justify-between px-6 my-auto">
                {/* D-Pad (Up, Down, Left, Right) */}
                <div className="relative w-20 h-20 flex items-center justify-center">
                  <div className="absolute inset-0 grid grid-cols-3 grid-rows-3 gap-0.5">
                    {/* Up */}
                    <div
                      className={`col-start-2 row-start-1 rounded border flex items-center justify-center text-[9px] font-bold ${
                        activeButtons[12]
                          ? 'bg-cyan-500 border-cyan-300 text-black shadow-[0_0_10px_rgba(6,182,212,0.8)]'
                          : 'bg-slate-900 border-slate-800 text-slate-400'
                      }`}
                    >
                      ▲
                    </div>
                    {/* Left */}
                    <div
                      className={`col-start-1 row-start-2 rounded border flex items-center justify-center text-[9px] font-bold ${
                        activeButtons[14]
                          ? 'bg-cyan-500 border-cyan-300 text-black shadow-[0_0_10px_rgba(6,182,212,0.8)]'
                          : 'bg-slate-900 border-slate-800 text-slate-400'
                      }`}
                    >
                      ◀
                    </div>
                    {/* Center */}
                    <div className="col-start-2 row-start-2 bg-slate-950 border border-slate-900 rounded" />
                    {/* Right */}
                    <div
                      className={`col-start-3 row-start-2 rounded border flex items-center justify-center text-[9px] font-bold ${
                        activeButtons[15]
                          ? 'bg-cyan-500 border-cyan-300 text-black shadow-[0_0_10px_rgba(6,182,212,0.8)]'
                          : 'bg-slate-900 border-slate-800 text-slate-400'
                      }`}
                    >
                      ▶
                    </div>
                    {/* Down */}
                    <div
                      className={`col-start-2 row-start-3 rounded border flex items-center justify-center text-[9px] font-bold ${
                        activeButtons[13]
                          ? 'bg-cyan-500 border-cyan-300 text-black shadow-[0_0_10px_rgba(6,182,212,0.8)]'
                          : 'bg-slate-900 border-slate-800 text-slate-400'
                      }`}
                    >
                      ▼
                    </div>
                  </div>
                </div>

                {/* Center Buttons (Select / Start) */}
                <div className="flex items-center space-x-3">
                  <span
                    className={`px-2 py-0.5 rounded text-[9px] font-mono border ${
                      activeButtons[8]
                        ? 'bg-cyan-500/40 border-cyan-300 text-cyan-200'
                        : 'bg-slate-900 border-slate-800 text-slate-500'
                    }`}
                  >
                    SELECT
                  </span>
                  <span
                    className={`px-2 py-0.5 rounded text-[9px] font-mono border ${
                      activeButtons[9]
                        ? 'bg-cyan-500/40 border-cyan-300 text-cyan-200'
                        : 'bg-slate-900 border-slate-800 text-slate-500'
                    }`}
                  >
                    START
                  </span>
                </div>

                {/* Face Buttons (X, Y, A, B) */}
                <div className="relative w-20 h-20 flex items-center justify-center">
                  <div className="absolute inset-0 grid grid-cols-3 grid-rows-3 gap-0.5">
                    {/* Y (Yellow) */}
                    <div
                      className={`col-start-2 row-start-1 rounded-full border flex items-center justify-center text-[10px] font-bold font-mono ${
                        activeButtons[3]
                          ? 'bg-amber-400 border-amber-300 text-black shadow-[0_0_10px_rgba(251,191,36,0.8)]'
                          : 'bg-slate-900 border-slate-800 text-slate-400'
                      }`}
                    >
                      Y
                    </div>
                    {/* X (Blue) */}
                    <div
                      className={`col-start-1 row-start-2 rounded-full border flex items-center justify-center text-[10px] font-bold font-mono ${
                        activeButtons[2]
                          ? 'bg-blue-500 border-blue-300 text-white shadow-[0_0_10px_rgba(59,130,246,0.8)]'
                          : 'bg-slate-900 border-slate-800 text-slate-400'
                      }`}
                    >
                      X
                    </div>
                    {/* B (Red) */}
                    <div
                      className={`col-start-3 row-start-2 rounded-full border flex items-center justify-center text-[10px] font-bold font-mono ${
                        activeButtons[1]
                          ? 'bg-rose-500 border-rose-300 text-white shadow-[0_0_10px_rgba(244,63,94,0.8)]'
                          : 'bg-slate-900 border-slate-800 text-slate-400'
                      }`}
                    >
                      B
                    </div>
                    {/* A (Green) */}
                    <div
                      className={`col-start-2 row-start-3 rounded-full border flex items-center justify-center text-[10px] font-bold font-mono ${
                        activeButtons[0]
                          ? 'bg-emerald-400 border-emerald-300 text-black shadow-[0_0_10px_rgba(52,211,153,0.8)]'
                          : 'bg-slate-900 border-slate-800 text-slate-400'
                      }`}
                    >
                      A
                    </div>
                  </div>
                </div>
              </div>

              {/* Bottom Analog Thumbstick Radars */}
              <div className="flex items-center justify-around pt-2 border-t border-slate-800/80">
                {/* Left Stick */}
                <div className="flex flex-col items-center space-y-1">
                  <div className="relative w-12 h-12 rounded-full border border-slate-700 bg-slate-950 flex items-center justify-center">
                    {/* Crosshair */}
                    <div className="absolute inset-x-0 top-1/2 h-px bg-slate-800" />
                    <div className="absolute inset-y-0 left-1/2 w-px bg-slate-800" />
                    {/* Stick dot */}
                    <div
                      className={`w-3.5 h-3.5 rounded-full transition-transform duration-75 shadow-md ${
                        activeButtons[10] ? 'bg-cyan-300 ring-2 ring-cyan-400' : 'bg-cyan-500'
                      }`}
                      style={{
                        transform: `translate(${axesValues[0] * 16}px, ${axesValues[1] * 16}px)`,
                      }}
                    />
                  </div>
                  <span className="text-[9px] font-mono text-slate-400">Left Stick (L3)</span>
                </div>

                {/* Right Stick */}
                <div className="flex flex-col items-center space-y-1">
                  <div className="relative w-12 h-12 rounded-full border border-slate-700 bg-slate-950 flex items-center justify-center">
                    <div className="absolute inset-x-0 top-1/2 h-px bg-slate-800" />
                    <div className="absolute inset-y-0 left-1/2 w-px bg-slate-800" />
                    <div
                      className={`w-3.5 h-3.5 rounded-full transition-transform duration-75 shadow-md ${
                        activeButtons[11] ? 'bg-indigo-300 ring-2 ring-indigo-400' : 'bg-indigo-500'
                      }`}
                      style={{
                        transform: `translate(${axesValues[2] * 16}px, ${axesValues[3] * 16}px)`,
                      }}
                    />
                  </div>
                  <span className="text-[9px] font-mono text-slate-400">Right Stick (R3)</span>
                </div>
              </div>
            </div>

            {/* Packets & Tuning Bar */}
            <div className="flex items-center justify-between text-xs font-mono text-slate-400 pt-1">
              <span>Packets Transmitted: {packetsSentCount}</span>
              <div className="flex items-center space-x-2">
                <span>Deadzone:</span>
                <input
                  type="range"
                  min="0.05"
                  max="0.30"
                  step="0.01"
                  value={deadzone}
                  onChange={(e) => setDeadzone(parseFloat(e.target.value))}
                  className="w-20 accent-cyan-400"
                />
                <span className="text-cyan-300">{(deadzone * 100).toFixed(0)}%</span>
              </div>
            </div>
          </div>

          {/* Virtual Keyboard Mapping & Legend */}
          <div className="bg-[#080a14]/90 border border-cyan-500/20 rounded-2xl p-4 shadow-xl backdrop-blur-md space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <Keyboard className="w-4 h-4 text-cyan-400" />
                <h4 className="text-xs font-bold text-slate-200">Laptop Keyboard Co-op Controller</h4>
              </div>
              <button
                onClick={() => setVirtualKeyboardEnabled(!virtualKeyboardEnabled)}
                className={`text-[10px] font-mono px-2.5 py-1 rounded-md border font-semibold transition-colors ${
                  virtualKeyboardEnabled
                    ? 'bg-emerald-950/60 border-emerald-500/40 text-emerald-300'
                    : 'bg-slate-900 border-slate-800 text-slate-400'
                }`}
              >
                {virtualKeyboardEnabled ? 'Active' : 'Disabled'}
              </button>
            </div>

            <p className="text-[11px] text-slate-400 leading-normal">
              No physical controller plugged in? Type directly on your laptop keyboard to drive Player 2.
            </p>

            {/* Quick Legend Table */}
            <div className="grid grid-cols-2 gap-2 text-[11px] font-mono">
              <div className="bg-[#05070e] p-2 rounded-lg border border-slate-800/80 space-y-1">
                <div className="text-slate-400 font-semibold">Movement (D-Pad):</div>
                <div className="text-cyan-300">WASD or Arrow Keys</div>
                <div className="text-slate-400 font-semibold pt-1">Action A / B:</div>
                <div className="text-cyan-300">Space (A), K (B)</div>
              </div>
              <div className="bg-[#05070e] p-2 rounded-lg border border-slate-800/80 space-y-1">
                <div className="text-slate-400 font-semibold">Action X / Y:</div>
                <div className="text-cyan-300">J (X), I (Y)</div>
                <div className="text-slate-400 font-semibold pt-1">Bumpers & Triggers:</div>
                <div className="text-cyan-300">U / O (LB/RB), Q / E (LT/RT)</div>
              </div>
            </div>
          </div>
        </div>

        {/* Right Column (7 Cols): Real-time Stream & Co-op Host Options */}
        <div className="lg:col-span-7 space-y-6">
          {/* Real-time Video Stream Window */}
          <div
            ref={containerRef}
            onMouseMove={handleMouseMove}
            className="relative w-full aspect-video bg-[#030408] rounded-2xl overflow-hidden border border-cyan-500/30 shadow-2xl flex flex-col items-center justify-center group"
          >
            {remoteStream ? (
              <video
                ref={videoRef}
                autoPlay
                playsInline
                className="w-full h-full object-contain pointer-events-none"
              />
            ) : (
              <div className="text-center space-y-3 p-6 text-slate-500">
                <Tv className="w-12 h-12 stroke-[1.2] text-slate-600 mx-auto animate-pulse" />
                <div className="text-xs font-mono">
                  <span className="text-slate-300 font-bold">Waiting for Game Stream</span>
                  <p className="text-[11px] text-slate-500 mt-1 max-w-sm mx-auto">
                    {activeRole === 'client'
                      ? 'Connect to the Host Desk ID above to view the host game stream.'
                      : 'Host is active. Start screen capture in the Host tab or run your game on this PC.'}
                  </p>
                </div>
              </div>
            )}

            {/* In-Game Top Toolbar */}
            <div className="absolute top-3 left-3 right-3 flex items-center justify-between pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-200">
              <span className="px-2.5 py-1 rounded-lg bg-[#070914]/85 border border-cyan-500/30 text-cyan-300 font-mono text-[11px] font-bold backdrop-blur-md shadow-lg flex items-center gap-1.5 pointer-events-auto">
                <Zap className="w-3.5 h-3.5 text-emerald-400" />
                <span>60 FPS Low-Latency</span>
              </span>

              <div className="flex items-center gap-1.5 pointer-events-auto">
                {/* Pointer lock button */}
                <button
                  onClick={togglePointerLock}
                  className={`p-1.5 rounded-lg border text-xs font-mono flex items-center gap-1 backdrop-blur-md transition-colors ${
                    pointerLockActive
                      ? 'bg-cyan-500 text-black border-cyan-300 font-bold'
                      : 'bg-[#070914]/80 text-slate-300 hover:text-white border-slate-800'
                  }`}
                  title="Capture Mouse for 3D/FPS Games (Press ESC to exit)"
                >
                  <Crosshair className="w-3.5 h-3.5" />
                  <span className="text-[10px]">{pointerLockActive ? 'Locked' : 'FPS Lock'}</span>
                </button>

                {/* Mute toggle */}
                <button
                  onClick={() => setIsAudioMuted(!isAudioMuted)}
                  className="p-1.5 rounded-lg bg-[#070914]/80 hover:bg-[#0f1426] border border-slate-800 text-slate-300 hover:text-white backdrop-blur-md transition-colors"
                  title={isAudioMuted ? 'Unmute Audio' : 'Mute Game Audio'}
                >
                  {isAudioMuted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>
          </div>

          {/* Host Co-op Rig Configuration Card */}
          {activeRole === 'host' && (
            <div className="bg-[#080a14]/90 border border-indigo-500/25 rounded-2xl p-5 shadow-xl backdrop-blur-md space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <Sliders className="w-5 h-5 text-indigo-400" />
                  <h3 className="font-bold text-sm text-slate-100">Host Player 2 Native Input Router</h3>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={`text-[10px] font-mono px-2 py-0.5 rounded-full border ${
                      vigemActive
                        ? 'bg-emerald-950/80 border-emerald-500/40 text-emerald-300'
                        : 'bg-indigo-950/80 border-indigo-500/30 text-indigo-300'
                    }`}
                  >
                    {vigemActive ? 'Virtual Xbox 360 Controller' : 'DirectInput / Numpad Router'}
                  </span>
                </div>
              </div>

              {/* ViGEm Virtual Gamepad Card (Windows Native) */}
              <div className="bg-[#05070e] border border-slate-800 rounded-xl p-3.5 space-y-2.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-2">
                    <Cpu className="w-4 h-4 text-cyan-400" />
                    <span className="text-xs font-bold text-slate-200">
                      ViGEm Virtual Xbox 360 Controller (Windows Host)
                    </span>
                  </div>
                  <button
                    onClick={handleToggleVigem}
                    disabled={!vigemStatus?.driverInstalled}
                    className={`px-3 py-1 rounded-lg text-xs font-mono font-semibold transition-all border ${
                      !vigemStatus?.driverInstalled
                        ? 'bg-slate-900 border-slate-800 text-slate-500 cursor-not-allowed'
                        : vigemActive
                        ? 'bg-emerald-500/20 hover:bg-emerald-500/30 border-emerald-400/40 text-emerald-300'
                        : 'bg-cyan-500/20 hover:bg-cyan-500/30 border-cyan-400/40 text-cyan-300'
                    }`}
                  >
                    {vigemActive ? 'Disconnect Virtual Controller' : 'Plug In Virtual Controller'}
                  </button>
                </div>

                <p className="text-[11px] text-slate-400 leading-normal">
                  {vigemStatus?.driverInstalled
                    ? 'ViGEmBus driver is active on this host! Plugging in spawns an authentic Xbox 360 USB controller on Player 2 slot, supporting analog sticks, analog triggers, and full Steam/DirectX recognition.'
                    : 'ViGEmBus driver is not detected on this system. Operating in zero-driver DirectInput/Numpad mode. (Optional: install ViGEmBus to emulate physical controllers for games that require them).'}
                </p>
              </div>

              <div className="border-t border-slate-800/80 pt-3">
                <div className="text-xs font-bold text-slate-300 mb-1.5">
                  Fallback Driverless Keyboard Co-op Profiles:
                </div>
                <p className="text-xs text-slate-400 leading-relaxed mb-3">
                  When virtual controller emulation is disabled or ViGEm is not installed, incoming remote gamepad inputs are mapped directly to native Windows keyboard scan codes for split-screen co-op.
                </p>

                {/* Preset Selector */}
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => setSelectedKeymapPreset('numpad')}
                    className={`p-3 rounded-xl border text-left transition-all ${
                      selectedKeymapPreset === 'numpad'
                        ? 'bg-indigo-500/20 border-indigo-400 text-indigo-200 shadow-md'
                        : 'bg-slate-900/60 border-slate-800 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <div className="font-bold text-xs">Numpad Co-op Profile (Default)</div>
                    <div className="text-[10px] text-slate-400 mt-1">
                      Movement: Numpad 8, 2, 4, 6 • Actions: Numpad 1, 3, 7, 9
                    </div>
                  </button>

                  <button
                    onClick={() => setSelectedKeymapPreset('arcade')}
                    className={`p-3 rounded-xl border text-left transition-all ${
                      selectedKeymapPreset === 'arcade'
                        ? 'bg-indigo-500/20 border-indigo-400 text-indigo-200 shadow-md'
                        : 'bg-slate-900/60 border-slate-800 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <div className="font-bold text-xs">Arcade Split Profile (IJKL)</div>
                    <div className="text-[10px] text-slate-400 mt-1">
                      Movement: I, K, J, L • Actions: U, O, Y, H
                    </div>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Outside WAN Connection & Performance Guard */}
          <div className="bg-[#080a14]/90 border border-cyan-500/20 rounded-2xl p-5 shadow-xl backdrop-blur-md space-y-3">
            <div className="flex items-center space-x-2">
              <ShieldCheck className="w-5 h-5 text-emerald-400" />
              <h4 className="font-bold text-xs text-slate-100">Outside Connection & Anti-Freeze Architecture</h4>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs font-mono">
              <div className="bg-[#05070e] p-3 rounded-xl border border-slate-800 space-y-1">
                <span className="text-slate-400 text-[10px]">Transmission Mode</span>
                <div className="text-emerald-300 font-bold">Unordered UDP</div>
                <p className="text-[10px] text-slate-500 leading-tight">
                  Zero head-of-line blocking. Dropped packets are bypassed immediately.
                </p>
              </div>

              <div className="bg-[#05070e] p-3 rounded-xl border border-slate-800 space-y-1">
                <span className="text-slate-400 text-[10px]">Playout Buffer</span>
                <div className="text-cyan-300 font-bold">0ms Delay Hint</div>
                <p className="text-[10px] text-slate-500 leading-tight">
                  Receiver jitter buffer bypassed to eliminate render lag.
                </p>
              </div>

              <div className="bg-[#05070e] p-3 rounded-xl border border-slate-800 space-y-1">
                <span className="text-slate-400 text-[10px]">WAN Traversal</span>
                <div className="text-indigo-300 font-bold">Multi-STUN + Tunnel</div>
                <p className="text-[10px] text-slate-500 leading-tight">
                  Direct P2P NAT hole punching with Cloudflare WAN tunnel fallback.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
