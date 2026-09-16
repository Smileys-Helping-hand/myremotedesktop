import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check,
  Link2,
  Loader2,
  MonitorSmartphone,
  Pencil,
  Plus,
  Radar,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import {
  SavedDevice,
  deleteDevice,
  deviceKey,
  loadDevices,
  parseConnectLink,
  saveDevice,
  sortDevices,
} from '../utils/deviceBook';
import { DiscoveredHost, autofillDeskId, isSharing, scanForHosts } from '../utils/hostDiscovery';
import { getHostSignalUrl } from '../hooks/useWebRTC';
import { useToast } from './ToastSystem';

export interface ConnectTarget {
  deviceId?: string;
  name: string;
  deskId: string;
  addresses: string[];
  pin?: string | null;
}

interface DevicesViewProps {
  /** Starts a session with this device, in the client tab. */
  onConnect: (target: ConnectTarget) => void;
}

/** A blank device, for the add form. */
const emptyDraft = (): SavedDevice => ({
  id: '',
  name: '',
  deskId: '',
  addresses: [],
  pin: '',
});

function relativeTime(seconds?: number | null): string {
  if (!seconds) return 'never connected';
  const delta = Math.max(0, Math.floor(Date.now() / 1000) - seconds);
  if (delta < 60) return 'connected just now';
  if (delta < 3600) return `connected ${Math.floor(delta / 60)} min ago`;
  if (delta < 86400) return `connected ${Math.floor(delta / 3600)} h ago`;
  return `connected ${Math.floor(delta / 86400)} d ago`;
}

/**
 * The device book: machines this operator connects to, by name.
 *
 * This is the tab that makes a session one click. Everything else in the app
 * asks for a Desk ID and a PIN that both change; here they are already saved,
 * against a name the operator chose, and connecting is picking one.
 */
