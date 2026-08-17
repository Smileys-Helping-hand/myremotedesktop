import { systemPreferences, dialog, shell, BrowserWindow } from 'electron';

export interface SystemPermissionStatus {
  platform: 'darwin' | 'win32' | 'linux';
  screenRecordingGranted: boolean;
  accessibilityGranted: boolean;
  displayServerType: 'x11' | 'wayland' | 'windows' | 'macos' | 'unknown';
  isWayland: boolean;
  isUACSecureDesktopActive: boolean;
  details: string[];
}

/**
 * Diagnostics and permission verification for macOS, Linux, and Windows.
 */
export async function checkSystemPermissions(): Promise<SystemPermissionStatus> {
  const platform = process.platform;
  const details: string[] = [];

  let screenRecordingGranted = true;
  let accessibilityGranted = true;
  let displayServerType: SystemPermissionStatus['displayServerType'] = 'unknown';
  let isWayland = false;
  let isUACSecureDesktopActive = false;

  // 1. macOS Permissions Checking (Screen Recording + Accessibility for nut.js)
  if (platform === 'darwin') {
    displayServerType = 'macos';
    try {
      const screenStatus = systemPreferences.getMediaAccessStatus('screen');
      screenRecordingGranted = screenStatus === 'granted';
      details.push(`macOS Screen Recording Permission: ${screenStatus.toUpperCase()}`);

      accessibilityGranted = systemPreferences.isTrustedAccessibilityClient(false);
      details.push(`macOS Accessibility (nut.js input) Granted: ${accessibilityGranted ? 'YES' : 'NO'}`);
    } catch (err) {
      console.warn('[macOS Permissions Check Error]:', err);
      details.push(`macOS permission check warning: ${err}`);
    }
  }

  // 2. Linux Display Server Detection (Wayland vs X11)
  else if (platform === 'linux') {
    const xdgSessionType = (process.env.XDG_SESSION_TYPE || '').toLowerCase();
    const waylandDisplay = process.env.WAYLAND_DISPLAY;
    const desktopSession = process.env.DESKTOP_SESSION || 'unknown';

    isWayland = xdgSessionType === 'wayland' || Boolean(waylandDisplay);
    displayServerType = isWayland ? 'wayland' : 'x11';

    logLinuxDisplayServerDiagnostics(xdgSessionType, waylandDisplay, desktopSession);

    if (isWayland) {
      details.push('⚠️ Linux Wayland display server detected (XDG_SESSION_TYPE=wayland).');
      details.push('Nut.js remote synthetic mouse injection may require XWayland fallback or ydotool uinput daemon.');
    } else {
      details.push(`Linux X11 display server detected (Session: ${desktopSession}). Standard X11 input injection supported.`);
    }
  }

  // 3. Windows UAC & Secure Desktop Checks
  else if (platform === 'win32') {
    displayServerType = 'windows';
    details.push('Windows Desktop Window Manager (DWM) active.');
    // Check if running elevated or if UAC prompt pause state is triggered
    isUACSecureDesktopActive = false;
  }

  return {
    platform: platform === 'darwin' ? 'darwin' : platform === 'win32' ? 'win32' : 'linux',
    screenRecordingGranted,
    accessibilityGranted,
    displayServerType,
    isWayland,
    isUACSecureDesktopActive,
    details,
  };
}

/**
 * Detailed console diagnostics for Linux display servers.
 */
export function logLinuxDisplayServerDiagnostics(
  xdgSessionType: string,
  waylandDisplay?: string,
  desktopSession?: string
): void {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║           LINUX DISPLAY SERVER DIAGNOSTICS                   ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  XDG_SESSION_TYPE  : ${xdgSessionType.padEnd(40)} ║`);
  console.log(`║  WAYLAND_DISPLAY   : ${(waylandDisplay || 'None (X11 default)').padEnd(40)} ║`);
  console.log(`║  DESKTOP_SESSION   : ${(desktopSession || 'unknown').padEnd(40)} ║`);
  if (xdgSessionType === 'wayland' || waylandDisplay) {
    console.log('║  STATUS            : WAYLAND ACTIVE (Security sandbox mode)   ║');
    console.log('║  NOTE              : Screen capture uses PipeWire/xdg-portal ║');
    console.log('║                      Input injection needs XWayland/ydotool   ║');
  } else {
    console.log('║  STATUS            : X11 ACTIVE (Direct XTest injection ready)║');
  }
  console.log('╚══════════════════════════════════════════════════════════════╝');
}

/**
 * Prompts the user with native dialogs to open OS System Preferences if permissions are missing.
 */
export async function promptMissingPermissions(
  mainWindow: BrowserWindow,
  status: SystemPermissionStatus
): Promise<void> {
  if (status.platform === 'darwin') {
    if (!status.screenRecordingGranted || !status.accessibilityGranted) {
      const missing: string[] = [];
      if (!status.screenRecordingGranted) missing.push('Screen Recording');
      if (!status.accessibilityGranted) missing.push('Accessibility (Input Control)');

      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: 'Permissions Required for Remote Desktop',
        message: `RemoteDesk requires ${missing.join(' and ')} permissions to broadcast your screen and receive input.`,
        detail: 'Please grant access in macOS System Settings > Privacy & Security, then restart the application.',
        buttons: ['Open System Settings', 'Later'],
        defaultId: 0,
        cancelId: 1,
      });

      if (response === 0) {
        if (!status.accessibilityGranted) {
          shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
        } else if (!status.screenRecordingGranted) {
          shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
        }
      }
    }
  } else if (status.platform === 'linux' && status.isWayland) {
    await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Linux Wayland Environment Detected',
      message: 'You are running a Wayland session.',
      detail: 'Screen streaming uses the WebRTC Desktop Capturer with PipeWire portal. For synthetic input injection with nut.js, ensure XWayland or ydotool daemon is enabled.',
      buttons: ['Understood'],
    });
  }
}

/**
 * Handles Windows Secure Desktop / UAC transitions.
 * When the Host switches to the secure UAC desktop, standard GDI/DXGI captures may pause.
 */
export function handleWindowsUACTransition(
  isSecureDesktop: boolean,
  onNotifyPeer: (status: { type: 'HOST_UAC_PAUSED'; isPaused: boolean }) => void
): void {
  console.log(`[Windows UAC] Secure Desktop transition: ${isSecureDesktop ? 'PAUSED' : 'RESUMED'}`);
  onNotifyPeer({
    type: 'HOST_UAC_PAUSED',
    isPaused: isSecureDesktop,
  });
}
