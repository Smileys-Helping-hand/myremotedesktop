export interface ElectronDesktopSource {
  id: string;
  name: string;
  thumbnail: string; // data URL or base64
  display_id?: string;
  appIcon?: string | null;
}

export interface ElectronAPI {
  getScreenSources: () => Promise<ElectronDesktopSource[]>;
  sendInputEvent?: (packet: unknown) => Promise<boolean>;
  getDisplayMetadata?: () => Promise<{
    width: number;
    height: number;
    devicePixelRatio: number;
  }>;
  onKillSwitchTriggered?: (callback: (suspended: boolean) => void) => () => void;
  showPermissionDialog?: (clientName: string) => Promise<boolean>;
  readClipboardText?: () => Promise<string>;
  writeClipboardText?: (text: string) => Promise<boolean>;
  saveFile?: (fileName: string, buffer: ArrayBuffer) => Promise<string>;
  // Phase 4 Native Additions
  onPanicTriggered?: (callback: (data: { timestamp: number; reason: string }) => void) => () => void;
  onTrayAction?: (callback: (data: { action: string }) => void) => () => void;
  checkSystemPermissions?: () => Promise<{
    platform: 'darwin' | 'win32' | 'linux';
    screenRecordingGranted: boolean;
    accessibilityGranted: boolean;
    displayServerType: 'x11' | 'wayland' | 'windows' | 'macos' | 'unknown';
    isWayland: boolean;
    isUACSecureDesktopActive: boolean;
    details: string[];
  }>;
  triggerGlobalPanic?: () => Promise<void>;
  updateTrayStatus?: (isStreaming: boolean) => Promise<void>;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

declare module 'electron' {
  export interface BrowserWindowConstructorOptions {
    width?: number;
    height?: number;
    minWidth?: number;
    minHeight?: number;
    webPreferences?: {
      preload?: string;
      nodeIntegration?: boolean;
      contextIsolation?: boolean;
      [key: string]: any;
    };
    icon?: any;
    show?: boolean;
    frame?: boolean;
    titleBarStyle?: string;
    [key: string]: any;
  }

  export class BrowserWindow {
    constructor(options?: BrowserWindowConstructorOptions);
    loadURL(url: string): Promise<void>;
    loadFile(filePath: string): Promise<void>;
    webContents: {
      send(channel: string, ...args: any[]): void;
      openDevTools(): void;
      [key: string]: any;
    };
    on(event: string, listener: (...args: any[]) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
    show(): void;
    hide(): void;
    focus(): void;
    restore(): void;
    isVisible(): boolean;
    isMinimized(): boolean;
    destroy(): void;
    close(): void;
    [key: string]: any;
  }

  export class Tray {
    constructor(image: any);
    setToolTip(toolTip: string): void;
    setContextMenu(menu: Menu | null): void;
    on(event: string, listener: (...args: any[]) => void): this;
    destroy(): void;
    setImage(image: any): void;
    [key: string]: any;
  }

  export interface MenuItemConstructorOptions {
    label?: string;
    type?: 'normal' | 'separator' | 'submenu' | 'checkbox' | 'radio';
    click?: (menuItem?: any, browserWindow?: BrowserWindow, event?: any) => void;
    enabled?: boolean;
    checked?: boolean;
    icon?: any;
    submenu?: Menu | MenuItemConstructorOptions[];
    [key: string]: any;
  }

  export class Menu {
    static buildFromTemplate(template: MenuItemConstructorOptions[]): Menu;
    static setApplicationMenu(menu: Menu | null): void;
  }

  export namespace globalShortcut {
    export function register(accelerator: string, callback: () => void): boolean;
    export function isRegistered(accelerator: string): boolean;
    export function unregister(accelerator: string): void;
    export function unregisterAll(): void;
  }

  export namespace systemPreferences {
    export function getMediaAccessStatus(mediaType: 'microphone' | 'camera' | 'screen'): 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown';
    export function isTrustedAccessibilityClient(prompt: boolean): boolean;
    export function askForMediaAccess(mediaType: string): Promise<boolean>;
  }

  export namespace dialog {
    export function showMessageBox(browserWindow: BrowserWindow | null, options: any): Promise<{ response: number; checkboxChecked: boolean }>;
    export function showErrorBox(title: string, content: string): void;
  }

  export namespace shell {
    export function openExternal(url: string): Promise<void>;
  }

  export namespace nativeImage {
    export function createFromPath(path: string): any;
    export function createFromDataURL(dataUrl: string): any;
    export function createEmpty(): any;
  }

  export namespace app {
    export function whenReady(): Promise<void>;
    export function on(event: string, listener: (...args: any[]) => void): void;
    export function quit(): void;
    export function exit(code?: number): void;
    export function getAppPath(): string;
    export function getPath(name: string): string;
    export const isPackaged: boolean;
  }

  export namespace ipcMain {
    export function handle(channel: string, listener: (event: any, ...args: any[]) => any): void;
    export function on(channel: string, listener: (event: any, ...args: any[]) => void): void;
    export function removeHandler(channel: string): void;
  }

  export namespace desktopCapturer {
    export function getSources(options: { types: string[]; thumbnailSize?: { width: number; height: number }; fetchWindowIcons?: boolean }): Promise<any[]>;
  }
}

