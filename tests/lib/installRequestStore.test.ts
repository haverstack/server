import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { dirname } from 'node:path';
import { rm } from 'node:fs/promises';
import type { AppManifest } from '@haverstack/core';
import { InstallRequestStore } from '../../src/lib/installRequestStore.js';
import { tempDbPath } from '../setup.js';

const MANIFEST: AppManifest = {
  appId: 'com.example.notes',
  name: 'Notes',
  types: [],
  requests: [],
};

describe('InstallRequestStore', () => {
  let path: string;
  let store: InstallRequestStore;
  beforeEach(() => {
    path = tempDbPath();
    store = InstallRequestStore.open(`${path}.installs`);
  });
  afterEach(async () => {
    vi.useRealTimers();
    store.close();
    await rm(dirname(path), { recursive: true, force: true });
  });

  it('survives a reopen', () => {
    const { id } = store.put('did:key:a', MANIFEST);
    store.close();
    store = InstallRequestStore.open(`${path}.installs`);
    expect(store.get(id)?.manifest).toEqual(MANIFEST);
  });

  it('forgets a request no one re-sends, and keeps one that is', () => {
    vi.useFakeTimers();
    const kept = store.put('did:key:a', MANIFEST);
    const dropped = store.put('did:key:b', MANIFEST);
    vi.advanceTimersByTime(6 * 24 * 60 * 60 * 1000);
    store.put('did:key:a', MANIFEST);
    vi.advanceTimersByTime(2 * 24 * 60 * 60 * 1000);
    expect(store.get(kept.id)).not.toBeNull();
    expect(store.get(dropped.id)).toBeNull();
    expect(store.list().map((r) => r.did)).toEqual(['did:key:a']);
  });
});
