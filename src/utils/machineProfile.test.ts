import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MachineProfile,
  loadProfile,
  registrationSecret,
  setProfileOrigin,
  updateProfile,
} from './machineProfile';

beforeEach(() => {
  localStorage.clear();
  setProfileOrigin(null);
});

describe('the identity a page keeps for itself', () => {
  it('issues a Desk ID once and keeps it', async () => {
    // The whole point: a saved device, a shared link and a bookmark all name
    // this ID, so a second visit must not mint a new one.
    const first = await loadProfile();
    const second = await loadProfile();
    expect(first.deskId).toMatch(/^\d{6}$/);
    expect(second.deskId).toBe(first.deskId);
  });

  it('starts by asking, so a fresh install is not an open desk', async () => {
    const profile = await loadProfile();
    expect(profile.accessMode).toBe('ask');
    expect(profile.accessPassword).toBeNull();
  });

  it('keeps the Desk ID across a change of name or access rule', async () => {
    const before = await loadProfile();
    await updateProfile({ name: 'Studio PC', accessMode: 'open' });
    const after = await loadProfile();
    expect(after.deskId).toBe(before.deskId);
    expect(after.name).toBe('Studio PC');
    expect(after.accessMode).toBe('open');
  });

  it('refuses password access with no password', async () => {
    // Otherwise the room registers with no PIN, which admits everyone — the
    // exact opposite of what choosing a password means.
    await expect(updateProfile({ accessMode: 'password' })).rejects.toThrow(/password/i);
  });
});

describe('the identity the app owns', () => {
  it('prefers the app, so the app window and the browser page agree', async () => {
    const appProfile: MachineProfile = {
      deskId: '903117',
      name: 'Linux laptop',
      accessMode: 'password',
      accessPassword: 'hunter2',
    };
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => appProfile,
    })) as unknown as typeof fetch;

    setProfileOrigin('http://127.0.0.1:4000');
    expect(await loadProfile(fetchImpl)).toEqual(appProfile);
  });

  it('falls back to this browser when no app answers', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    setProfileOrigin('http://127.0.0.1:4000');
    const profile = await loadProfile(fetchImpl);
    expect(profile.deskId).toMatch(/^\d{6}$/);
  });

  it('surfaces the app’s reason for refusing a change', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => 'set a password before choosing password access',
    })) as unknown as typeof fetch;

    setProfileOrigin('http://127.0.0.1:4000');
    await expect(updateProfile({ accessMode: 'password' }, fetchImpl)).rejects.toThrow(
      /set a password/
    );
  });

  it('keeps its own identity when the page is served by something that is not the app', async () => {
    // A standalone relay serves this UI and answers 404 here. That is not a
    // refusal — treating it as one left the operator unable to set a password
    // at all, with an error that named nothing they could fix.
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 404,
      text: async () => 'Cannot POST /profile',
    })) as unknown as typeof fetch;

    setProfileOrigin('http://127.0.0.1:4100');
    const updated = await updateProfile(
      { accessMode: 'password', accessPassword: 'hunter2' },
      fetchImpl
    );
    expect(updated.accessMode).toBe('password');
    expect(updated.accessPassword).toBe('hunter2');
  });
});

describe('registrationSecret', () => {
  const profile = (
    accessMode: MachineProfile['accessMode'],
    accessPassword?: string
  ): MachineProfile => ({
    deskId: '903117',
    name: 'Test',
    accessMode,
    accessPassword: accessPassword ?? null,
  });

  it('registers an open desk with no PIN and no prompt', () => {
    expect(registrationSecret(profile('open'), 'AB12')).toEqual({
      pin: undefined,
      unattended: true,
      requireApproval: false,
    });
  });

  it('registers the fixed password, which is what saved devices present', () => {
    expect(registrationSecret(profile('password', 'hunter2'), 'AB12')).toEqual({
      pin: 'hunter2',
      unattended: false,
      requireApproval: false,
    });
  });

  it('registers the rotating PIN as it stands right now', () => {
    expect(registrationSecret(profile('rotating'), 'AB12').pin).toBe('AB12');
  });

  it('asks by demanding approval rather than by withholding a PIN', () => {
    // A room with no PIN admits everyone, so "ask" cannot be expressed as an
    // empty PIN — it would silently be the most open setting of the four.
    expect(registrationSecret(profile('ask'), 'AB12')).toEqual({
      pin: undefined,
      unattended: false,
      requireApproval: true,
    });
  });
});
