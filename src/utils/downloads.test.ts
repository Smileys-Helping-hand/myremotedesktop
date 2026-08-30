import { describe, it, expect } from 'vitest';
import {
  classifyInstaller,
  describeInstaller,
  formatBytes,
  guessVisitorPlatform,
  sortAssets,
  versionFromFilename,
  type InstallerAsset,
} from './downloads';

function asset(file: string, sizeBytes = 1000): InstallerAsset {
  const { platform, kind } = classifyInstaller(file);
  return { file, platform, kind, sizeBytes, url: `/download/${file}` };
}

describe('classifyInstaller', () => {
  // These are the real filenames the bundler produces today.
  it('classifies every packaged format by extension', () => {
    expect(classifyInstaller('RemoteDesk_1.1.0_x64-setup.exe')).toEqual({
      platform: 'windows',
      kind: 'exe',
    });
    expect(classifyInstaller('RemoteDesk_1.1.0_amd64.deb')).toEqual({
      platform: 'linux',
      kind: 'deb',
    });
    expect(classifyInstaller('RemoteDesk-1.1.0-1.x86_64.rpm')).toEqual({
      platform: 'linux',
      kind: 'rpm',
    });
    expect(classifyInstaller('RemoteDesk_1.1.0_amd64.AppImage')).toEqual({
      platform: 'linux',
      kind: 'appimage',
    });
    expect(classifyInstaller('RemoteDesk_1.1.0.dmg')).toEqual({ platform: 'macos', kind: 'dmg' });
  });

  // The bundler writes `.AppImage`, servers and users may write `.appimage`.
  it('is case-insensitive about the extension', () => {
    expect(classifyInstaller('X.APPIMAGE').kind).toBe('appimage');
    expect(classifyInstaller('X.Exe').kind).toBe('exe');
  });
});

describe('versionFromFilename', () => {
  it('finds the version wherever the bundler put it', () => {
    expect(versionFromFilename('RemoteDesk_1.1.0_x64-setup.exe')).toBe('1.1.0');
    expect(versionFromFilename('RemoteDesk-1.1.0-1.x86_64.rpm')).toBe('1.1.0');
    expect(versionFromFilename('RemoteDesk_10.20.30_amd64.AppImage')).toBe('10.20.30');
  });

  it('returns null rather than guessing at an incomplete version', () => {
    expect(versionFromFilename('RemoteDesk-setup.exe')).toBeNull();
    expect(versionFromFilename('RemoteDesk_1.1_amd64.deb')).toBeNull();
  });
});

describe('describeInstaller', () => {
  // The distinction the user actually needs: which downloads self-update.
  it('says which formats update themselves and which do not', () => {
    expect(describeInstaller('exe').detail).toContain('Updates itself');
    expect(describeInstaller('appimage').detail).toContain('Updates itself');
    expect(describeInstaller('deb').detail).toContain('package manager');
    expect(describeInstaller('rpm').detail).toContain('package manager');
  });
});

describe('formatBytes', () => {
  it('scales to a readable unit', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3_736_034)).toBe('3.6 MB');
    expect(formatBytes(81_451_512)).toBe('77.7 MB'); // the real AppImage size
  });

  it('drops the decimal only once the number is wide', () => {
    expect(formatBytes(99 * 1024 * 1024)).toBe('99.0 MB');
    expect(formatBytes(100 * 1024 * 1024)).toBe('100 MB');
  });

  it('returns an empty string for nonsense rather than NaN', () => {
    expect(formatBytes(Number.NaN)).toBe('');
    expect(formatBytes(-5)).toBe('');
  });
});

describe('guessVisitorPlatform', () => {
  it('recognises the desktop platforms', () => {
    expect(guessVisitorPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows');
    expect(guessVisitorPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('macos');
    expect(guessVisitorPlatform('Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux');
  });

  // Android's UA contains "Linux", but neither desktop build runs there, so
  // highlighting one as "your system" would be actively misleading.
  it('does not offer a Linux desktop build to an Android phone', () => {
    expect(
      guessVisitorPlatform('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36')
    ).toBeNull();
  });

  it('returns null when it cannot tell', () => {
    expect(guessVisitorPlatform('')).toBeNull();
    expect(guessVisitorPlatform('some-crawler/1.0')).toBeNull();
  });
});

describe('sortAssets', () => {
  const all = [
    asset('RemoteDesk-1.1.0-1.x86_64.rpm'),
    asset('RemoteDesk_1.1.0_amd64.deb'),
    asset('RemoteDesk_1.1.0_x64-setup.exe'),
    asset('RemoteDesk_1.1.0_amd64.AppImage'),
  ];

  it('puts the visitor’s own platform first', () => {
    expect(sortAssets(all, 'windows')[0].kind).toBe('exe');
    // AppImage outranks deb and rpm: it is the one Linux build that self-updates.
    expect(sortAssets(all, 'linux')[0].kind).toBe('appimage');
  });

  it('keeps every asset available regardless of platform', () => {
    expect(sortAssets(all, 'windows')).toHaveLength(all.length);
  });

  it('is deterministic when no platform is preferred', () => {
    const a = sortAssets(all, null).map((x) => x.file);
    const b = sortAssets([...all].reverse(), null).map((x) => x.file);
    expect(a).toEqual(b);
  });
});
