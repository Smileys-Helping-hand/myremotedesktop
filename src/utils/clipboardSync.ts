import { useState, useEffect, useRef, useCallback } from 'react';
import { ClipboardUpdatePayload } from '../types/remoteControl';

export interface ClipboardSyncOptions {
  enabled?: boolean;
  role: 'host' | 'client';
  onSendClipboardPacket?: (packet: ClipboardUpdatePayload) => boolean | void;
  intervalMs?: number;
}

export function useClipboardSync(options: ClipboardSyncOptions) {
  const { enabled = true, role, onSendClipboardPacket, intervalMs = 1200 } = options;

  const [lastSyncText, setLastSyncText] = useState<string>('');
  const [syncCount, setSyncCount] = useState<number>(0);
  const [lastSyncTime, setLastSyncTime] = useState<string>('');
  const [lastSource, setLastSource] = useState<'local' | 'remote'>('local');

  // Anti-looping cache: stores hashes or strings recently applied from remote to prevent echoing back
  const lastReceivedHashRef = useRef<string>('');
  const lastSentHashRef = useRef<string>('');
  const localSourceIdRef = useRef<string>(`${role}_${Math.random().toString(36).substring(2, 8)}`);
  const isSyncingRef = useRef<boolean>(false);

  // Simple string hash for fast equality comparisons
  const computeHash = (str: string): string => {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash |= 0;
    }
    return `${hash}_${str.length}`;
  };

  // 1. Read local clipboard (via Electron API or browser navigator.clipboard)
  const readLocalClipboard = useCallback(async (): Promise<string | null> => {
    try {
      if (typeof window !== 'undefined' && window.electronAPI?.readClipboardText) {
        return await window.electronAPI.readClipboardText();
      } else if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
        return await navigator.clipboard.readText();
      }
    } catch (err) {
      // Browser permissions might reject unfocused clipboard reads
      return null;
    }
    return null;
  }, []);

  // 2. Write to local clipboard (via Electron API or browser navigator.clipboard)
  const writeLocalClipboard = useCallback(async (text: string): Promise<boolean> => {
    try {
      if (typeof window !== 'undefined' && window.electronAPI?.writeClipboardText) {
        return await window.electronAPI.writeClipboardText(text);
      } else if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (err) {
      console.warn('Failed to write to local clipboard:', err);
      return false;
    }
    return false;
  }, []);

  // 3. Handle incoming remote clipboard packet from WebRTC channel
  const handleRemoteClipboardPacket = useCallback(
    async (packet: ClipboardUpdatePayload) => {
      if (!enabled || !packet.text) return;

      // Ignore our own looped back packets
      if (packet.sourceId === localSourceIdRef.current) return;

      const incomingHash = computeHash(packet.text);
      if (incomingHash === lastSentHashRef.current || incomingHash === lastReceivedHashRef.current) {
        return;
      }

      // Record incoming hash to prevent local watcher from echoing it back
      lastReceivedHashRef.current = incomingHash;
      isSyncingRef.current = true;

      const success = await writeLocalClipboard(packet.text);
      if (success) {
        setLastSyncText(packet.text);
        setSyncCount((prev) => prev + 1);
        setLastSyncTime(new Date().toLocaleTimeString());
        setLastSource('remote');
      }

      setTimeout(() => {
        isSyncingRef.current = false;
      }, 500);
    },
    [enabled, writeLocalClipboard]
  );

  // 4. Polling Watcher for Local Clipboard changes
  useEffect(() => {
    if (!enabled) return;

    const checkLocalClipboard = async () => {
      if (isSyncingRef.current) return;

      const currentText = await readLocalClipboard();
      if (!currentText || currentText.trim().length === 0) return;

      const hash = computeHash(currentText);

      // If text matches last received from remote or last sent, skip
      if (hash === lastReceivedHashRef.current || hash === lastSentHashRef.current) {
        return;
      }

      // New local copy detected! Broadcast to remote peer
      lastSentHashRef.current = hash;
      const packet: ClipboardUpdatePayload = {
        type: 'CLIPBOARD_UPDATE',
        text: currentText,
        sourceId: localSourceIdRef.current,
        timestamp: Date.now(),
      };

      if (onSendClipboardPacket) {
        onSendClipboardPacket(packet);
        setLastSyncText(currentText);
        setSyncCount((prev) => prev + 1);
        setLastSyncTime(new Date().toLocaleTimeString());
        setLastSource('local');
      }
    };

    const intervalId = setInterval(checkLocalClipboard, intervalMs);

    // Also check on window focus
    const handleFocus = () => {
      checkLocalClipboard();
    };
    window.addEventListener('focus', handleFocus);

    return () => {
      clearInterval(intervalId);
      window.removeEventListener('focus', handleFocus);
    };
  }, [enabled, intervalMs, onSendClipboardPacket, readLocalClipboard]);

  // 5. Manual trigger to send text
  const manualSyncText = useCallback(
    async (text: string) => {
      if (!text) return;
      const hash = computeHash(text);
      lastSentHashRef.current = hash;

      const packet: ClipboardUpdatePayload = {
        type: 'CLIPBOARD_UPDATE',
        text,
        sourceId: localSourceIdRef.current,
        timestamp: Date.now(),
      };

      if (onSendClipboardPacket) {
        onSendClipboardPacket(packet);
        await writeLocalClipboard(text);
        setLastSyncText(text);
        setSyncCount((prev) => prev + 1);
        setLastSyncTime(new Date().toLocaleTimeString());
        setLastSource('local');
      }
    },
    [onSendClipboardPacket, writeLocalClipboard]
  );

  return {
    lastSyncText,
    syncCount,
    lastSyncTime,
    lastSource,
    handleRemoteClipboardPacket,
    manualSyncText,
  };
}
