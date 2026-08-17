import React from 'react';
import { Monitor, Cpu, Shield, Code, Layers, Radio, MousePointer } from 'lucide-react';

export type ActiveTab = 'host' | 'client' | 'sandbox' | 'protocol' | 'blueprints' | 'security';

interface HeaderProps {
  activeTab: ActiveTab;
  setActiveTab: (tab: ActiveTab) => void;
}

export const Header: React.FC<HeaderProps> = ({ activeTab, setActiveTab }) => {
  const tabs = [
    {
      id: 'host' as ActiveTab,
      label: 'Host (Broadcaster)',
      icon: Radio,
      badge: 'Phase 2',
    },
    {
      id: 'client' as ActiveTab,
      label: 'Client (Remote Control)',
      icon: MousePointer,
      badge: 'Phase 2',
    },
    {
      id: 'sandbox' as ActiveTab,
      label: 'Coordinate Engine',
      icon: Monitor,
      badge: 'Sandbox',
    },
    {
      id: 'protocol' as ActiveTab,
      label: 'RTCDataChannel',
      icon: Cpu,
      badge: 'Dual-CH',
    },
    {
      id: 'security' as ActiveTab,
      label: 'Kill-Switch Guard',
      icon: Shield,
      badge: 'Zero-Trust',
    },
    {
      id: 'blueprints' as ActiveTab,
      label: 'Code Architecture',
      icon: Code,
      badge: '6 Files',
    },
  ];

  return (
    <header className="border-b border-cyan-500/15 bg-[#07080d]/80 backdrop-blur-xl text-slate-100 sticky top-0 z-50 shadow-[0_4px_30px_rgba(0,0,0,0.5)]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Brand */}
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-400 via-blue-600 to-indigo-600 flex items-center justify-center shadow-lg shadow-cyan-500/25 ring-1 ring-cyan-400/40">
              <Layers className="w-5 h-5 text-white" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <span className="font-bold text-lg tracking-tight bg-gradient-to-r from-cyan-300 via-white to-slate-200 bg-clip-text text-transparent">
                  RemoteDesk
                </span>
                <span className="text-[11px] px-2 py-0.5 rounded-full font-mono font-semibold bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">
                  WebRTC + Electron
                </span>
              </div>
              <p className="text-[11px] text-slate-400 font-medium tracking-wide">
                Low-Latency Remote Desktop & Coordinate Engine
              </p>
            </div>
          </div>

          {/* Navigation Pills */}
          <nav className="flex items-center space-x-1 sm:space-x-1.5 bg-[#0d0f17]/90 p-1.5 rounded-xl border border-cyan-500/20 shadow-inner">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  id={`tab-btn-${tab.id}`}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center space-x-2 px-3 py-1.5 rounded-lg text-xs sm:text-sm font-medium transition-all duration-200 ${
                    isActive
                      ? 'bg-gradient-to-r from-cyan-500/25 to-indigo-500/25 text-cyan-200 border border-cyan-400/40 shadow-[0_0_15px_rgba(0,210,255,0.15)]'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40 border border-transparent'
                  }`}
                >
                  <Icon className={`w-4 h-4 ${isActive ? 'text-cyan-400' : 'text-slate-400'}`} />
                  <span className="hidden md:inline">{tab.label}</span>
                  <span className="md:hidden">{tab.label.split(' ')[0]}</span>
                  {tab.badge && (
                    <span
                      className={`text-[10px] px-1.5 py-0.2 rounded font-mono ${
                        isActive
                          ? 'bg-cyan-500/30 text-cyan-200 border border-cyan-400/30'
                          : 'bg-[#151824] text-slate-400 border border-slate-700/50'
                      }`}
                    >
                      {tab.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>
      </div>
    </header>
  );
};
