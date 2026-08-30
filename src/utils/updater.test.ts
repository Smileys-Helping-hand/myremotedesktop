import { describe, it, expect } from 'vitest';
import { compareVersions, formatProgress } from './updater';

describe('compareVersions', () => {
  it('orders by major, then minor, then patch', () => {
    expect(compareVersions('1.1.0', '1.0.9')).toBeGreaterThan(0);
    expect(compareVersions('2.0.0', '1.99.99')).toBeGreaterThan(0);
    expect(compareVersions('1.0.1', '1.0.2')).toBeLessThan(0);
    expect(compareVersions('1.1.0', '1.1.0')).toBe(0);
  });

  // Release tags and manifest versions are not always spelled the same way.
  it('ignores a leading v and any prerelease or build suffix', () => {
    expect(compareVersions('v1.2.0', '1.2.0')).toBe(0);
    expect(compareVersions('1.2.0-beta.1', '1.2.0')).toBe(0);
    expect(compareVersions('1.2.0+build9', '1.2.0')).toBe(0);
  });

  it('treats missing components as zero rather than failing', () => {
    expect(compareVersions('2', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.1', '1.1.0')).toBe(0);
  });

  // A manifest offering an older build must not read as an upgrade.
  it('reports an older remote version as not newer', () => {
    expect(compareVersions('1.0.0', '1.1.0')).toBeLessThan(0);
  });
});

describe('formatProgress', () => {
  it('shows downloaded, total and percent once the size is known', () => {
    expect(
      formatProgress({ downloaded: 12 * 1024 * 1024, total: 80 * 1024 * 1024, percent: 15 })
    ).toBe('12.0 MB of 80.0 MB (15%)');
  });

  // A server that sends no Content-Length still has to show progress.
  it('falls back to bytes alone when the total is unknown', () => {
    expect(formatProgress({ downloaded: 5 * 1024 * 1024, total: null, percent: null })).toBe(
      '5.0 MB downloaded'
    );
  });

  it('rounds the percentage rather than printing a long float', () => {
    const text = formatProgress({
      downloaded: 1024 * 1024,
      total: 3 * 1024 * 1024,
      percent: 33.3333,
    });
    expect(text).toContain('(33%)');
  });
});
