import React from 'react';
import {
  Zap,
  Sparkles,
  Wifi,
  Sliders,
  Monitor,
  Check,
  RefreshCw,
} from 'lucide-react';
import { StreamQualityProfile } from '../types/remoteControl';

export const QUALITY_PROFILES: StreamQualityProfile[] = [
  {
    id: 'performance',
    label: 'Performance (60 FPS)',
    resolution: { width: 1920, height: 1080 },
    targetFps: 60,
    maxBitrateKbps: 6000,
    contentHint: 'motion',
    description: '1080p @ 60 FPS • Low latency priority for fluid motion and fast interaction',
  },
  {
    id: 'clarity',
    label: 'Clarity / Text (Native)',
    resolution: { width: 2560, height: 1440 },
    targetFps: 30,
    maxBitrateKbps: 8500,
    contentHint: 'detail',
    description: 'High resolution @ 30 FPS • Content hint detail for crisp code & text',
  },
  {
    id: 'bandwidth',
    label: 'Low Bandwidth (720p)',
    resolution: { width: 1280, height: 720 },
    targetFps: 24,
    maxBitrateKbps: 1800,
    contentHint: 'motion',
    description: '720p @ 24 FPS • Aggressive bitrate compression for weak connections',
  },
];

interface StreamControlsProps {
  currentProfile: StreamQualityProfile['id'];
  onSelectProfile: (profileId: StreamQualityProfile['id']) => void;
  availableSources?: Array<{ id: string; name: string }>;
  currentSourceId?: string;
  onSwitchSource?: (sourceId: string) => void;
  isHost?: boolean;
  disabled?: boolean;
}

export const StreamControls: React.FC<StreamControlsProps> = ({
  currentProfile,
  onSelectProfile,
  availableSources = [],
  currentSourceId,
  onSwitchSource,
  isHost = false,
  disabled = false,
}) => {
  return (
    <div
      id="stream-controls-panel"
      className="bg-[#090b16]/90 border border-cyan-500/20 rounded-xl p-3.5 shadow-lg backdrop-blur-md space-y-3"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-2 text-xs font-semibold text-slate-300">
          <Sliders className="w-3.5 h-3.5 text-cyan-400" />
          <span>Stream Optimization & Profiles</span>
        </div>
        <span className="font-mono text-[10px] px-2 py-0.5 rounded-full bg-cyan-950/60 border border-cyan-500/20 text-cyan-300">
          RTCRtpSender.replaceTrack()
        </span>
      </div>

      {/* Profile Selector Pills */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {QUALITY_PROFILES.map((profile) => {
          const isSelected = currentProfile === profile.id;
          const Icon =
            profile.id === 'performance' ? Zap : profile.id === 'clarity' ? Sparkles : Wifi;

          return (
            <button
              key={profile.id}
              id={`profile-button-${profile.id}`}
              onClick={() => onSelectProfile(profile.id)}
              disabled={disabled}
              className={`p-2.5 rounded-lg border text-left transition-all duration-150 flex flex-col justify-between ${
                isSelected
                  ? 'bg-cyan-500/15 border-cyan-400 text-cyan-300 shadow-[0_0_12px_rgba(6,182,212,0.25)]'
                  : 'bg-[#0c0f20]/60 border-slate-800/80 text-slate-400 hover:text-slate-200 hover:border-slate-700'
              } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
            >
              <div className="flex items-center justify-between w-full mb-1">
                <div className="flex items-center space-x-1.5 font-medium text-xs">
                  <Icon className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">{profile.label}</span>
                </div>
                {isSelected && <Check className="w-3.5 h-3.5 shrink-0 text-cyan-400" />}
              </div>
              <p className="text-[10px] text-slate-400 leading-tight">
                {profile.description}
              </p>
            </button>
          );
        })}
      </div>

      {/* Host Monitor / Screen Switcher (Dynamic Track Replacement) */}
      {isHost && availableSources.length > 1 && onSwitchSource && (
        <div className="pt-2 border-t border-slate-800/80 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
          <div className="flex items-center space-x-2 text-xs text-slate-300 font-medium">
            <Monitor className="w-3.5 h-3.5 text-cyan-400" />
            <span>Active Display Source:</span>
          </div>

          <div className="flex items-center space-x-1.5 flex-wrap">
            {availableSources.map((source) => (
              <button
                key={source.id}
                id={`source-button-${source.id}`}
                onClick={() => onSwitchSource(source.id)}
                className={`px-2.5 py-1 rounded text-xs font-mono transition-colors flex items-center gap-1 ${
                  currentSourceId === source.id
                    ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-400/40 font-semibold'
                    : 'bg-slate-800/60 text-slate-400 hover:text-slate-200 border border-transparent'
                }`}
              >
                <RefreshCw className="w-3 h-3" />
                <span className="truncate max-w-[120px]">{source.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
