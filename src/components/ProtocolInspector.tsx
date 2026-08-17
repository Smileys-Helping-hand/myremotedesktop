import React, { useState, useEffect } from 'react';
import {
  RemoteControlPacket,
  RemoteMouseMovePayload,
  RemoteMouseButtonPayload,
  RemoteKeyboardPayload,
} from '../types/remoteControl';
import {
  Cpu,
  Zap,
  Send,
  Activity,
  CheckCircle2,
  Layers,
  ArrowRight,
  Database,
  Gauge,
  Sparkles,
} from 'lucide-react';

export const ProtocolInspector: React.FC = () => {
  const [packetType, setPacketType] = useState<'MOUSE_MOVE' | 'MOUSE_DOWN' | 'KEY_DOWN' | 'MOUSE_WHEEL'>('MOUSE_MOVE');
  const [normX, setNormX] = useState<number>(0.5428);
  const [normY, setNormY] = useState<number>(0.3812);
  const [selectedKey, setSelectedKey] = useState<string>('Enter');
  const [selectedCode, setSelectedCode] = useState<string>('Enter');
  const [selectedButton, setSelectedButton] = useState<'left' | 'middle' | 'right'>('left');

  // Streaming simulated packet feed
  const [packetLog, setPacketLog] = useState<Array<{ id: number; packet: RemoteControlPacket; channel: 'Unreliable (UDP-like)' | 'Reliable (TCP-like)'; byteSize: number }>>([]);
  const [isLiveStreaming, setIsLiveStreaming] = useState<boolean>(false);
  const [packetsPerSec, setPacketsPerSec] = useState<number>(60);

  // Generate current packet object
  const currentPacket: RemoteControlPacket = React.useMemo(() => {
    const timestamp = Date.now();
    switch (packetType) {
      case 'MOUSE_MOVE':
        return {
          type: 'MOUSE_MOVE',
          normX,
          normY,
          timestamp,
        } as RemoteMouseMovePayload;
      case 'MOUSE_DOWN':
        return {
          type: 'MOUSE_DOWN',
          button: selectedButton,
          normX,
          normY,
          clicks: 1,
          timestamp,
        } as RemoteMouseButtonPayload;
      case 'KEY_DOWN':
        return {
          type: 'KEY_DOWN',
          key: selectedKey,
          code: selectedCode,
          altKey: false,
          ctrlKey: false,
          shiftKey: false,
          metaKey: false,
          timestamp,
        } as RemoteKeyboardPayload;
      case 'MOUSE_WHEEL':
        return {
          type: 'MOUSE_WHEEL',
          deltaX: 0,
          deltaY: -120,
          timestamp,
        };
    }
  }, [packetType, normX, normY, selectedButton, selectedKey, selectedCode]);

  const jsonString = JSON.stringify(currentPacket, null, 2);
  const jsonByteSize = new TextEncoder().encode(jsonString).length;

  // Binary Protocol Comparison (Packed ArrayBuffer: Type[1B] + Timestamp[8B] + uX[2B] + uY[2B] = 13 Bytes)
  const binaryByteSize = 13;

  const handleSendSinglePacket = () => {
    const isUnreliable = currentPacket.type === 'MOUSE_MOVE';
    setPacketLog((prev) => [
      {
        id: Date.now() + Math.random(),
        packet: currentPacket,
        channel: isUnreliable ? 'Unreliable (UDP-like)' : 'Reliable (TCP-like)',
        byteSize: jsonByteSize,
      },
      ...prev.slice(0, 15),
    ]);
  };

  // Simulated continuous 60fps stream
  useEffect(() => {
    if (!isLiveStreaming) return;
    let angle = 0;
    const interval = setInterval(() => {
      angle += 0.08;
      const x = parseFloat((0.5 + 0.3 * Math.cos(angle)).toFixed(4));
      const y = parseFloat((0.5 + 0.25 * Math.sin(angle)).toFixed(4));

      const packet: RemoteMouseMovePayload = {
        type: 'MOUSE_MOVE',
        normX: x,
        normY: y,
        timestamp: Date.now(),
      };

      setPacketLog((prev) => [
        {
          id: Date.now() + Math.random(),
          packet,
          channel: 'Unreliable (UDP-like)',
          byteSize: 68,
        },
        ...prev.slice(0, 15),
      ]);
    }, 1000 / packetsPerSec);

    return () => clearInterval(interval);
  }, [isLiveStreaming, packetsPerSec]);

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-2">
      {/* Header Banner */}
      <div className="bg-[#0c0e18]/90 border border-cyan-500/20 rounded-2xl p-6 shadow-[0_8px_32px_rgba(0,0,0,0.5)] backdrop-blur-xl relative overflow-hidden">
        <div className="absolute -right-16 -top-16 w-64 h-64 bg-cyan-500/10 rounded-full blur-3xl pointer-events-none" />
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 relative z-10">
          <div className="space-y-1">
            <div className="flex items-center space-x-2">
              <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-cyan-500/10 text-cyan-300 border border-cyan-500/30 shadow-[0_0_10px_rgba(0,210,255,0.15)]">
                DataChannel Architecture
              </span>
              <span className="text-xs text-slate-400 font-mono">
                Dual-Channel WebRTC Architecture
              </span>
            </div>
            <h2 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
              <span className="bg-gradient-to-r from-white via-cyan-100 to-cyan-300 bg-clip-text text-transparent">
                WebRTC RTCDataChannel Protocol & Serialization Inspector
              </span>
            </h2>
            <p className="text-sm text-slate-300 max-w-3xl leading-relaxed">
              Why split into two channels? <strong>Channel A (Unreliable / Unordered)</strong> streams continuous mouse coordinates at 60 FPS without head-of-line blocking. <strong>Channel B (Reliable / Ordered)</strong> transmits discrete user actions (Clicks, Keystrokes, Permission handshakes) with guaranteed delivery.
            </p>
          </div>

          <div className="flex items-center gap-3 self-start lg:self-center">
            <button
              onClick={() => setIsLiveStreaming(!isLiveStreaming)}
              className={`flex items-center space-x-2 px-4 py-2.5 rounded-xl font-medium text-xs sm:text-sm shadow-lg transition-all ${
                isLiveStreaming
                  ? 'bg-gradient-to-r from-rose-600 to-red-600 hover:from-rose-500 hover:to-red-500 text-white shadow-rose-600/30'
                  : 'bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white shadow-cyan-500/25'
              }`}
            >
              <Zap className="w-4 h-4" />
              <span>{isLiveStreaming ? 'Stop 60 FPS Stream' : 'Start 60 FPS Stream'}</span>
            </button>
          </div>
        </div>
      </div>

      {/* Dual Channel Architecture Visualizer */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Channel A: Unreliable */}
        <div className="bg-[#0b0d17]/90 border border-cyan-500/30 rounded-2xl p-5 space-y-3 relative overflow-hidden backdrop-blur-xl shadow-xl">
          <div className="absolute top-0 right-0 w-32 h-32 bg-cyan-500/10 rounded-full blur-3xl pointer-events-none" />
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold font-mono px-2.5 py-1 rounded bg-cyan-950/80 text-cyan-300 border border-cyan-500/40 shadow-[0_0_10px_rgba(0,210,255,0.2)]">
              CHANNEL A: UNRELIABLE (UDP Mode)
            </span>
            <span className="text-xs font-mono text-emerald-400 font-semibold">0ms Buffering Delay</span>
          </div>
          <h3 className="font-bold text-white text-base">High-Frequency Mouse Coordinates</h3>
          <p className="text-xs text-slate-300 leading-relaxed">
            Configured with <code className="text-cyan-300 font-mono bg-[#141829] px-1.5 py-0.5 rounded border border-cyan-500/20">{`{ ordered: false, maxRetransmits: 0 }`}</code>. If a coordinate packet is dropped due to packet loss, it is never retransmitted because a newer coordinate is already arriving in 16ms.
          </p>
          <div className="text-[11px] font-mono text-slate-400 bg-[#07080f] p-2.5 rounded-lg border border-cyan-500/15">
            Payloads: <span className="text-cyan-300 font-semibold">MOUSE_MOVE</span> (~60 packets/sec)
          </div>
        </div>

        {/* Channel B: Reliable */}
        <div className="bg-[#0b0d17]/90 border border-indigo-500/30 rounded-2xl p-5 space-y-3 relative overflow-hidden backdrop-blur-xl shadow-xl">
          <div className="absolute top-0 right-0 w-32 h-32 bg-indigo-500/10 rounded-full blur-3xl pointer-events-none" />
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold font-mono px-2.5 py-1 rounded bg-indigo-950/80 text-indigo-300 border border-indigo-500/40 shadow-[0_0_10px_rgba(99,102,241,0.2)]">
              CHANNEL B: RELIABLE (TCP Mode)
            </span>
            <span className="text-xs font-mono text-sky-400 font-semibold">Guaranteed Delivery</span>
          </div>
          <h3 className="font-bold text-white text-base">Critical Commands & Keystrokes</h3>
          <p className="text-xs text-slate-300 leading-relaxed">
            Configured with <code className="text-indigo-300 font-mono bg-[#141829] px-1.5 py-0.5 rounded border border-indigo-500/20">{`{ ordered: true }`}</code>. Every mouse click, modifier key, keyboard shortcut (e.g. Ctrl+C), and permission event must arrive intact in strict temporal sequence.
          </p>
          <div className="text-[11px] font-mono text-slate-400 bg-[#07080f] p-2.5 rounded-lg border border-indigo-500/15">
            Payloads: <span className="text-indigo-300 font-semibold">MOUSE_DOWN, MOUSE_UP, KEY_DOWN, KEY_UP</span>
          </div>
        </div>
      </div>

      {/* Packet Builder & Live Protocol Log */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Packet Builder (5 Cols) */}
        <div className="lg:col-span-5 bg-[#0b0d17]/90 border border-cyan-500/20 rounded-2xl p-5 space-y-4 shadow-xl backdrop-blur-xl">
          <div className="flex items-center justify-between">
            <h3 className="font-bold text-white text-base flex items-center gap-2">
              <Cpu className="w-4 h-4 text-cyan-400" />
              Packet Constructor
            </h3>
            <span className="text-xs font-mono text-cyan-400/80 bg-cyan-950/40 px-2 py-0.5 rounded border border-cyan-500/20">Testbench</span>
          </div>

          {/* Packet Type Picker */}
          <div>
            <label className="text-xs text-slate-400 font-medium block mb-2">Select Packet Type</label>
            <div className="grid grid-cols-2 gap-2">
              {(['MOUSE_MOVE', 'MOUSE_DOWN', 'KEY_DOWN', 'MOUSE_WHEEL'] as const).map((type) => (
                <button
                  key={type}
                  onClick={() => setPacketType(type)}
                  className={`px-3 py-2 rounded-xl text-xs font-mono font-semibold transition-all border ${
                    packetType === type
                      ? 'bg-cyan-500/20 border-cyan-400 text-cyan-100 shadow-[0_0_12px_rgba(0,210,255,0.2)]'
                      : 'bg-[#07080f]/80 border-slate-800/90 text-slate-400 hover:text-slate-200 hover:border-cyan-500/40'
                  }`}
                >
                  {type}
                </button>
              ))}
            </div>
          </div>

          {/* Conditional Packet Controls */}
          {packetType === 'MOUSE_MOVE' && (
            <div className="space-y-3 p-3 bg-[#07080f] rounded-xl border border-cyan-500/15">
              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-slate-400">Normalized X: {normX}</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.001}
                  value={normX}
                  onChange={(e) => setNormX(parseFloat(e.target.value))}
                  className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-cyan-400"
                />
              </div>
              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-slate-400">Normalized Y: {normY}</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.001}
                  value={normY}
                  onChange={(e) => setNormY(parseFloat(e.target.value))}
                  className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-cyan-400"
                />
              </div>
            </div>
          )}

          {packetType === 'MOUSE_DOWN' && (
            <div className="p-3 bg-[#07080f] rounded-xl border border-cyan-500/15 space-y-2">
              <label className="text-xs text-slate-400 font-medium block">Mouse Button</label>
              <div className="grid grid-cols-3 gap-2">
                {(['left', 'middle', 'right'] as const).map((btn) => (
                  <button
                    key={btn}
                    onClick={() => setSelectedButton(btn)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-mono capitalize transition-all border ${
                      selectedButton === btn
                        ? 'bg-cyan-500/20 border-cyan-400 text-cyan-200 shadow-[0_0_10px_rgba(0,210,255,0.2)]'
                        : 'bg-[#0d101a] border-slate-800 text-slate-400 hover:text-white hover:border-slate-700'
                    }`}
                  >
                    {btn}
                  </button>
                ))}
              </div>
            </div>
          )}

          {packetType === 'KEY_DOWN' && (
            <div className="p-3 bg-[#07080f] rounded-xl border border-cyan-500/15 space-y-2">
              <label className="text-xs text-slate-400 font-medium block">Key Shortcut Preset</label>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { key: 'Enter', code: 'Enter' },
                  { key: 'Tab', code: 'Tab' },
                  { key: 'Escape', code: 'Escape' },
                  { key: 'c', code: 'KeyC' },
                  { key: 'v', code: 'KeyV' },
                  { key: 'Backspace', code: 'Backspace' },
                ].map((k) => (
                  <button
                    key={k.code}
                    onClick={() => {
                      setSelectedKey(k.key);
                      setSelectedCode(k.code);
                    }}
                    className={`px-2 py-1.5 rounded-lg text-xs font-mono transition-all border ${
                      selectedCode === k.code
                        ? 'bg-cyan-500/20 border-cyan-400 text-cyan-200 shadow-[0_0_10px_rgba(0,210,255,0.2)]'
                        : 'bg-[#0d101a] border-slate-800 text-slate-400 hover:text-white hover:border-slate-700'
                    }`}
                  >
                    {k.code}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Send Packet Button */}
          <button
            onClick={handleSendSinglePacket}
            className="w-full flex items-center justify-center space-x-2 py-2.5 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-semibold text-xs transition-all shadow-md shadow-cyan-500/25"
          >
            <Send className="w-4 h-4" />
            <span>Emit Test Packet into WebRTC DataChannel</span>
          </button>

          {/* JSON & Binary Footprint Card */}
          <div className="p-3.5 bg-[#07080f] rounded-xl border border-cyan-500/15 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-mono text-slate-400">JSON Payload Size:</span>
              <span className="font-mono text-amber-400 font-bold">{jsonByteSize} Bytes</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="font-mono text-slate-400">Packed Binary Protocol:</span>
              <span className="font-mono text-emerald-400 font-bold">{binaryByteSize} Bytes (~80% savings)</span>
            </div>
            <pre className="p-2.5 bg-[#05060b] rounded-lg text-[11px] font-mono text-cyan-300 overflow-x-auto border border-cyan-500/15">
              {jsonString}
            </pre>
          </div>
        </div>

        {/* Live Packet Log Stream (7 Cols) */}
        <div className="lg:col-span-7 bg-[#0b0d17]/90 border border-cyan-500/20 rounded-2xl p-5 space-y-4 shadow-xl backdrop-blur-xl flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <Activity className="w-4 h-4 text-emerald-400" />
              <h3 className="font-bold text-white text-base">Live DataChannel Activity Stream</h3>
            </div>
            <div className="flex items-center space-x-2">
              <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(16,185,129,0.8)] animate-pulse" />
              <span className="text-xs font-mono text-emerald-400 bg-emerald-950/40 border border-emerald-500/30 px-2 py-0.5 rounded">RTCDataChannel OPEN</span>
            </div>
          </div>

          {/* Packet Table */}
          <div className="space-y-1.5 overflow-y-auto max-h-[460px] pr-1">
            {packetLog.length === 0 ? (
              <div className="text-center py-16 text-xs text-slate-500 font-mono">
                No packets sent yet. Click "Emit Test Packet" or "Start 60 FPS Stream" to inspect live serialization.
              </div>
            ) : (
              packetLog.map((log) => (
                <div
                  key={log.id}
                  className="p-2.5 rounded-xl bg-[#07080f] border border-cyan-500/15 flex items-center justify-between text-xs font-mono hover:border-cyan-500/40 transition-all"
                >
                  <div className="flex items-center space-x-2">
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                        log.packet.type === 'MOUSE_MOVE'
                          ? 'bg-cyan-950 text-cyan-300 border border-cyan-500/40'
                          : 'bg-indigo-950 text-indigo-300 border border-indigo-500/40'
                      }`}
                    >
                      {log.packet.type}
                    </span>
                    <span className="text-slate-300">
                      {log.packet.type === 'MOUSE_MOVE' && `(u: ${log.packet.normX}, v: ${log.packet.normY})`}
                      {log.packet.type === 'MOUSE_DOWN' && `Btn: ${log.packet.button} (clicks: 1)`}
                      {log.packet.type === 'KEY_DOWN' && `Code: ${log.packet.code}`}
                      {log.packet.type === 'MOUSE_WHEEL' && `ΔY: ${log.packet.deltaY}`}
                    </span>
                  </div>

                  <div className="flex items-center space-x-3 text-[11px] text-slate-500">
                    <span>{log.channel.split(' ')[0]}</span>
                    <span className="text-slate-400 font-semibold">{log.byteSize}B</span>
                    <span className="text-emerald-400">✓ Injected</span>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="flex items-center justify-between text-xs text-slate-500 pt-2 border-t border-cyan-500/15">
            <span>Latency budget: &lt; 16.6ms per frame</span>
            <button
              onClick={() => setPacketLog([])}
              className="text-xs text-cyan-400 hover:text-cyan-300 underline font-mono"
            >
              Clear Log
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
