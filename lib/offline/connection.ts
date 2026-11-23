"use client";

import { useSyncExternalStore } from "react";

/**
 * Whether the app can reach its server. navigator.onLine only says there is a network card connected, so on Wi-Fi with
 * no internet it stays true; the probe in components/offline/offline-support.tsx sets this from a real request.
 */
let offline = false;
const listeners = new Set<() => void>();

export function setOffline(value: boolean) {
  if (offline === value) return;
  offline = value;
  listeners.forEach((l) => l());
}

export function isOffline(): boolean {
  return offline;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useOffline(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => offline,
    () => false,
  );
}
