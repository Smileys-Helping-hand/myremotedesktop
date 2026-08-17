import { app, BrowserWindow, Menu, Tray, nativeImage } from 'electron';
import path from 'path';

export interface TrayManagerOptions {
  onOpenDashboard?: () => void;
  onStopSharing?: () => void;
  onOpenSettings?: () => void;
  onQuit?: () => void;
  isStreaming?: boolean;
}

let trayInstance: Tray | null = null;
let isQuittingApp = false;

/**
 * Creates and configures the system tray for background persistence.
 * Also attaches window close interception so clicking (X) hides rather than terminates.
 */
export function setupSystemTray(mainWindow: BrowserWindow, options: TrayManagerOptions = {}): Tray {
  if (trayInstance) {
    trayInstance.destroy();
    trayInstance = null;
  }

  // Generate or load high-resolution tray icon
  const iconPath = path.join(__dirname, '../assets/tray-icon.png');
  let icon: any;

  try {
    icon = nativeImage.createFromPath(iconPath);
    if (!icon || (typeof icon.isEmpty === 'function' && icon.isEmpty())) {
      // Create fallback 16x16 icon from data URL
      icon = nativeImage.createFromDataURL(
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMUlEQVR42mNk+M9QzwAFjAy0AcxQz8BExUCMWqDhGEYNDEcDAFqjBhy+s1Kjho+aQBsAwlEG+aUq56UAAAAASUVORK5CYII='
      );
    }
  } catch (err) {
    icon = nativeImage.createEmpty();
  }

  // Create native Tray instance
  trayInstance = new Tray(icon);
  trayInstance.setToolTip('RemoteDesk — Low-Latency Remote Desktop');

  // Intercept the window 'close' event for background persistence
  mainWindow.on('close', (event) => {
    if (!isQuittingApp) {
      event.preventDefault();
      mainWindow.hide();
      console.log('[Tray] Window minimized to system tray. WebRTC connections stay active.');
    }
  });

  const buildContextMenu = () => {
    const isStreaming = options.isStreaming ?? false;

    return Menu.buildFromTemplate([
      {
        label: 'RemoteDesk v1.0 (Phase 4)',
        enabled: false,
      },
      { type: 'separator' },
      {
        label: 'Open Dashboard',
        click: () => {
          mainWindow.show();
          mainWindow.focus();
          if (options.onOpenDashboard) options.onOpenDashboard();
        },
      },
      {
        label: isStreaming ? '● Stop Active Stream' : '○ Standby (Not Streaming)',
        enabled: isStreaming,
        click: () => {
          if (options.onStopSharing) {
            options.onStopSharing();
          }
          mainWindow.webContents.send('tray-action', { action: 'stop-sharing' });
        },
      },
      {
        label: 'Settings...',
        click: () => {
          mainWindow.show();
          mainWindow.focus();
          mainWindow.webContents.send('tray-action', { action: 'open-settings' });
          if (options.onOpenSettings) options.onOpenSettings();
        },
      },
      { type: 'separator' },
      {
        label: 'Quit RemoteDesk',
        accelerator: process.platform === 'darwin' ? 'Command+Q' : 'Ctrl+Q',
        click: () => {
          isQuittingApp = true;
          if (options.onQuit) options.onQuit();
          app.quit();
        },
      },
    ]);
  };

  trayInstance.setContextMenu(buildContextMenu());

  // Left-click on tray icon toggles window visibility (Windows/Linux convention)
  trayInstance.on('click', () => {
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  return trayInstance;
}

/**
 * Updates dynamic tray state (e.g. when streaming starts or stops)
 */
export function updateTrayStreamingState(mainWindow: BrowserWindow, isStreaming: boolean): void {
  if (!trayInstance) return;
  setupSystemTray(mainWindow, { isStreaming });
}

/**
 * Cleanly destroys the tray icon when the application is shutting down.
 */
export function destroySystemTray(): void {
  if (trayInstance) {
    trayInstance.destroy();
    trayInstance = null;
  }
}
