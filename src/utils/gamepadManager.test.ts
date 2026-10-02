import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DEFAULT_PLAYER2_KEYMAP,
  ARCADE_PLAYER2_KEYMAP,
  HostPlayer2Dispatcher,
  gamepadStateToX360Report,
} from './gamepadManager';
import { GamepadStatePayload } from '../types/remoteControl';
import * as tauriBridge from './tauriBridge';

describe('gamepadManager', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('provides complete and distinct Player 2 keymaps', () => {
    expect(DEFAULT_PLAYER2_KEYMAP.up).toBe('Numpad8');
    expect(DEFAULT_PLAYER2_KEYMAP.down).toBe('Numpad2');
    expect(DEFAULT_PLAYER2_KEYMAP.left).toBe('Numpad4');
    expect(DEFAULT_PLAYER2_KEYMAP.right).toBe('Numpad6');
    expect(DEFAULT_PLAYER2_KEYMAP.a).toBe('Numpad1');
    expect(DEFAULT_PLAYER2_KEYMAP.b).toBe('Numpad3');

    expect(ARCADE_PLAYER2_KEYMAP.up).toBe('KeyI');
    expect(ARCADE_PLAYER2_KEYMAP.down).toBe('KeyK');
    expect(ARCADE_PLAYER2_KEYMAP.a).toBe('KeyU');
  });

  it('dispatches key press on edge transition and avoids duplicate calls', async () => {
    const injectSpy = vi.spyOn(tauriBridge, 'tauriInjectKey').mockResolvedValue(true);
    const dispatcher = new HostPlayer2Dispatcher(DEFAULT_PLAYER2_KEYMAP);

    const makePacket = (aPressed: boolean): GamepadStatePayload => ({
      type: 'GAMEPAD_STATE',
      playerIndex: 1,
      id: 'Test Gamepad',
      buttons: new Array(17).fill(null).map((_, i) => ({
        pressed: i === 0 ? aPressed : false,
        value: i === 0 && aPressed ? 1 : 0,
      })),
      axes: [0, 0, 0, 0],
      timestamp: Date.now(),
    });

    // Press A
    await dispatcher.dispatch(makePacket(true));
    expect(injectSpy).toHaveBeenCalledTimes(1);
    expect(injectSpy).toHaveBeenCalledWith('Numpad1', true);

    // Keep pressing A (same state) -> should NOT trigger another injectKey
    await dispatcher.dispatch(makePacket(true));
    expect(injectSpy).toHaveBeenCalledTimes(1);

    // Release A
    await dispatcher.dispatch(makePacket(false));
    expect(injectSpy).toHaveBeenCalledTimes(2);
    expect(injectSpy).toHaveBeenCalledWith('Numpad1', false);
  });

  it('translates analog stick directions into directional keybinds', async () => {
    const injectSpy = vi.spyOn(tauriBridge, 'tauriInjectKey').mockResolvedValue(true);
    const dispatcher = new HostPlayer2Dispatcher(DEFAULT_PLAYER2_KEYMAP);

    const makeStickPacket = (lx: number, ly: number): GamepadStatePayload => ({
      type: 'GAMEPAD_STATE',
      playerIndex: 1,
      id: 'Test Gamepad',
      buttons: new Array(17).fill(null).map(() => ({ pressed: false, value: 0 })),
      axes: [lx, ly, 0, 0],
      timestamp: Date.now(),
    });

    // Push stick up (ly < -0.4)
    await dispatcher.dispatch(makeStickPacket(0, -0.8));
    expect(injectSpy).toHaveBeenCalledWith('Numpad8', true);

    // Push stick right and down (lx > 0.4, ly > 0.4)
    await dispatcher.dispatch(makeStickPacket(0.9, 0.7));
    expect(injectSpy).toHaveBeenCalledWith('Numpad8', false); // up released
    expect(injectSpy).toHaveBeenCalledWith('Numpad2', true); // down pressed
    expect(injectSpy).toHaveBeenCalledWith('Numpad6', true); // right pressed
  });

  it('releases all keys when disabled or releaseAll is called', async () => {
    const injectSpy = vi.spyOn(tauriBridge, 'tauriInjectKey').mockResolvedValue(true);
    const dispatcher = new HostPlayer2Dispatcher(DEFAULT_PLAYER2_KEYMAP);

    // Press A and B
    await dispatcher.dispatch({
      type: 'GAMEPAD_STATE',
      playerIndex: 1,
      id: 'Test Gamepad',
      buttons: new Array(17).fill(null).map((_, i) => ({
        pressed: i === 0 || i === 1,
        value: i === 0 || i === 1 ? 1 : 0,
      })),
      axes: [0, 0, 0, 0],
      timestamp: Date.now(),
    });

    expect(injectSpy).toHaveBeenCalledWith('Numpad1', true);
    expect(injectSpy).toHaveBeenCalledWith('Numpad3', true);

    dispatcher.releaseAll();
    expect(injectSpy).toHaveBeenCalledWith('Numpad1', false);
    expect(injectSpy).toHaveBeenCalledWith('Numpad3', false);
  });

  it('correctly maps GamepadStatePayload to X360Report for ViGEm virtual controller', () => {
    const packet: GamepadStatePayload = {
      type: 'GAMEPAD_STATE',
      playerIndex: 1,
      id: 'Linux DualShock 4',
      buttons: new Array(17).fill(null).map((_, i) => ({
        pressed: i === 0 || i === 12,
        value: i === 6 ? 0.75 : i === 0 ? 1 : 0,
      })),
      axes: [0.5, -0.8, -0.2, 0.4],
      timestamp: Date.now(),
    };

    const report = gamepadStateToX360Report(packet);

    expect(report.buttons & 0x1000).toBe(0x1000); // A button
    expect(report.buttons & 0x0001).toBe(0x0001); // Dpad Up
    expect(report.leftTrigger).toBe(Math.round(0.75 * 255));
    expect(report.rightTrigger).toBe(0);
    expect(report.thumbLx).toBe(Math.round(0.5 * 32767));
    expect(report.thumbLy).toBe(Math.round(0.8 * 32767)); // Inverted
    expect(report.thumbRy).toBe(Math.round(-0.4 * 32767)); // Inverted
  });
});
