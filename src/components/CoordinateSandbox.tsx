import React, { useState, useRef, useEffect, useMemo } from 'react';
import {
  calculateRemoteCoordinates,
  BoundingBox,
} from '../utils/coordinateMath';
import { HostScreenMetadata, CoordinateTranslationResult } from '../types/remoteControl';
import {
  MousePointer,
  Sparkles,
  Info,
  Monitor,
  Laptop,
} from 'lucide-react';

interface Preset {
  name: string;
  width: number;
  height: number;
  dpr: number;
  aspectRatio: string;
}

const PRESETS: Preset[] = [
  { name: '4K UHD Monitor', width: 3840, height: 2160, dpr: 1.5, aspectRatio: '16:9' },
  { name: 'QHD 1440p Monitor', width: 2560, height: 1440, dpr: 1.0, aspectRatio: '16:9' },
  { name: 'Full HD 1080p', width: 1920, height: 1080, dpr: 1.0, aspectRatio: '16:9' },
  { name: 'Ultrawide 21:9', width: 3440, height: 1440, dpr: 1.0, aspectRatio: '21:9' },
  { name: 'MacBook Pro 16" (Retina)', width: 3456, height: 2234, dpr: 2.0, aspectRatio: '16:10' },
  { name: 'iPad Pro (4:3)', width: 2732, height: 2048, dpr: 2.0, aspectRatio: '4:3' },
];