export const DevicesView: React.FC<DevicesViewProps> = ({ onConnect }) => {
  const { showToast } = useToast();

  const [devices, setDevices] = useState<SavedDevice[]>([]);
  const [loading, setLoading] = useState(true);

  const [draft, setDraft] = useState<SavedDevice | null>(null);
  const [linkText, setLinkText] = useState('');

  const [scanning, setScanning] = useState(false);
  const [found, setFound] = useState<DiscoveredHost[]>([]);
  const [scanNote, setScanNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setDevices(await loadDevices());
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Addresses already saved, so a scan can mark what is new. */
  const savedAddresses = useMemo(
    () => new Set(devices.flatMap((d) => d.addresses)),
    [devices]
  );

  const persist = async (device: SavedDevice) => {
    const saved = await saveDevice(device);
    setDevices((current) =>
      sortDevices([...current.filter((d) => d.id !== saved.id), saved])
    );
    return saved;
  };

  const handleSaveDraft = async () => {
    if (!draft) return;
    const deskId = draft.deskId.replace(/\s+/g, '').trim();
    if (!deskId) {
      showToast({
        title: 'A Desk ID is needed',
        description: 'Enter the 6-digit Desk ID shown on the machine you want to reach.',
        type: 'warning',
      });
      return;
    }
    const addresses = draft.addresses.map((a) => a.trim()).filter(Boolean);
    const device: SavedDevice = {
      ...draft,
      deskId,
      addresses,
      name: draft.name.trim() || `Desk ${deskId}`,
      pin: draft.pin?.trim() ? draft.pin.trim() : null,
      id: draft.id || deviceKey(deskId, addresses),
    };
    await persist(device);
    setDraft(null);
    showToast({ title: 'Device saved', description: device.name, type: 'success' });
  };

  const handleAddFromLink = () => {
    const parsed = parseConnectLink(linkText);
    if (!parsed) {
      showToast({
        title: 'That link was not understood',
        description: 'Paste the connect link from the other machine, or "903117@192.168.1.5:4000".',
        type: 'warning',
        duration: 6000,
      });
      return;
    }
    setDraft({ ...parsed, id: deviceKey(parsed.deskId, parsed.addresses), pin: parsed.pin ?? '' });
    setLinkText('');
  };

  const handleForget = async (device: SavedDevice) => {
    await deleteDevice(device.id);
    setDevices((current) => current.filter((d) => d.id !== device.id));
    showToast({ title: 'Device forgotten', description: device.name, type: 'info' });
  };

  const handleConnect = (device: SavedDevice) => {
    if (device.addresses.length === 0) {
      showToast({
        title: 'No address saved',
        description: `${device.name} has a Desk ID but nowhere to reach it. Edit it and add the host address, or scan the network.`,
        type: 'warning',
        duration: 6000,
      });
      return;
    }
    onConnect({
      deviceId: device.id,
      name: device.name,
      deskId: device.deskId,
      addresses: device.addresses,
      pin: device.pin,
    });
  };

  const handleScan = async () => {
    setScanning(true);
    setFound([]);
    setScanNote(null);
    try {
      const { hosts, scanned, networks } = await scanForHosts({
        selfOrigin: getHostSignalUrl(),
        onHost: (host) => setFound((current) => [...current, host]),
      });
      const sharing = hosts.filter(isSharing);
      if (hosts.length === 0) {
        setScanNote(
          scanned === 0
            ? 'This machine reported no network address, so there was nothing to scan.'
            : `Nothing answered on ${networks.join(', ') || 'this network'} (${scanned} addresses checked). Check the other machine is running RemoteDesk and is on the same Wi-Fi.`
        );
      } else if (sharing.length === 0) {
        setScanNote(
          `Found ${hosts.length} machine(s) running RemoteDesk, none sharing a screen yet. Start sharing there, then scan again.`
        );
      }
    } catch (error) {
      setScanNote(`Scan failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setScanning(false);
    }
  };

  const handleSaveFound = async (host: DiscoveredHost) => {
    const deskId = autofillDeskId(host) ?? '';
    const hostname = host.origin.replace(/^https?:\/\//, '');
    setDraft({
      id: deviceKey(deskId, [host.origin]),
      name: hostname,
      deskId,
      addresses: [host.origin],
      pin: '',
    });
  };

  return (
    <div className="space-y-6">
      {/* Header + actions */}
      <div className="bg-[#0c0e18]/95 border border-cyan-500/20 rounded-2xl p-5 shadow-xl backdrop-blur-xl">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-2xl font-extrabold text-white flex items-center gap-2.5">
              <MonitorSmartphone className="w-6 h-6 text-cyan-400" />
              My Devices
            </h2>
            <p className="text-sm text-slate-400 mt-1">
              Saved machines connect in one click — no Desk ID to type, no PIN to read off another
              screen.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleScan}
              disabled={scanning}
              className="px-3.5 py-2 rounded-xl bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/30 text-cyan-300 text-xs font-bold font-mono flex items-center gap-1.5 transition-colors disabled:opacity-50"
            >
              {scanning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Radar className="w-3.5 h-3.5" />}
              {scanning ? 'Scanning…' : 'Find On My Network'}
            </button>
            <button
              type="button"
              onClick={() => setDraft(emptyDraft())}
              className="px-3.5 py-2 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 text-slate-950 text-xs font-extrabold font-mono flex items-center gap-1.5 shadow-[0_0_20px_rgba(6,182,212,0.35)]"
            >
              <Plus className="w-3.5 h-3.5" />
              Add Device
            </button>
          </div>
        </div>

        {/* Paste a connect link */}
        <div className="mt-4 pt-4 border-t border-cyan-500/15 flex flex-wrap items-center gap-2">
          <span className="text-xs font-mono text-slate-300 flex items-center gap-1.5">
            <Link2 className="w-3.5 h-3.5 text-cyan-400" />
            Paste a connect link:
          </span>
          <input
            type="text"
            value={linkText}
            onChange={(e) => setLinkText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAddFromLink();
            }}
            placeholder="http://192.168.1.5:4000/#connect?desk=903117…  or  903117@192.168.1.5:4000"
            className="flex-1 min-w-64 bg-[#07080f] border border-cyan-500/30 rounded-lg px-3 py-1.5 text-cyan-200 text-xs focus:outline-none focus:border-cyan-400"
          />
          <button
            type="button"
            onClick={handleAddFromLink}
            className="px-3 py-1.5 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/30 text-cyan-300 text-xs font-bold font-mono"
          >
            Add
          </button>
        </div>
      </div>

      {/* Scan results */}
      {(found.length > 0 || scanNote) && (
        <div className="bg-[#0c0e18]/95 border border-cyan-500/20 rounded-2xl p-5 space-y-2.5">
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <Radar className="w-4 h-4 text-cyan-400" />
            Found On This Network
          </h3>
          {found.map((host) => {
            const deskId = autofillDeskId(host);
            const known = savedAddresses.has(host.origin);
            return (
              <div
                key={host.origin}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-cyan-500/15 bg-[#07080f] px-3.5 py-2.5"
              >
                <div className="min-w-0">
                  <div className="font-mono text-xs text-cyan-200">{host.origin}</div>
                  <div className="text-[11px] text-slate-400 font-mono">
                    {isSharing(host)
                      ? deskId
                        ? `Sharing Desk ID ${deskId}`
                        : 'Sharing — read the Desk ID off that machine'
                      : 'Running RemoteDesk, not sharing yet'}
                    {known && ' · already saved'}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleSaveFound(host)}
                  className="px-3 py-1.5 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/30 text-cyan-300 text-[11px] font-bold font-mono flex items-center gap-1.5"
                >
                  <Plus className="w-3 h-3" />
                  Save As Device
                </button>
              </div>
            );
          })}
          {scanNote && <p className="text-[11px] text-slate-400 font-mono leading-relaxed">{scanNote}</p>}
        </div>
      )}

      {/* Add / edit form */}
      {draft && (
        <div className="bg-[#0c0e18]/95 border border-cyan-400/40 rounded-2xl p-5 space-y-3 shadow-[0_0_30px_rgba(6,182,212,0.12)]">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-white">
              {devices.some((d) => d.id === draft.id) ? 'Edit device' : 'New device'}
            </h3>
            <button
              type="button"
              onClick={() => setDraft(null)}
              className="text-slate-500 hover:text-slate-300"
              aria-label="Cancel"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-[11px] font-mono text-slate-400 space-y-1">
              <span>Name</span>
              <input
                type="text"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="Linux laptop"
                className="w-full bg-[#07080f] border border-cyan-500/30 rounded-lg px-3 py-2 text-cyan-100 text-sm focus:outline-none focus:border-cyan-400"
              />
            </label>
            <label className="text-[11px] font-mono text-slate-400 space-y-1">
              <span>Desk ID</span>
              <input
                type="text"
                value={draft.deskId}
                onChange={(e) => setDraft({ ...draft, deskId: e.target.value })}
                placeholder="903117"
                className="w-full bg-[#07080f] border border-cyan-500/30 rounded-lg px-3 py-2 text-cyan-100 text-sm font-mono focus:outline-none focus:border-cyan-400"
              />
            </label>
            <label className="text-[11px] font-mono text-slate-400 space-y-1 sm:col-span-2">
              <span>Addresses — one per line, LAN first, public tunnel last</span>
              <textarea
                rows={2}
                value={draft.addresses.join('\n')}
                onChange={(e) => setDraft({ ...draft, addresses: e.target.value.split('\n') })}
                placeholder={'http://192.168.1.5:4000\nhttps://something.trycloudflare.com'}
                className="w-full bg-[#07080f] border border-cyan-500/30 rounded-lg px-3 py-2 text-cyan-100 text-xs font-mono focus:outline-none focus:border-cyan-400"
              />
            </label>
            <label className="text-[11px] font-mono text-slate-400 space-y-1 sm:col-span-2">
              <span>PIN / password — saved on this machine so you do not retype it</span>
              <input
                type="text"
                value={draft.pin ?? ''}
                onChange={(e) => setDraft({ ...draft, pin: e.target.value })}
                placeholder="Leave blank if the host asks you each time"
                className="w-full bg-[#07080f] border border-cyan-500/30 rounded-lg px-3 py-2 text-cyan-100 text-sm font-mono focus:outline-none focus:border-cyan-400"
              />
            </label>
          </div>

          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={handleSaveDraft}
              className="px-4 py-2 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 text-slate-950 text-xs font-extrabold font-mono flex items-center gap-1.5"
            >
              <Check className="w-3.5 h-3.5" />
              Save Device
            </button>
            <span className="text-[11px] text-slate-500 font-mono">
              Stored on this machine only. A saved PIN is kept in plain text in the app&apos;s data
              folder.
            </span>
          </div>
        </div>
      )}

      {/* The book */}
      {loading ? (
        <div className="flex items-center gap-2 text-slate-400 text-sm py-10 justify-center">
          <Loader2 className="w-4 h-4 animate-spin text-cyan-400" />
          Loading saved devices…
        </div>
      ) : devices.length === 0 ? (
        <div className="bg-[#0c0e18]/95 border border-cyan-500/15 rounded-2xl p-10 text-center space-y-2">
          <MonitorSmartphone className="w-10 h-10 text-cyan-500/40 mx-auto" />
          <p className="text-slate-300 font-semibold">No devices saved yet</p>
          <p className="text-sm text-slate-500 max-w-lg mx-auto">
            Use <span className="text-cyan-300 font-mono">Find On My Network</span> to pick up
            machines on this Wi-Fi, or paste the connect link from the other machine&apos;s Host tab.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {devices.map((device) => (
            <div
              key={device.id}
              onDoubleClick={() => handleConnect(device)}
              className="group bg-[#0c0e18]/95 border border-cyan-500/20 hover:border-cyan-400/50 rounded-2xl p-4 transition-colors cursor-pointer"
              title="Double-click to connect"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-base font-bold text-white truncate">{device.name}</h3>
                  <p className="text-[11px] font-mono text-slate-400 mt-0.5">
                    Desk {device.deskId || '—'} · {relativeTime(device.lastConnected)}
                  </p>
                  <p className="text-[11px] font-mono text-slate-500 truncate mt-0.5">
                    {device.addresses[0] ?? 'no address saved'}
                    {device.addresses.length > 1 && ` +${device.addresses.length - 1}`}
                  </p>
                </div>
                {device.pin ? (
                  <span className="shrink-0 px-2 py-0.5 rounded-full bg-emerald-950/60 border border-emerald-500/40 text-emerald-300 text-[10px] font-bold font-mono">
                    PIN SAVED
                  </span>
                ) : null}
              </div>

              <div className="flex items-center gap-2 mt-3">
                <button
                  type="button"
                  onClick={() => handleConnect(device)}
                  className="flex-1 px-3 py-2 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 text-slate-950 text-xs font-extrabold font-mono flex items-center justify-center gap-1.5 shadow-[0_0_18px_rgba(6,182,212,0.3)]"
                >
                  <Zap className="w-3.5 h-3.5 fill-current" />
                  Connect
                </button>
                <button
                  type="button"
                  onClick={() => setDraft({ ...device, pin: device.pin ?? '' })}
                  className="p-2 rounded-xl bg-[#07080f] border border-cyan-500/25 text-slate-400 hover:text-cyan-300"
                  aria-label={`Edit ${device.name}`}
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => handleForget(device)}
                  className="p-2 rounded-xl bg-[#07080f] border border-rose-500/25 text-slate-400 hover:text-rose-300"
                  aria-label={`Forget ${device.name}`}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
