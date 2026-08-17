import React, { useState, useEffect, useRef } from 'react';
import {
  Shield,
  ShieldAlert,
  ShieldCheck,
  MousePointer,
  AlertTriangle,
  Lock,
  Unlock,
  Power,
  RefreshCw,
  Eye,
  CheckCircle2,
  XCircle,
} from 'lucide-react';

export const SecurityKillSwitchDemo: React.FC = () => {
  // Permission State
  const [permissionStatus, setPermissionStatus] = useState<'pending' | 'granted' | 'denied'>('pending');
  const [requestingClient, setRequestingClient] = useState<{ name: string; ip: string; id: string }>({
    name: 'Sarah (Remote Support)',
    ip: '192.168.1.42',
    id: 'client_7a9f21b',
  });

  // Kill Switch State
  const [isSuspended, setIsSuspended] = useState<boolean>(false);
  const [remainingSuspendTimeMs, setRemainingSuspendTimeMs] = useState<number>(0);
  const [hostPhysicalMousePos, setHostPhysicalMousePos] = useState<{ x: number; y: number }>({ x: 500, y: 300 });
  const [overrideCount, setOverrideCount] = useState<number>(0);

  const suspendTimerRef = useRef<number | null>(null);

  // Trigger Host Manual Mouse Move Override
  const triggerHostPhysicalMovement = () => {
    // Host moved their mouse physically!
    const newX = Math.round(200 + Math.random() * 600);
    const newY = Math.round(150 + Math.random() * 300);
    setHostPhysicalMousePos({ x: newX, y: newY });
    setIsSuspended(true);
    setRemainingSuspendTimeMs(2000);
    setOverrideCount((c) => c + 1);

    if (suspendTimerRef.current) {
      clearInterval(suspendTimerRef.current);
    }

    const startTime = Date.now();
    const duration = 2000;

    suspendTimerRef.current = window.setInterval(() => {
      const elapsed = Date.now() - startTime;
      const remaining = Math.max(0, duration - elapsed);
      setRemainingSuspendTimeMs(remaining);

      if (remaining <= 0) {
        setIsSuspended(false);
        if (suspendTimerRef.current) clearInterval(suspendTimerRef.current);
      }
    }, 50);
  };

  useEffect(() => {
    return () => {
      if (suspendTimerRef.current) clearInterval(suspendTimerRef.current);
    };
  }, []);

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-2">
      {/* Header */}
      <div className="bg-[#0c0e18]/90 border border-cyan-500/20 rounded-2xl p-6 shadow-[0_8px_32px_rgba(0,0,0,0.5)] backdrop-blur-xl relative overflow-hidden">
        <div className="absolute -right-16 -top-16 w-64 h-64 bg-cyan-500/10 rounded-full blur-3xl pointer-events-none" />
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 relative z-10">
          <div className="space-y-1">
            <div className="flex items-center space-x-2">
              <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-rose-500/10 text-rose-400 border border-rose-500/30 shadow-[0_0_10px_rgba(244,63,94,0.15)]">
                Security & Safety Guardrails
              </span>
              <span className="text-xs text-slate-400 font-mono">
                Zero-Trust Host Override System
              </span>
            </div>
            <h2 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
              <span className="bg-gradient-to-r from-white via-cyan-100 to-cyan-300 bg-clip-text text-transparent">
                Host Permission Dialog & Physical Mouse Kill-Switch Simulator
              </span>
            </h2>
            <p className="text-sm text-slate-300 max-w-3xl leading-relaxed">
              In remote access tools like TeamViewer or AnyDesk, security hinges on two non-negotiable guarantees: <strong>Explicit Permission Approval</strong> before control injection, and an instant <strong>Physical Mouse Kill-Switch</strong> that yields OS control back to the Host the millisecond they touch their local mouse.
            </p>
          </div>
        </div>
      </div>

      {/* Two Pillars: 1. Permission Gate, 2. Kill Switch */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Pillar 1: Permission Prompt */}
        <div className="bg-[#0b0d17]/90 border border-cyan-500/20 rounded-2xl p-5 space-y-4 shadow-xl backdrop-blur-xl">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <Shield className="w-5 h-5 text-cyan-400" />
              <h3 className="font-bold text-white text-base">1. Host Ingress Permission Dialog</h3>
            </div>
            <span
              className={`text-xs font-mono px-2.5 py-0.5 rounded font-semibold ${
                permissionStatus === 'granted'
                  ? 'bg-emerald-950/80 text-emerald-300 border border-emerald-500/40 shadow-[0_0_10px_rgba(16,185,129,0.2)]'
                  : permissionStatus === 'denied'
                  ? 'bg-rose-950/80 text-rose-300 border border-rose-500/40 shadow-[0_0_10px_rgba(244,63,94,0.2)]'
                  : 'bg-amber-950/80 text-amber-300 border border-amber-500/40 shadow-[0_0_10px_rgba(245,158,11,0.2)]'
              }`}
            >
              STATUS: {permissionStatus.toUpperCase()}
            </span>
          </div>

          <p className="text-xs text-slate-300">
            Before any <code className="text-cyan-300 bg-[#141829] px-1.5 py-0.5 rounded border border-cyan-500/20">@nut-tree/nut-js</code> IPC call is executed on the Host's OS, Electron spawns a native modal dialog (<code className="text-cyan-300 bg-[#141829] px-1.5 py-0.5 rounded border border-cyan-500/20">dialog.showMessageBox</code>).
          </p>

          {/* Native Dialog Simulation Box */}
          <div className="bg-[#07080f] border border-cyan-500/30 rounded-xl p-5 space-y-4 shadow-2xl relative overflow-hidden backdrop-blur-xl">
            <div className="flex items-start space-x-3">
              <div className="w-10 h-10 rounded-full bg-cyan-950/60 border border-cyan-400/50 flex items-center justify-center shrink-0 shadow-[0_0_12px_rgba(0,210,255,0.2)]">
                <Lock className="w-5 h-5 text-cyan-300" />
              </div>
              <div className="space-y-1">
                <h4 className="text-sm font-bold text-white">Remote Control Authorization Request</h4>
                <p className="text-xs text-slate-300 leading-relaxed">
                  <strong>"{requestingClient.name}"</strong> (ID: {requestingClient.id}) is requesting control of your keyboard and mouse.
                </p>
                <div className="text-[11px] font-mono text-slate-400 pt-1">
                  Safety: You can override remote control at any moment simply by moving your physical mouse.
                </div>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex items-center justify-end space-x-3 pt-2">
              <button
                onClick={() => setPermissionStatus('denied')}
                className="px-4 py-2 rounded-xl bg-[#0e111d] hover:bg-[#151a2d] text-slate-300 font-medium text-xs border border-cyan-500/20 transition-all"
              >
                Deny Request
              </button>
              <button
                onClick={() => setPermissionStatus('granted')}
                className="px-4 py-2 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-semibold text-xs shadow-md shadow-emerald-600/30 transition-all flex items-center space-x-1.5"
              >
                <CheckCircle2 className="w-4 h-4" />
                <span>Accept & Grant Control</span>
              </button>
            </div>
          </div>

          <div className="flex justify-between items-center text-xs text-slate-400 pt-2 border-t border-cyan-500/15">
            <span>Reset request simulation:</span>
            <button
              onClick={() => setPermissionStatus('pending')}
              className="text-cyan-400 hover:text-cyan-300 hover:underline font-mono text-xs"
            >
              Reset to Pending
            </button>
          </div>
        </div>

        {/* Pillar 2: 2-Second Physical Mouse Kill-Switch */}
        <div className="bg-[#0b0d17]/90 border border-cyan-500/20 rounded-2xl p-5 space-y-4 shadow-xl backdrop-blur-xl">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <Power className="w-5 h-5 text-rose-400" />
              <h3 className="font-bold text-white text-base">2. Physical Mouse Movement Kill-Switch</h3>
            </div>
            <span
              className={`text-xs font-mono px-2.5 py-0.5 rounded font-semibold ${
                isSuspended
                  ? 'bg-rose-950/80 text-rose-300 border border-rose-500/40 shadow-[0_0_10px_rgba(244,63,94,0.3)] animate-pulse'
                  : 'bg-emerald-950/80 text-emerald-300 border border-emerald-500/40 shadow-[0_0_10px_rgba(16,185,129,0.2)]'
              }`}
            >
              {isSuspended ? `KILL-SWITCH ACTIVE (${remainingSuspendTimeMs}ms)` : 'REMOTE CONTROL LIVE'}
            </span>
          </div>

          <p className="text-xs text-slate-300">
            Electron monitors local cursor delta. If physical mouse movement exceeds 15px, remote input is blocked for <strong>2,000ms</strong>.
          </p>

          {/* Kill Switch Simulation Trigger */}
          <div className="bg-[#07080f] border border-cyan-500/20 rounded-xl p-5 space-y-4 backdrop-blur-xl">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs text-slate-400 font-medium">Simulated Local Host Cursor</div>
                <div className="text-sm font-mono font-bold text-cyan-300">
                  Pos: ({hostPhysicalMousePos.x}, {hostPhysicalMousePos.y})
                </div>
              </div>
              <div className="text-right">
                <div className="text-xs text-slate-400 font-medium">Overrides Triggered</div>
                <div className="text-sm font-mono font-bold text-rose-400">{overrideCount}</div>
              </div>
            </div>

            {/* Big Trigger Button */}
            <button
              onClick={triggerHostPhysicalMovement}
              className="w-full flex items-center justify-center space-x-2 py-3 rounded-xl bg-gradient-to-r from-rose-600 via-amber-600 to-rose-600 hover:from-rose-500 hover:to-amber-500 text-white font-bold text-xs sm:text-sm shadow-lg shadow-rose-600/30 transition-all border border-rose-400/30"
            >
              <MousePointer className="w-4 h-4" />
              <span>Simulate Physical Host Mouse Movement (Trigger 2s Kill-Switch)</span>
            </button>

            {/* Progress Bar of Suspension */}
            {isSuspended && (
              <div className="space-y-1">
                <div className="flex justify-between text-xs text-rose-300 font-mono">
                  <span>Input Injection Blocked:</span>
                  <span>{remainingSuspendTimeMs} ms</span>
                </div>
                <div className="w-full h-2 bg-[#05060b] rounded-full overflow-hidden border border-rose-500/30">
                  <div
                    style={{ width: `${(remainingSuspendTimeMs / 2000) * 100}%` }}
                    className="h-full bg-gradient-to-r from-rose-500 to-amber-500 transition-all duration-75 shadow-[0_0_10px_rgba(244,63,94,0.8)]"
                  />
                </div>
              </div>
            )}
          </div>

          <div className="p-3 bg-[#05060b] rounded-xl border border-cyan-500/15 text-[11px] font-mono text-slate-300 space-y-1">
            <div className="text-cyan-400 font-semibold">// Electron Main Process Guard Logic:</div>
            <div>if (isHostMovingPhysicalMouse() || Date.now() &lt; suspendUntil) &#123;</div>
            <div className="pl-4 text-rose-400">return; // Drop remote input packet immediately</div>
            <div>&#125;</div>
          </div>
        </div>
      </div>
    </div>
  );
};
