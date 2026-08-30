import React from 'react';
import {
  Activity,
  Zap,
  Gauge,
  Layers,
  ArrowDownCircle,
  ArrowUpCircle,
  Clock,
  Wifi,
} from 'lucide-react';
import { WebRTCStats } from '../types/remoteControl';

interface TelemetryStatsPanelProps {
  stats: WebRTCStats;
  resolution?: string;
  isConnected?: boolean;
  isConnecting?: boolean;
  isSocketConnected?: boolean;
  dataChannelsReady?: { mouse: boolean; events: boolean };
}

export const TelemetryStatsPanel: React.FC<TelemetryStatsPanelProps> = ({
  stats,
  resolution = '1920x1080',
  isConnected = false,
  isConnecting = false,
  isSocketConnected = true,
  dataChannelsReady = { mouse: true, events: true },
}) => {
  const rtt = stats.roundTripTimeMs ?? stats.rttMs ?? 12;
  const isHealthyRtt = rtt < 30;
  const isModerateRtt = rtt >= 30 && rtt < 80;

  return (
    <div className="bg-[#090b14]/90 border border-slate-800/90 hover:border-cyan-500/30 rounded-2xl p-4 shadow-xl backdrop-blur-xl space-y-3 transition-all">
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <Activity className="w-4 h-4 text-cyan-400" />
          <h3 className="font-mono text-xs font-bold text-white uppercase tracking-wider">
            WebRTC Telemetry & Channels
          </h3>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full border flex items-center gap-1 ${
            isConnected
              ? 'bg-emerald-950/60 text-emerald-300 border-emerald-500/30'
              : isConnecting
              ? 'bg-amber-950/60 text-amber-300 border-amber-500/30'
              : 'bg-slate-900 text-slate-400 border-slate-800'
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${
              isConnected ? 'bg-emerald-400 animate-pulse' : isConnecting ? 'bg-amber-400' : 'bg-slate-500'
            }`} />
            {isConnected ? 'P2P CONNECTED' : isConnecting ? 'CONNECTING' : 'IDLE'}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        {/* 1. Latency / RTT */}
        <div className="p-2.5 bg-[#06070d] rounded-xl border border-slate-800/80 space-y-1">
          <div className="text-[10px] font-mono text-slate-400 flex items-center justify-between">
            <span className="flex items-center gap-1">
              <Clock className="w-3 h-3 text-cyan-400" />
              RTT Latency
            </span>
          </div>
          <div className={`text-base font-mono font-bold ${
            isHealthyRtt ? 'text-emerald-400' : isModerateRtt ? 'text-amber-400' : 'text-rose-400'
          }`}>
            {rtt.toFixed(0)} <span className="text-xs font-normal text-slate-400">ms</span>
          </div>
        </div>

        {/* 2. Framerate */}
        <div className="p-2.5 bg-[#06070d] rounded-xl border border-slate-800/80 space-y-1">
          <div className="text-[10px] font-mono text-slate-400 flex items-center justify-between">
            <span className="flex items-center gap-1">
              <Gauge className="w-3 h-3 text-cyan-400" />
              Framerate
            </span>
          </div>
          <div className="text-base font-mono font-bold text-cyan-300">
            {stats.fps} <span className="text-xs font-normal text-slate-400">FPS</span>
          </div>
        </div>

        {/* 3. Bitrate */}
        <div className="p-2.5 bg-[#06070d] rounded-xl border border-slate-800/80 space-y-1">
          <div className="text-[10px] font-mono text-slate-400 flex items-center justify-between">
            <span className="flex items-center gap-1">
              <Zap className="w-3 h-3 text-cyan-400" />
              Bitrate
            </span>
          </div>
          <div className="text-base font-mono font-bold text-cyan-300">
            {stats.bitrateKbps > 1000 ? (stats.bitrateKbps / 1000).toFixed(2) : stats.bitrateKbps.toFixed(0)}{' '}
            <span className="text-xs font-normal text-slate-400">
              {stats.bitrateKbps > 1000 ? 'Mbps' : 'Kbps'}
            </span>
          </div>
        </div>

        {/* 4. Packets / Buffer */}
        <div className="p-2.5 bg-[#06070d] rounded-xl border border-slate-800/80 space-y-1">
          <div className="text-[10px] font-mono text-slate-400 flex items-center justify-between">
            <span className="flex items-center gap-1">
              <Layers className="w-3 h-3 text-cyan-400" />
              Channels
            </span>
          </div>
          <div className="text-xs font-mono font-bold text-emerald-400 pt-1">
            UDP: {dataChannelsReady.mouse ? 'UP' : 'DOWN'} • TCP: {dataChannelsReady.events ? 'UP' : 'DOWN'}
          </div>
        </div>
      </div>

      {/* Secondary Metrics Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-[11px] font-mono text-slate-400 border-t border-slate-800/60">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <ArrowUpCircle className="w-3 h-3 text-cyan-400" />
            Sent: {stats.packetsSent.toLocaleString()}
          </span>
          <span className="flex items-center gap-1">
            <ArrowDownCircle className="w-3 h-3 text-emerald-400" />
            Recv: {stats.packetsReceived.toLocaleString()}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <Wifi className="w-3 h-3 text-cyan-400" />
            Signaling: {isSocketConnected ? 'ONLINE' : 'CONNECTING'}
          </span>
          <span className="text-cyan-300">
            {stats.resolution ? `${stats.resolution.width}x${stats.resolution.height}` : resolution}
          </span>
        </div>
      </div>
    </div>
  );
};