export const CoordinateSandbox: React.FC = () => {
  // Host Screen Metadata State
  const [selectedPreset, setSelectedPreset] = useState<Preset>(PRESETS[0]);
  const [hostWidth, setHostWidth] = useState<number>(3840);
  const [hostHeight, setHostHeight] = useState<number>(2160);
  const [hostDpr, setHostDpr] = useState<number>(1.5);

  // Client Render Container Dimensions State
  const [containerAspectMode, setContainerAspectMode] = useState<'4:3' | '16:9' | '21:9' | '16:10' | 'custom'>('4:3');
  const [containerWidth, setContainerWidth] = useState<number>(640);
  const [containerHeight, setContainerHeight] = useState<number>(440);

  // Interactive Cursor Position in Container
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number }>({ x: 320, y: 220 });
  const [isClicking, setIsClicking] = useState<boolean>(false);
  const [clickHistory, setClickHistory] = useState<Array<{ id: number; normX: number; normY: number; hostX: number; hostY: number }>>([]);

  const containerRef = useRef<HTMLDivElement>(null);

  // Update preset
  const handlePresetSelect = (preset: Preset) => {
    setSelectedPreset(preset);
    setHostWidth(preset.width);
    setHostHeight(preset.height);
    setHostDpr(preset.dpr);
  };

  // Adjust container dimensions based on aspect mode
  useEffect(() => {
    if (containerAspectMode === '16:9') {
      setContainerHeight(Math.round(containerWidth / (16 / 9)));
    } else if (containerAspectMode === '4:3') {
      setContainerHeight(Math.round(containerWidth / (4 / 3)));
    } else if (containerAspectMode === '21:9') {
      setContainerHeight(Math.round(containerWidth / (21 / 9)));
    } else if (containerAspectMode === '16:10') {
      setContainerHeight(Math.round(containerWidth / (16 / 10)));
    }
  }, [containerAspectMode, containerWidth]);

  // Host Metadata Object
  const hostMetadata: HostScreenMetadata = useMemo(
    () => ({
      width: hostWidth,
      height: hostHeight,
      devicePixelRatio: hostDpr,
    }),
    [hostWidth, hostHeight, hostDpr]
  );

  // Video Container Bounding Box for Math Engine
  const videoBoundingBox: BoundingBox = useMemo(
    () => ({
      left: 0,
      top: 0,
      width: containerWidth,
      height: containerHeight,
    }),
    [containerWidth, containerHeight]
  );

  // Calculate Translation Result
  const mathResult: CoordinateTranslationResult = useMemo(() => {
    return calculateRemoteCoordinates(cursorPos.x, cursorPos.y, videoBoundingBox, hostMetadata);
  }, [cursorPos, videoBoundingBox, hostMetadata]);

  // Handle Mouse Movement over Container
  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(containerWidth, e.clientX - rect.left));
    const y = Math.max(0, Math.min(containerHeight, e.clientY - rect.top));
    setCursorPos({ x, y });
  };

  const handlePointerDown = () => {
    setIsClicking(true);
    if (!mathResult.isOutOfBounds) {
      setClickHistory((prev) => [
        {
          id: Date.now(),
          normX: mathResult.normalizedX,
          normY: mathResult.normalizedY,
          hostX: mathResult.hostPhysicalX,
          hostY: mathResult.hostPhysicalY,
        },
        ...prev.slice(0, 7),
      ]);
    }
  };

  const handlePointerUp = () => {
    setIsClicking(false);
  };

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-2">
      {/* Top Banner / Explanation */}
      <div className="bg-[#0c0e18]/90 border border-cyan-500/20 rounded-2xl p-6 shadow-[0_8px_32px_rgba(0,0,0,0.5)] backdrop-blur-xl relative overflow-hidden">
        <div className="absolute -right-16 -top-16 w-64 h-64 bg-cyan-500/10 rounded-full blur-3xl pointer-events-none" />
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 relative z-10">
          <div className="space-y-1">
            <div className="flex items-center space-x-2">
              <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-cyan-500/10 text-cyan-300 border border-cyan-500/30 shadow-[0_0_10px_rgba(0,210,255,0.15)]">
                Mathematical Coordinate Engine
              </span>
              <span className="text-xs text-slate-400 font-mono">
                CSS object-fit: contain Translation
              </span>
            </div>
            <h2 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
              <span className="bg-gradient-to-r from-white via-cyan-100 to-cyan-300 bg-clip-text text-transparent">
                Letterbox & Pillarbox Coordinate Translation Simulator
              </span>
            </h2>
            <p className="text-sm text-slate-300 max-w-3xl leading-relaxed">
              Test how mouse movements and clicks on a client's resized <code className="text-cyan-300 font-mono bg-[#141829] px-1.5 py-0.5 rounded border border-cyan-500/20">&lt;video&gt;</code> element translate into exact, sub-pixel physical coordinates on the Host's monitor, filtering out letterbox/pillarbox black bars and accounting for High-DPI/Retina scaling.
            </p>
          </div>

          {/* Quick Metrics */}
          <div className="flex items-center gap-3 self-start lg:self-center">
            <div className="px-4 py-2.5 rounded-xl bg-[#07080f]/90 border border-cyan-500/20 text-center shadow-inner">
              <div className="text-[11px] text-slate-400 font-medium">Render State</div>
              <div className="text-sm font-mono font-bold text-cyan-300">
                {mathResult.isPillarboxed ? 'Pillarboxed (L/R)' : mathResult.isLetterboxed ? 'Letterboxed (T/B)' : 'Exact Fit'}
              </div>
            </div>
            <div className="px-4 py-2.5 rounded-xl bg-[#07080f]/90 border border-cyan-500/20 text-center shadow-inner">
              <div className="text-[11px] text-slate-400 font-medium">Pointer State</div>
              <div className={`text-sm font-mono font-bold ${mathResult.isOutOfBounds ? 'text-amber-400' : 'text-emerald-400'}`}>
                {mathResult.isOutOfBounds ? 'On Black Bar' : 'In Active Video'}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Control Panel: Host Configuration & Client Window Configuration */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Host Monitor Settings */}
        <div className="bg-[#0b0d17]/90 border border-cyan-500/20 rounded-2xl p-5 space-y-4 backdrop-blur-xl shadow-xl">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <Monitor className="w-5 h-5 text-cyan-400" />
              <h3 className="font-semibold text-white text-base">Host Display Parameters</h3>
            </div>
            <span className="text-xs font-mono text-cyan-300 bg-cyan-950/40 border border-cyan-500/30 px-2 py-0.5 rounded">
              Source Stream: {hostWidth} × {hostHeight}
            </span>
          </div>

          {/* Presets */}
          <div>
            <label className="text-xs text-slate-400 font-medium block mb-2">Display Presets</label>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {PRESETS.map((p) => {
                const isSelected = selectedPreset.name === p.name;
                return (
                  <button
                    key={p.name}
                    id={`preset-${p.name.replace(/\s+/g, '-').toLowerCase()}`}
                    onClick={() => handlePresetSelect(p)}
                    className={`px-3 py-2 rounded-xl text-left transition-all border ${
                      isSelected
                        ? 'bg-cyan-500/20 border-cyan-400 text-cyan-100 shadow-[0_0_15px_rgba(0,210,255,0.15)]'
                        : 'bg-[#07080f]/80 border-slate-800/90 text-slate-300 hover:border-cyan-500/40 hover:bg-[#0c0f1d]'
                    }`}
                  >
                    <div className="text-xs font-bold truncate">{p.name}</div>
                    <div className="text-[11px] font-mono text-slate-400">
                      {p.width}×{p.height} ({p.dpr}x)
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Custom Host Dimensions Inputs */}
          <div className="grid grid-cols-3 gap-3 pt-2">
            <div>
              <label className="text-xs text-slate-400 font-medium block mb-1">Host Width (px)</label>
              <input
                type="number"
                value={hostWidth}
                onChange={(e) => setHostWidth(Math.max(100, parseInt(e.target.value) || 0))}
                className="w-full bg-[#07080f] border border-slate-700/80 rounded-lg px-3 py-1.5 text-xs text-white font-mono focus:border-cyan-400 focus:shadow-[0_0_10px_rgba(0,210,255,0.2)] focus:outline-none transition-all"
              />
            </div>
            <div>
              <label className="text-xs text-slate-400 font-medium block mb-1">Host Height (px)</label>
              <input
                type="number"
                value={hostHeight}
                onChange={(e) => setHostHeight(Math.max(100, parseInt(e.target.value) || 0))}
                className="w-full bg-[#07080f] border border-slate-700/80 rounded-lg px-3 py-1.5 text-xs text-white font-mono focus:border-cyan-400 focus:shadow-[0_0_10px_rgba(0,210,255,0.2)] focus:outline-none transition-all"
              />
            </div>
            <div>
              <label className="text-xs text-slate-400 font-medium block mb-1">DPR / Scale Factor</label>
              <select
                value={hostDpr}
                onChange={(e) => setHostDpr(parseFloat(e.target.value))}
                className="w-full bg-[#07080f] border border-slate-700/80 rounded-lg px-3 py-1.5 text-xs text-white font-mono focus:border-cyan-400 focus:shadow-[0_0_10px_rgba(0,210,255,0.2)] focus:outline-none transition-all"
              >
                <option value={1.0}>1.0x (Standard)</option>
                <option value={1.25}>1.25x (Windows 125%)</option>
                <option value={1.5}>1.5x (Windows 150%)</option>
                <option value={1.75}>1.75x (Windows 175%)</option>
                <option value={2.0}>2.0x (macOS Retina)</option>
              </select>
            </div>
          </div>
        </div>

        {/* Client Viewer Settings */}
        <div className="bg-[#0b0d17]/90 border border-cyan-500/20 rounded-2xl p-5 space-y-4 backdrop-blur-xl shadow-xl">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <Laptop className="w-5 h-5 text-cyan-400" />
              <h3 className="font-semibold text-white text-base">Client Video Viewport Size</h3>
            </div>
            <span className="text-xs font-mono text-cyan-300 bg-cyan-950/40 border border-cyan-500/30 px-2 py-0.5 rounded">
              Viewport: {containerWidth} × {containerHeight} px
            </span>
          </div>

          {/* Aspect Ratio Presets */}
          <div>
            <label className="text-xs text-slate-400 font-medium block mb-2">
              Client Window Aspect Ratio (Simulate Letterbox vs Pillarbox)
            </label>
            <div className="flex flex-wrap gap-2">
              {(['4:3', '16:9', '21:9', '16:10', 'custom'] as const).map((ratio) => (
                <button
                  key={ratio}
                  id={`ratio-btn-${ratio}`}
                  onClick={() => setContainerAspectMode(ratio)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                    containerAspectMode === ratio
                      ? 'bg-cyan-500/20 border border-cyan-400 text-cyan-200 shadow-[0_0_12px_rgba(0,210,255,0.2)]'
                      : 'bg-[#07080f] border border-slate-800 text-slate-400 hover:text-slate-200 hover:border-slate-700'
                  }`}
                >
                  {ratio === 'custom' ? 'Custom Slider' : ratio}
                </button>
              ))}
            </div>
          </div>

          {/* Sliders */}
          <div className="space-y-3 pt-2">
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-slate-400">Container Width: {containerWidth}px</span>
                <span className="text-slate-500 font-mono">400px - 720px</span>
              </div>
              <input
                type="range"
                min={400}
                max={720}
                value={containerWidth}
                onChange={(e) => setContainerWidth(parseInt(e.target.value))}
                className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-cyan-400"
              />
            </div>
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-slate-400">Container Height: {containerHeight}px</span>
                <span className="text-slate-500 font-mono">250px - 500px</span>
              </div>
              <input
                type="range"
                min={250}
                max={500}
                value={containerHeight}
                disabled={containerAspectMode !== 'custom'}
                onChange={(e) => setContainerHeight(parseInt(e.target.value))}
                className={`w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-cyan-400 ${
                  containerAspectMode !== 'custom' ? 'opacity-50 cursor-not-allowed' : ''
                }`}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Main Interactive Stage: Client Video Viewport & Real-time Host Mirror */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Interactive Client Video Simulator (7 Cols) */}
        <div className="lg:col-span-7 bg-[#0b0d17]/90 border border-cyan-500/20 rounded-2xl p-5 space-y-4 shadow-xl backdrop-blur-xl">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-bold text-white text-base flex items-center gap-2">
                <MousePointer className="w-4 h-4 text-cyan-400" />
                Client &lt;video&gt; Viewport (Hover & Click)
              </h3>
              <p className="text-xs text-slate-400">
                Move your mouse inside to test letterbox containment calculations in real time.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-mono bg-cyan-950/60 text-cyan-300 border border-cyan-500/30">
                Cursor: ({cursorPos.x}, {cursorPos.y})
              </span>
            </div>
          </div>

          {/* Interactive Container Box */}
          <div className="flex items-center justify-center p-4 bg-[#05060a] rounded-xl border border-cyan-500/15 min-h-[460px] overflow-hidden">
            <div
              ref={containerRef}
              id="interactive-client-container"
              onMouseMove={handleMouseMove}
              onMouseDown={handlePointerDown}
              onMouseUp={handlePointerUp}
              style={{
                width: `${containerWidth}px`,
                height: `${containerHeight}px`,
              }}
              className="relative bg-[#080910] rounded-lg border-2 border-cyan-500/30 shadow-[0_0_30px_rgba(0,0,0,0.8)] overflow-hidden cursor-crosshair select-none transition-all duration-75"
            >
              {/* 1. Black Letterbox / Pillarbox Bars Overlay with Diagonal Hatching */}
              {mathResult.isPillarboxed && (
                <>
                  {/* Left Pillar Bar */}
                  <div
                    style={{ width: `${mathResult.offsetX}px`, height: '100%' }}
                    className="absolute top-0 left-0 bg-black/90 border-r border-amber-500/40 flex items-center justify-center z-10 pointer-events-none"
                  >
                    <div className="rotate-90 text-[10px] font-mono text-amber-400 font-semibold tracking-wider">
                      PILLARBAR ({Math.round(mathResult.offsetX)}px)
                    </div>
                  </div>
                  {/* Right Pillar Bar */}
                  <div
                    style={{ width: `${mathResult.offsetX}px`, height: '100%' }}
                    className="absolute top-0 right-0 bg-black/90 border-l border-amber-500/40 flex items-center justify-center z-10 pointer-events-none"
                  >
                    <div className="-rotate-90 text-[10px] font-mono text-amber-400 font-semibold tracking-wider">
                      PILLARBAR ({Math.round(mathResult.offsetX)}px)
                    </div>
                  </div>
                </>
              )}

              {mathResult.isLetterboxed && (
                <>
                  {/* Top Letterbox Bar */}
                  <div
                    style={{ width: '100%', height: `${mathResult.offsetY}px` }}
                    className="absolute top-0 left-0 bg-black/90 border-b border-amber-500/40 flex items-center justify-center z-10 pointer-events-none"
                  >
                    <span className="text-[10px] font-mono text-amber-400 font-semibold tracking-wider">
                      LETTERBOX BAR TOP ({Math.round(mathResult.offsetY)}px)
                    </span>
                  </div>
                  {/* Bottom Letterbox Bar */}
                  <div
                    style={{ width: '100%', height: `${mathResult.offsetY}px` }}
                    className="absolute bottom-0 left-0 bg-black/90 border-t border-amber-500/40 flex items-center justify-center z-10 pointer-events-none"
                  >
                    <span className="text-[10px] font-mono text-amber-400 font-semibold tracking-wider">
                      LETTERBOX BAR BOTTOM ({Math.round(mathResult.offsetY)}px)
                    </span>
                  </div>
                </>
              )}

              {/* 2. Active Rendered Video Stream Area */}
              <div
                id="active-video-rendered-area"
                style={{
                  width: `${mathResult.renderedWidth}px`,
                  height: `${mathResult.renderedHeight}px`,
                  left: `${mathResult.offsetX}px`,
                  top: `${mathResult.offsetY}px`,
                }}
                className="absolute bg-gradient-to-br from-[#0c1226] via-[#090d1a] to-[#05070f] border border-cyan-500/40 shadow-[inset_0_0_20px_rgba(0,210,255,0.08)]"
              >
                {/* Virtual Desktop Background Grids */}
                <div className="absolute inset-0 opacity-25 bg-[radial-gradient(#00d2ff_1px,transparent_1px)] [background-size:16px_16px]" />

                {/* Simulated Desktop Window on Host Stream */}
                <div className="absolute top-4 left-6 right-6 bottom-6 border border-cyan-500/20 rounded-lg bg-[#070914]/80 p-3 pointer-events-none backdrop-blur-sm shadow-xl">
                  <div className="flex items-center justify-between pb-2 border-b border-slate-800">
                    <div className="flex items-center space-x-1.5">
                      <div className="w-2.5 h-2.5 rounded-full bg-rose-500/80" />
                      <div className="w-2.5 h-2.5 rounded-full bg-amber-500/80" />
                      <div className="w-2.5 h-2.5 rounded-full bg-emerald-500/80" />
                    </div>
                    <span className="text-[10px] font-mono text-cyan-300/80">Host Terminal - 60 FPS Stream</span>
                  </div>
                  <div className="mt-3 font-mono text-[10px] text-slate-400 space-y-1">
                    <p className="text-emerald-400">$ node server/signalingServer.ts</p>
                    <p className="text-cyan-300">⚡ WebRTC peer connection connected (DataChannel: sub-ms)</p>
                    <p className="text-slate-400">Target Display: {hostWidth}x{hostHeight} ({hostDpr}x DPR)</p>
                  </div>
                </div>

                {/* Active Dimension Badge */}
                <div className="absolute bottom-2 right-2 bg-cyan-950/80 text-cyan-200 border border-cyan-500/50 px-2 py-0.5 rounded text-[10px] font-mono shadow-[0_0_10px_rgba(0,210,255,0.2)]">
                  Stream: {Math.round(mathResult.renderedWidth)} × {Math.round(mathResult.renderedHeight)} px
                </div>
              </div>

              {/* 3. Crosshairs and Cursor Tracking */}
              <div
                style={{
                  left: `${cursorPos.x}px`,
                  top: `${cursorPos.y}px`,
                }}
                className="absolute z-30 pointer-events-none transform -translate-x-1/2 -translate-y-1/2"
              >
                {/* Crosshair ring */}
                <div
                  className={`w-6 h-6 rounded-full border-2 flex items-center justify-center transition-transform ${
                    isClicking ? 'scale-75 bg-cyan-500/40 border-cyan-300 shadow-[0_0_15px_rgba(0,210,255,0.8)]' : 'border-cyan-400 bg-cyan-400/10 shadow-[0_0_10px_rgba(0,210,255,0.4)]'
                  } ${mathResult.isOutOfBounds ? 'border-amber-400 bg-amber-500/10 shadow-[0_0_10px_rgba(245,158,11,0.4)]' : ''}`}
                >
                  <div className={`w-1.5 h-1.5 rounded-full ${mathResult.isOutOfBounds ? 'bg-amber-400' : 'bg-cyan-300'}`} />
                </div>

                {/* Coordinate Bubble */}
                <div
                  className={`absolute top-4 left-4 whitespace-nowrap px-2 py-1 rounded text-[10px] font-mono shadow-xl border ${
                    mathResult.isOutOfBounds
                      ? 'bg-amber-950/95 text-amber-200 border-amber-500'
                      : 'bg-[#090c18]/95 text-slate-100 border-cyan-500/60 shadow-[0_0_15px_rgba(0,210,255,0.2)]'
                  }`}
                >
                  {mathResult.isOutOfBounds ? (
                    <span className="font-bold text-amber-300">Out of Video Bounds (Letterbox)</span>
                  ) : (
                    <>
                      <div className="text-cyan-300">Norm: (u={mathResult.normalizedX}, v={mathResult.normalizedY})</div>
                      <div className="text-emerald-400 font-bold">
                        Host: {mathResult.hostPhysicalX}px, {mathResult.hostPhysicalY}px
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Quick Guidance Footer */}
          <div className="flex items-center justify-between text-xs text-slate-400 bg-[#07080f] px-3 py-2 rounded-lg border border-cyan-500/15">
            <span className="flex items-center gap-1.5">
              <Info className="w-4 h-4 text-cyan-400" />
              Clicks inside the active video area emit packets over the WebRTC RTCDataChannel.
            </span>
            <span className="text-cyan-400 font-mono">
              Clicks logged: {clickHistory.length}
            </span>
          </div>
        </div>

        {/* Real-Time Host Screen Mirror & Coordinate Breakdown (5 Cols) */}
        <div className="lg:col-span-5 space-y-6">
          {/* Host Screen Projection Mirror */}
          <div className="bg-[#0b0d17]/90 border border-cyan-500/20 rounded-2xl p-5 space-y-4 shadow-xl backdrop-blur-xl">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-white text-base flex items-center gap-2">
                <Monitor className="w-4 h-4 text-emerald-400" />
                Virtual Host Monitor Projection
              </h3>
              <span className="text-xs font-mono text-emerald-300 bg-emerald-950/60 border border-emerald-500/40 px-2 py-0.5 rounded shadow-[0_0_10px_rgba(16,185,129,0.15)]">
                Physical: {hostWidth} × {hostHeight}
              </span>
            </div>

            {/* Host Monitor Canvas Preview */}
            <div className="relative aspect-video bg-[#05060b] rounded-xl border border-cyan-500/20 p-2 overflow-hidden shadow-inner flex flex-col justify-between">
              {/* Virtual Host Wallpaper */}
              <div className="absolute inset-0 bg-gradient-to-tr from-[#050711] via-[#080d20] to-cyan-950/30 pointer-events-none" />

              {/* Host OS Taskbar */}
              <div className="relative z-10 flex items-center justify-between text-[9px] font-mono text-slate-400 bg-[#090c18]/80 px-2 py-1 rounded border border-cyan-500/20">
                <span className="font-semibold text-cyan-200">Host OS Desktop (Primary Display)</span>
                <span className="text-slate-300">DPR: {hostDpr}x</span>
              </div>

              {/* Projected Cursor on Host */}
              <div
                style={{
                  left: `${mathResult.normalizedX * 100}%`,
                  top: `${mathResult.normalizedY * 100}%`,
                }}
                className="absolute z-20 pointer-events-none transform -translate-x-1/2 -translate-y-1/2 transition-all duration-75"
              >
                <div className="w-4 h-4 rounded-full bg-emerald-500/30 border-2 border-emerald-400 flex items-center justify-center shadow-[0_0_12px_rgba(16,185,129,0.7)] animate-pulse">
                  <div className="w-1 h-1 bg-emerald-200 rounded-full" />
                </div>
                <div className="absolute top-2 left-2 bg-emerald-950/95 text-emerald-300 border border-emerald-600 px-1.5 py-0.5 rounded text-[9px] font-mono whitespace-nowrap shadow-lg">
                  ({mathResult.hostPhysicalX}, {mathResult.hostPhysicalY})
                </div>
              </div>

              {/* Recent Click Markers on Host Desktop */}
              {clickHistory.map((c, i) => (
                <div
                  key={c.id}
                  style={{
                    left: `${c.normX * 100}%`,
                    top: `${c.normY * 100}%`,
                  }}
                  className="absolute w-2.5 h-2.5 rounded-full border border-cyan-400 bg-cyan-400/80 shadow-[0_0_8px_rgba(0,210,255,0.8)] transform -translate-x-1/2 -translate-y-1/2 z-10 pointer-events-none"
                  title={`Click #${i + 1}: ${c.hostX}, ${c.hostY}`}
                />
              ))}

              {/* Host Footer info */}
              <div className="relative z-10 flex items-center justify-between text-[9px] font-mono text-slate-400 bg-[#090c18]/80 px-2 py-1 rounded border border-cyan-500/20">
                <span>Logical (OS points): {mathResult.hostLogicalX}pt, {mathResult.hostLogicalY}pt</span>
                <span className="text-emerald-400 font-semibold">Status: Active Stream</span>
              </div>
            </div>

            {/* Exact Live Numbers Table */}
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="p-2.5 rounded-xl bg-[#07080f] border border-cyan-500/15">
                <div className="text-[11px] text-slate-400">Normalized (u, v)</div>
                <div className="font-mono font-bold text-cyan-300 text-sm mt-0.5">
                  ({mathResult.normalizedX}, {mathResult.normalizedY})
                </div>
              </div>
              <div className="p-2.5 rounded-xl bg-[#07080f] border border-cyan-500/15">
                <div className="text-[11px] text-slate-400">Host Physical Pixels</div>
                <div className="font-mono font-bold text-emerald-400 text-sm mt-0.5">
                  X: {mathResult.hostPhysicalX}, Y: {mathResult.hostPhysicalY}
                </div>
              </div>
              <div className="p-2.5 rounded-xl bg-[#07080f] border border-cyan-500/15">
                <div className="text-[11px] text-slate-400">Host Logical (OS points)</div>
                <div className="font-mono font-bold text-sky-400 text-sm mt-0.5">
                  X: {mathResult.hostLogicalX}, Y: {mathResult.hostLogicalY}
                </div>
              </div>
              <div className="p-2.5 rounded-xl bg-[#07080f] border border-cyan-500/15">
                <div className="text-[11px] text-slate-400">Black Bar Offset</div>
                <div className="font-mono font-bold text-amber-400 text-sm mt-0.5">
                  ΔX: {Math.round(mathResult.offsetX)}px, ΔY: {Math.round(mathResult.offsetY)}px
                </div>
              </div>
            </div>
          </div>

          {/* Mathematical Formula Breakdown Card */}
          <div className="bg-[#0b0d17]/90 border border-cyan-500/20 rounded-2xl p-5 space-y-3 backdrop-blur-xl shadow-xl">
            <h4 className="font-semibold text-white text-sm flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-cyan-400" />
              Live Mathematical Execution Steps
            </h4>

            <div className="space-y-2 text-xs font-mono bg-[#07080f] p-3.5 rounded-xl border border-cyan-500/15 text-slate-300 leading-relaxed">
              <div className="text-slate-400">
                <span className="text-cyan-400 font-semibold">1. Aspect Ratios:</span> AR_host = {hostWidth}/{hostHeight} = {(hostWidth / hostHeight).toFixed(3)}, AR_cont = {containerWidth}/{containerHeight} = {(containerWidth / containerHeight).toFixed(3)}
              </div>
              <div className="text-slate-400">
                <span className="text-cyan-400 font-semibold">2. Active Render:</span> W_rend = {Math.round(mathResult.renderedWidth)}px, H_rend = {Math.round(mathResult.renderedHeight)}px (OffsetX = {Math.round(mathResult.offsetX)}px, OffsetY = {Math.round(mathResult.offsetY)}px)
              </div>
              <div className="text-slate-400">
                <span className="text-cyan-400 font-semibold">3. Unit Normalization:</span> u = ({cursorPos.x} - {Math.round(mathResult.offsetX)}) / {Math.round(mathResult.renderedWidth)} = <strong className="text-cyan-200">{mathResult.normalizedX}</strong>
              </div>
              <div className="text-slate-400">
                <span className="text-cyan-400 font-semibold">4. Host Physical:</span> X_host = {mathResult.normalizedX} × {hostWidth} = <strong className="text-emerald-400">{mathResult.hostPhysicalX}px</strong>
              </div>
              <div className="text-slate-400">
                <span className="text-cyan-400 font-semibold">5. OS Nut-js Target:</span> X_log = {mathResult.hostPhysicalX} / {hostDpr} = <strong className="text-sky-400">{mathResult.hostLogicalX}pt</strong>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
