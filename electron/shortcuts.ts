import { app, BrowserWindow, globalShortcut, dialog } from 'electron';

export interface ShortcutManagerOptions {
  panicKeyCombo?: string;
  onPanicTriggered?: () => void;
}

let isPanicRegistered = false;

/**
 * Registers system-wide global shortcut hotkeys including the Panic Button.
 * When triggered, it forcibly terminates all remote inputs, severs peer connections,
 * brings the Electron window to foreground, and triggers an emergency security alert.
 */
export function registerGlobalShortcuts(
  mainWindow: BrowserWindow,
  options: ShortcutManagerOptions = {}
): boolean {
  // Default: CommandOrControl+Shift+Escape (works across Windows, macOS, Linux)
  const defaultCombo = process.platform === 'darwin' ? 'Command+Shift+Escape' : 'CommandOrControl+Shift+Escape';
  const panicShortcut = options.panicKeyCombo || defaultCombo;

  // Unregister any previous registration
  if (isPanicRegistered) {
    globalShortcut.unregister(panicShortcut);
    isPanicRegistered = false;
  }

  const success = globalShortcut.register(panicShortcut, () => {
    console.warn(`[SECURITY] Panic Button Shortcut triggered (${panicShortcut})!`);

    // 1. Send emergency IPC message to Renderer to tear down WebRTC and lock inputs
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('panic-button-triggered', {
        timestamp: Date.now(),
        reason: 'GLOBAL_PANIC_HOTKEY_PRESSED',
      });

      // 2. Bring window to the foreground immediately
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
      mainWindow.focus();

      // 3. Optional native dialog prompt if needed
      dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: 'Emergency Panic Button Activated',
        message: 'All remote control access has been terminated.',
        detail: 'WebRTC data channels and media streams have been severed. Remote input injection is now locked.',
        buttons: ['Acknowledge'],
      }).catch((err) => {
        console.error('[Panic Dialog Error]:', err);
      });
    }

    // 4. Fire callback if provided
    if (options.onPanicTriggered) {
      options.onPanicTriggered();
    }
  });

  if (!success) {
    console.error(`[Shortcuts] Failed to register global panic shortcut: ${panicShortcut}`);
  } else {
    isPanicRegistered = true;
    console.log(`[Shortcuts] Successfully registered global panic shortcut: ${panicShortcut}`);
  }

  // Ensure clean unregistration on app quit
  app.on('will-quit', () => {
    unregisterGlobalShortcuts();
  });

  return success;
}

/**
 * Cleanly unregisters all global shortcuts to prevent OS-level hotkey conflicts or memory leaks.
 */
export function unregisterGlobalShortcuts(): void {
  globalShortcut.unregisterAll();
  isPanicRegistered = false;
  console.log('[Shortcuts] Unregistered all global shortcuts cleanly.');
}
