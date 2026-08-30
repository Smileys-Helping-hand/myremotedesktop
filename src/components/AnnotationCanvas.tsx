import React, { useRef, useEffect, useState, useCallback } from 'react';
import {
  MousePointer2,
  PenTool,
  Sparkles,
  Trash2,
  Palette,
} from 'lucide-react';
import { AnnotationPoint, AnnotationStrokePayload } from '../types/remoteControl';

export type AnnotationMode = 'remote' | 'laser' | 'pen';

interface Stroke {
  id: string;
  points: AnnotationPoint[];
  color: string;
  width: number;
  mode: 'pen' | 'laser';
  createdAt: number;
}

interface AnnotationCanvasProps {
  mode: AnnotationMode;
  onModeChange: (mode: AnnotationMode) => void;
  onSendStroke?: (stroke: AnnotationStrokePayload) => void;
  isHost?: boolean;
  incomingStroke?: AnnotationStrokePayload | null;
  className?: string;
  fadeDurationMs?: number;
}

const PEN_COLORS = ['#06b6d4', '#f43f5e', '#10b981', '#fbbf24', '#a855f7'];

export const AnnotationCanvas: React.FC<AnnotationCanvasProps> = ({
  mode,
  onModeChange,
  onSendStroke,
  isHost = false,
  incomingStroke,
  className = '',
  fadeDurationMs = 5000,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const currentStrokeRef = useRef<Stroke | null>(null);
  const laserPointRef = useRef<{ x: number; y: number; time: number; color: string } | null>(null);
  const animFrameIdRef = useRef<number | null>(null);

  const [selectedColor, setSelectedColor] = useState<string>('#06b6d4');
  const [lineWidth] = useState<number>(3);
  const [isDrawing, setIsDrawing] = useState<boolean>(false);

  // Handle incoming remote stroke from peer
  useEffect(() => {
    if (!incomingStroke) return;

    if (incomingStroke.mode === 'clear') {
      strokesRef.current = [];
      laserPointRef.current = null;
      return;
    }

    if (incomingStroke.mode === 'laser') {
      const lastPt = incomingStroke.points[incomingStroke.points.length - 1];
      if (lastPt) {
        laserPointRef.current = {
          x: lastPt.x,
          y: lastPt.y,
          time: Date.now(),
          color: incomingStroke.color || '#f43f5e',
        };
      }
    } else if (incomingStroke.mode === 'pen') {
      const newStroke: Stroke = {
        id: incomingStroke.strokeId,
        points: incomingStroke.points,
        color: incomingStroke.color,
        width: incomingStroke.width,
        mode: 'pen',
        createdAt: Date.now(),
      };
      strokesRef.current.push(newStroke);
    }
  }, [incomingStroke]);

  // Main Canvas Render Loop with Auto-Fading
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let isRunning = true;

    const render = () => {
      if (!isRunning) return;

      const width = canvas.width;
      const height = canvas.height;
      const now = Date.now();

      ctx.clearRect(0, 0, width, height);

      // 1. Draw and clean faded pen strokes
      const activeStrokes: Stroke[] = [];

      for (const stroke of strokesRef.current) {
        const age = now - stroke.createdAt;
        if (age < fadeDurationMs) {
          const alpha = Math.max(0, 1 - age / fadeDurationMs);
          ctx.save();
          ctx.beginPath();
          ctx.strokeStyle = stroke.color;
          ctx.globalAlpha = alpha;
          ctx.lineWidth = stroke.width;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';

          // Glow effect for annotations
          ctx.shadowColor = stroke.color;
          ctx.shadowBlur = 6;

          stroke.points.forEach((pt, idx) => {
            const px = pt.x * width;
            const py = pt.y * height;
            if (idx === 0) {
              ctx.moveTo(px, py);
            } else {
              ctx.lineTo(px, py);
            }
          });
          ctx.stroke();
          ctx.restore();

          activeStrokes.push(stroke);
        }
      }
      strokesRef.current = activeStrokes;

      // 2. Draw active in-progress drawing stroke
      if (currentStrokeRef.current && currentStrokeRef.current.points.length > 0) {
        const stroke = currentStrokeRef.current;
        ctx.save();
        ctx.beginPath();
        ctx.strokeStyle = stroke.color;
        ctx.globalAlpha = 1.0;
        ctx.lineWidth = stroke.width;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.shadowColor = stroke.color;
        ctx.shadowBlur = 8;

        stroke.points.forEach((pt, idx) => {
          const px = pt.x * width;
          const py = pt.y * height;
          if (idx === 0) {
            ctx.moveTo(px, py);
          } else {
            ctx.lineTo(px, py);
          }
        });
        ctx.stroke();
        ctx.restore();
      }

      // 3. Draw Laser Pointer Dot & Pulsing Rings
      if (laserPointRef.current) {
        const laser = laserPointRef.current;
        const laserAge = now - laser.time;
        if (laserAge < 2500) {
          const px = laser.x * width;
          const py = laser.y * height;
          const pulse = (Math.sin(now / 150) + 1) / 2; // 0..1 pulse

          ctx.save();
          // Outer ripple
          ctx.beginPath();
          ctx.arc(px, py, 14 + pulse * 8, 0, Math.PI * 2);
          ctx.fillStyle = laser.color;
          ctx.globalAlpha = 0.25 * (1 - laserAge / 2500);
          ctx.fill();

          // Inner glow
          ctx.beginPath();
          ctx.arc(px, py, 7, 0, Math.PI * 2);
          ctx.fillStyle = laser.color;
          ctx.globalAlpha = 0.9 * (1 - laserAge / 2500);
          ctx.shadowColor = laser.color;
          ctx.shadowBlur = 12;
          ctx.fill();

          // Center bright spot
          ctx.beginPath();
          ctx.arc(px, py, 3, 0, Math.PI * 2);
          ctx.fillStyle = '#ffffff';
          ctx.globalAlpha = 1.0;
          ctx.fill();

          ctx.restore();
        } else {
          laserPointRef.current = null;
        }
      }

      animFrameIdRef.current = requestAnimationFrame(render);
    };

    render();

    return () => {
      isRunning = false;
      if (animFrameIdRef.current) {
        cancelAnimationFrame(animFrameIdRef.current);
      }
    };
  }, [fadeDurationMs]);

  // Adjust canvas pixel density on container resize
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          canvas.width = width;
          canvas.height = height;
        }
      }
    });

    resizeObserver.observe(canvas);
    return () => resizeObserver.disconnect();
  }, []);

  // Coordinate normalizer
  const getNormalizedPos = useCallback((e: React.MouseEvent<HTMLCanvasElement>): AnnotationPoint => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0, time: Date.now() };

    const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));

    return { x, y, time: Date.now() };
  }, []);

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (mode === 'remote') return;

    const pt = getNormalizedPos(e);

    if (mode === 'laser') {
      laserPointRef.current = {
        x: pt.x,
        y: pt.y,
        time: Date.now(),
        color: '#f43f5e',
      };
      if (onSendStroke) {
        onSendStroke({
          type: 'ANNOTATION_STROKE',
          strokeId: `laser_${Date.now()}`,
          points: [pt],
          color: '#f43f5e',
          width: 8,
          mode: 'laser',
          timestamp: Date.now(),
        });
      }
    } else if (mode === 'pen') {
      setIsDrawing(true);
      const strokeId = `stroke_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
      currentStrokeRef.current = {
        id: strokeId,
        points: [pt],
        color: selectedColor,
        width: lineWidth,
        mode: 'pen',
        createdAt: Date.now(),
      };
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (mode === 'remote') return;

    const pt = getNormalizedPos(e);

    if (mode === 'laser') {
      laserPointRef.current = {
        x: pt.x,
        y: pt.y,
        time: Date.now(),
        color: '#f43f5e',
      };
      if (onSendStroke && e.buttons === 1) {
        onSendStroke({
          type: 'ANNOTATION_STROKE',
          strokeId: `laser_${Date.now()}`,
          points: [pt],
          color: '#f43f5e',
          width: 8,
          mode: 'laser',
          timestamp: Date.now(),
        });
      }
    } else if (mode === 'pen' && isDrawing && currentStrokeRef.current) {
      currentStrokeRef.current.points.push(pt);
    }
  };

  const handleMouseUp = () => {
    if (mode === 'pen' && isDrawing && currentStrokeRef.current) {
      setIsDrawing(false);
      const stroke = currentStrokeRef.current;
      strokesRef.current.push(stroke);
      currentStrokeRef.current = null;

      if (onSendStroke) {
        onSendStroke({
          type: 'ANNOTATION_STROKE',
          strokeId: stroke.id,
          points: stroke.points,
          color: stroke.color,
          width: stroke.width,
          mode: 'pen',
          timestamp: Date.now(),
        });
      }
    }
  };

  const clearAllAnnotations = () => {
    strokesRef.current = [];
    laserPointRef.current = null;
    currentStrokeRef.current = null;
    if (onSendStroke) {
      onSendStroke({
        type: 'ANNOTATION_STROKE',
        strokeId: `clear_${Date.now()}`,
        points: [],
        color: '#ffffff',
        width: 0,
        mode: 'clear',
        timestamp: Date.now(),
      });
    }
  };

  return (
    <>
      {/* Interactive Overlay Canvas */}
      <canvas
        ref={canvasRef}
        id="annotation-canvas-layer"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        className={`absolute inset-0 w-full h-full ${
          mode === 'remote' ? 'pointer-events-none' : 'pointer-events-auto cursor-crosshair'
        } ${className}`}
      />

      {/* Floating Mode & Color Switcher Toolbar */}
      {!isHost && (
        <div
          id="annotation-toolbar"
          className="absolute top-4 left-1/2 -translate-x-1/2 z-30 bg-[#090b16]/90 border border-cyan-500/30 rounded-xl px-3 py-1.5 shadow-[0_8px_24px_rgba(0,0,0,0.6)] backdrop-blur-md flex items-center space-x-2 text-xs"
        >
          {/* Mode Selector */}
          <div className="flex items-center space-x-1 bg-slate-900/80 p-0.5 rounded-lg border border-slate-800">
            <button
              id="mode-remote-button"
              onClick={() => onModeChange('remote')}
              className={`px-2.5 py-1 rounded-md transition-colors flex items-center gap-1.5 font-medium ${
                mode === 'remote'
                  ? 'bg-cyan-500 text-slate-950 shadow-sm font-semibold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Remote Control Mode (Pass keystrokes and mouse to Host OS)"
            >
              <MousePointer2 className="w-3.5 h-3.5" />
              <span>Control</span>
            </button>

            <button
              id="mode-laser-button"
              onClick={() => onModeChange('laser')}
              className={`px-2.5 py-1 rounded-md transition-colors flex items-center gap-1.5 font-medium ${
                mode === 'laser'
                  ? 'bg-rose-500 text-white shadow-sm font-semibold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Laser Pointer Mode (Highlight points without sending clicks)"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>Laser</span>
            </button>

            <button
              id="mode-pen-button"
              onClick={() => onModeChange('pen')}
              className={`px-2.5 py-1 rounded-md transition-colors flex items-center gap-1.5 font-medium ${
                mode === 'pen'
                  ? 'bg-amber-500 text-slate-950 shadow-sm font-semibold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Annotation Mode (Draw temporary lines with 5s auto-fade)"
            >
              <PenTool className="w-3.5 h-3.5" />
              <span>Pen</span>
            </button>
          </div>

          {/* Color Palettes when in Pen Mode */}
          {mode === 'pen' && (
            <div className="flex items-center space-x-1.5 pl-2 border-l border-slate-800">
              <Palette className="w-3.5 h-3.5 text-slate-400" />
              {PEN_COLORS.map((c) => (
                <button
                  key={c}
                  id={`color-picker-${c.replace('#', '')}`}
                  onClick={() => setSelectedColor(c)}
                  className={`w-4 h-4 rounded-full transition-transform ${
                    selectedColor === c ? 'scale-125 ring-2 ring-white' : 'opacity-70 hover:opacity-100'
                  }`}
                  style={{ backgroundColor: c }}
                />
              ))}

              <button
                id="clear-annotations-button"
                onClick={clearAllAnnotations}
                className="p-1 text-slate-400 hover:text-rose-400 hover:bg-slate-800 rounded transition-colors ml-1"
                title="Clear all drawings"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
};
