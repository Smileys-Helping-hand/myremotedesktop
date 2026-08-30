import { describe, it, expect } from 'vitest';
import {
  calculateRemoteCoordinates,
  denormalizeHostCoordinates,
  BoundingBox,
} from './coordinateMath';
import { HostScreenMetadata } from '../types/remoteControl';

describe('coordinateMath', () => {
  const hostMeta: HostScreenMetadata = {
    width: 1920,
    height: 1080,
    devicePixelRatio: 1.0,
  };

  const containerBox: BoundingBox = {
    left: 100,
    top: 50,
    width: 960,
    height: 540,
  };

  it('calculates normalized center coordinates (0.5, 0.5)', () => {
    const clickX = 100 + 480;
    const clickY = 50 + 270;
    const res = calculateRemoteCoordinates(clickX, clickY, containerBox, hostMeta);

    expect(res.normalizedX).toBeCloseTo(0.5, 3);
    expect(res.normalizedY).toBeCloseTo(0.5, 3);
    expect(res.hostLogicalX).toBe(960);
    expect(res.hostLogicalY).toBe(540);
    expect(res.isOutOfBounds).toBe(false);
  });

  it('calculates top-left corner (0.0, 0.0)', () => {
    const res = calculateRemoteCoordinates(100, 50, containerBox, hostMeta);
    expect(res.normalizedX).toBeCloseTo(0.0, 3);
    expect(res.normalizedY).toBeCloseTo(0.0, 3);
    expect(res.hostLogicalX).toBe(0);
    expect(res.hostLogicalY).toBe(0);
    expect(res.isOutOfBounds).toBe(false);
  });

  it('denormalizes coordinates correctly back to host pixels', () => {
    const hostPixel = denormalizeHostCoordinates(0.75, 0.25, hostMeta);
    expect(hostPixel.x).toBe(1440);
    expect(hostPixel.y).toBe(270);
  });

  it('clamps out of bounds coordinates into valid range [0, 1]', () => {
    const res = calculateRemoteCoordinates(0, 0, containerBox, hostMeta);
    expect(res.normalizedX).toBe(0);
    expect(res.normalizedY).toBe(0);
    expect(res.isOutOfBounds).toBe(true);
  });
});
