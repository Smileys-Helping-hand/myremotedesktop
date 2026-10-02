import {
  GamepadButtonState,
  GamepadStatePayload,
  Player2KeymapConfig,
  X360Report,
} from '../types/remoteControl';
import { tauriInjectKey } from './tauriBridge';

export const DEFAULT_PLAYER2_KEYMAP: Player2KeymapConfig = {
  up: 'Numpad8',
  down: 'Numpad2',
  left: 'Numpad4',
  right: 'Numpad6',
  a: 'Numpad1',
  b: 'Numpad3',
  x: 'Numpad7',
  y: 'Numpad9',
  lb: 'NumpadDivide',
  rb: 'NumpadMultiply',
  lt: 'NumpadSubtract',
  rt: 'NumpadAdd',
  select: 'KeyN',
  start: 'KeyM',
};

export const ARCADE_PLAYER2_KEYMAP: Player2KeymapConfig = {
  up: 'KeyI',
  down: 'KeyK',
  left: 'KeyJ',
  right: 'KeyL',
  a: 'KeyU',
  b: 'KeyO',
  x: 'KeyY',
  y: 'KeyH',
  lb: 'KeyQ',
  rb: 'KeyE',
  lt: 'Digit1',
  rt: 'Digit2',
  select: 'Digit8',
  start: 'Digit9',
};

/**
 * Standard button names matching the W3C standard gamepad mapping.
 */
export const GAMEPAD_BUTTON_NAMES = [
  'A / Cross',
  'B / Circle',
  'X / Square',
  'Y / Triangle',
  'LB / L1',
  'RB / R1',
  'LT / L2',
  'RT / R2',
  'Select / Back',
  'Start / Menu',
  'L3 (Left Stick)',
  'R3 (Right Stick)',
  'D-Pad Up',
  'D-Pad Down',
  'D-Pad Left',
  'D-Pad Right',
  'Guide / Home',
];

/**
 * Client-side Gamepad Input Poller.
 * Polls navigator.getGamepads() on requestAnimationFrame, performs deadzone
 * compensation, delta checks, and forwards states over WebRTC without flooding.
 */
export class GamepadPoller {
  private rafId: number | null = null;
  private isRunning = false;
  private lastButtons: boolean[] = new Array(17).fill(false);
  private lastAxes: number[] = [0, 0, 0, 0];
  private lastHeartbeat = 0;
  private deadzone = 0.12;
  private playerIndex = 1; // Default to Player 2

  private onStateChange: (state: GamepadStatePayload) => void;

  constructor(
    onStateChange: (state: GamepadStatePayload) => void,
    playerIndex = 1,
    deadzone = 0.12
  ) {
    this.onStateChange = onStateChange;
    this.playerIndex = playerIndex;
    this.deadzone = deadzone;
  }

  public setPlayerIndex(index: number) {
    this.playerIndex = index;
  }

  public setDeadzone(value: number) {
    this.deadzone = Math.max(0.01, Math.min(0.5, value));
  }

