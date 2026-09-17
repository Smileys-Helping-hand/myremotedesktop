import { describe, it, expect } from 'vitest';
import {
  compareVersions,
  findUpdate,
  formatProgress,
  type AvailableUpdate,
} from './updater';

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

describe('findUpdate', () => {
  const update = (version: string, source: string): AvailableUpdate => ({
    version,
    currentVersion: '1.1.3',
    notes: null,
    publishedAt: null,
    source,
  });

  it('stops at the first source that has something newer', async () => {
    // Nearest first: a machine on this network is faster than the internet and
    // is the only source at all when the connection is down.
    const asked: Array<string | null> = [];
    const { update: found, checked } = await findUpdate(
      ['http://192.168.1.5:4000', 'http://192.168.1.9:4000'],
      true,
      async (source) => {
        asked.push(source);
        return source === 'http://192.168.1.5:4000' ? update('1.1.4', source) : null;
      }
    );

    expect(found?.version).toBe('1.1.4');
    expect(asked).toEqual(['http://192.168.1.5:4000']);
    expect(checked).toEqual(['http://192.168.1.5:4000']);
  });

  it('asks the internet last, and only when the network had nothing', async () => {
    const asked: Array<string | null> = [];
    const { update: found } = await findUpdate(['http://192.168.1.5:4000'], true, async (source) => {
      asked.push(source);
      return source === null ? update('1.1.4', 'the internet') : null;
    });

    expect(asked).toEqual(['http://192.168.1.5:4000', null]);
    expect(found?.source).toBe('the internet');
  });

  it('keeps going when a source is unreachable', async () => {
    // One machine that is asleep must not end the search — that is the normal
    // state of half the devices in the book.
    const { update: found, failures } = await findUpdate(
      ['http://192.168.1.5:4000', 'http://192.168.1.9:4000'],
      false,
      async (source) => {
        if (source === 'http://192.168.1.5:4000') throw new Error('ECONNREFUSED');
        return update('1.1.4', String(source));
      }
    );

    expect(found?.version).toBe('1.1.4');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('192.168.1.5');
  });

  it('reports nothing found rather than throwing when every source fails', async () => {
    const { update: found, failures, checked } = await findUpdate(['http://a:4000'], false, async () => {
      throw new Error('nope');
    });
    expect(found).toBeNull();
    expect(checked).toEqual([]);
    expect(failures).toHaveLength(1);
  });
});