  public start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.pollLoop();
  }

  public stop() {
    this.isRunning = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private applyDeadzone(value: number): number {
    if (Math.abs(value) < this.deadzone) return 0;
    // Rescale output smoothly from 0 to 1
    const sign = Math.sign(value);
    const scaled = (Math.abs(value) - this.deadzone) / (1 - this.deadzone);
    return Number((sign * scaled).toFixed(3));
  }

  private pollLoop = () => {
    if (!this.isRunning) return;

    const gamepads = typeof navigator !== 'undefined' && navigator.getGamepads
      ? navigator.getGamepads()
      : [];

    let activeGp: Gamepad | null = null;
    for (let i = 0; i < gamepads.length; i++) {
      const gp = gamepads[i];
      if (gp && gp.connected) {
        activeGp = gp;
        break;
      }
    }

    if (activeGp) {
      const now = Date.now();
      const currentButtons: GamepadButtonState[] = [];
      let hasButtonChange = false;

      for (let i = 0; i < 17; i++) {
        const btn = activeGp.buttons[i];
        const isPressed = btn ? btn.pressed || btn.value > 0.5 : false;
        const val = btn ? btn.value : 0;
        currentButtons.push({
          pressed: isPressed,
          touched: btn ? btn.touched : false,
          value: Number(val.toFixed(2)),
        });

        if (isPressed !== this.lastButtons[i]) {
          hasButtonChange = true;
          this.lastButtons[i] = isPressed;
        }
      }

      const currentAxes: number[] = [
        this.applyDeadzone(activeGp.axes[0] || 0),
        this.applyDeadzone(activeGp.axes[1] || 0),
        this.applyDeadzone(activeGp.axes[2] || 0),
        this.applyDeadzone(activeGp.axes[3] || 0),
      ];

      let hasAxisChange = false;
      for (let i = 0; i < 4; i++) {
        if (Math.abs(currentAxes[i] - this.lastAxes[i]) > 0.03) {
          hasAxisChange = true;
          this.lastAxes[i] = currentAxes[i];
        }
      }

      const isHeartbeat = now - this.lastHeartbeat > 200; // 5Hz heartbeat to ensure sync

      if (hasButtonChange || hasAxisChange || isHeartbeat) {
        this.lastHeartbeat = now;
        this.onStateChange({
          type: 'GAMEPAD_STATE',
          playerIndex: this.playerIndex,
          id: activeGp.id || 'Standard Gamepad',
          buttons: currentButtons,
          axes: currentAxes,
          timestamp: now,
        });
      }
    }

    this.rafId = requestAnimationFrame(this.pollLoop);
  };
}

/**
 * Host-Side Player 2 Gamepad Dispatcher.
 * Translates incoming GamepadStatePayload into native OS keystrokes mapped for
 * Player 2 co-op gaming.
 *
 * Tracks currently active virtual keys so each transition (press/release) fires
 * exactly once, preventing input queue choking or UI thread stalls.
 */
export class HostPlayer2Dispatcher {
  private keymap: Player2KeymapConfig;
  private activeKeys: Set<string> = new Set();
  private enabled = true;

  constructor(keymap: Player2KeymapConfig = DEFAULT_PLAYER2_KEYMAP) {
    this.keymap = keymap;
  }

  public setKeymap(keymap: Player2KeymapConfig) {
    // Release any old keys before switching keymap
    this.releaseAll();
    this.keymap = keymap;
  }

  public setEnabled(enabled: boolean) {
    if (!enabled) {
      this.releaseAll();
    }
    this.enabled = enabled;
  }

  public async dispatch(packet: GamepadStatePayload): Promise<void> {
    if (!this.enabled) return;

    const desiredKeys = new Set<string>();

    // Left Stick / D-Pad Directions
    const [lx, ly] = packet.axes;
    const upPressed = (packet.buttons[12]?.pressed ?? false) || ly < -0.4;
    const downPressed = (packet.buttons[13]?.pressed ?? false) || ly > 0.4;
    const leftPressed = (packet.buttons[14]?.pressed ?? false) || lx < -0.4;
    const rightPressed = (packet.buttons[15]?.pressed ?? false) || lx > 0.4;

    if (upPressed) desiredKeys.add(this.keymap.up);
    if (downPressed) desiredKeys.add(this.keymap.down);
    if (leftPressed) desiredKeys.add(this.keymap.left);
    if (rightPressed) desiredKeys.add(this.keymap.right);

    // Face buttons: A (0), B (1), X (2), Y (3)
    if (packet.buttons[0]?.pressed) desiredKeys.add(this.keymap.a);
    if (packet.buttons[1]?.pressed) desiredKeys.add(this.keymap.b);
    if (packet.buttons[2]?.pressed) desiredKeys.add(this.keymap.x);
    if (packet.buttons[3]?.pressed) desiredKeys.add(this.keymap.y);

    // Shoulders & Triggers: LB (4), RB (5), LT (6), RT (7)
    if (packet.buttons[4]?.pressed) desiredKeys.add(this.keymap.lb);
    if (packet.buttons[5]?.pressed) desiredKeys.add(this.keymap.rb);
    if (packet.buttons[6]?.pressed || (packet.buttons[6]?.value ?? 0) > 0.4) desiredKeys.add(this.keymap.lt);
    if (packet.buttons[7]?.pressed || (packet.buttons[7]?.value ?? 0) > 0.4) desiredKeys.add(this.keymap.rt);

    // Select (8), Start (9)
    if (packet.buttons[8]?.pressed) desiredKeys.add(this.keymap.select);
    if (packet.buttons[9]?.pressed) desiredKeys.add(this.keymap.start);

    // Diff against currently active keys:
    // 1. Release keys that are no longer pressed
    for (const key of this.activeKeys) {
      if (!desiredKeys.has(key)) {
        await tauriInjectKey(key, false);
        this.activeKeys.delete(key);
      }
    }

    // 2. Press keys that were newly activated
    for (const key of desiredKeys) {
      if (!this.activeKeys.has(key)) {
        await tauriInjectKey(key, true);
        this.activeKeys.add(key);
      }
    }
  }

  public releaseAll() {
    for (const key of this.activeKeys) {
      tauriInjectKey(key, false).catch(() => {});
    }
    this.activeKeys.clear();
  }
}

/**
 * Translates a standard W3C Gamepad state packet (from Linux, Windows, macOS)
 * into an authentic Xbox 360 controller hardware report for the ViGEmBus driver.
 */
export function gamepadStateToX360Report(state: GamepadStatePayload): X360Report {
  let buttons = 0;

  // D-Pad: Up (12), Down (13), Left (14), Right (15)
  if (state.buttons[12]?.pressed) buttons |= 0x0001; // UP
  if (state.buttons[13]?.pressed) buttons |= 0x0002; // DOWN
  if (state.buttons[14]?.pressed) buttons |= 0x0004; // LEFT
  if (state.buttons[15]?.pressed) buttons |= 0x0008; // RIGHT

  // Menu / Select: Start (9), Back/Select (8)
  if (state.buttons[9]?.pressed) buttons |= 0x0010; // START
  if (state.buttons[8]?.pressed) buttons |= 0x0020; // BACK

  // Stick Clicks: L3 (10), R3 (11)
  if (state.buttons[10]?.pressed) buttons |= 0x0040; // LTHUMB
  if (state.buttons[11]?.pressed) buttons |= 0x0080; // RTHUMB

  // Bumpers: LB (4), RB (5)
  if (state.buttons[4]?.pressed) buttons |= 0x0100; // LB
  if (state.buttons[5]?.pressed) buttons |= 0x0200; // RB

  // Guide (16)
  if (state.buttons[16]?.pressed) buttons |= 0x0400; // GUIDE

  // Face Buttons: A (0), B (1), X (2), Y (3)
  if (state.buttons[0]?.pressed) buttons |= 0x1000; // A
  if (state.buttons[1]?.pressed) buttons |= 0x2000; // B
  if (state.buttons[2]?.pressed) buttons |= 0x4000; // X
  if (state.buttons[3]?.pressed) buttons |= 0x8000; // Y

  // Triggers (0..255)
  const leftTriggerVal = state.buttons[6]?.value ?? (state.buttons[6]?.pressed ? 1 : 0);
  const rightTriggerVal = state.buttons[7]?.value ?? (state.buttons[7]?.pressed ? 1 : 0);
  const leftTrigger = Math.max(0, Math.min(255, Math.round(leftTriggerVal * 255)));
  const rightTrigger = Math.max(0, Math.min(255, Math.round(rightTriggerVal * 255)));

  // Analog Sticks (-32768..32767)
  // Note: W3C Gamepad API Y axis is -1.0 for UP, +1.0 for DOWN.
  // XInput thumbstick Y axis is +32767 for UP, -32768 for DOWN (inverted).
  const clampAxis = (val: number | undefined): number => {
    if (val === undefined || isNaN(val)) return 0;
    const clamped = Math.max(-1, Math.min(1, val));
    return Math.round(clamped * 32767);
  };

  const thumbLx = clampAxis(state.axes[0]);
  const thumbLy = clampAxis(-(state.axes[1] ?? 0));
  const thumbRx = clampAxis(state.axes[2]);
  const thumbRy = clampAxis(-(state.axes[3] ?? 0));

  return {
    buttons,
    leftTrigger,
    rightTrigger,
    thumbLx,
    thumbLy,
    thumbRx,
    thumbRy,
  };
}
