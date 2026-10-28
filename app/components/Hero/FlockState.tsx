"use client";

import { createContext, useContext, useRef, useSyncExternalStore, type ReactNode } from "react";

export interface FlockSnapshot {
  /** Turns so far; 0 while the first formation holds. */
  turn: number;
  /** Birds drawn, once the canvas has sized itself (null before). */
  birds: number | null;
}

function createFlockStore() {
  let state: FlockSnapshot = { turn: 0, birds: null };
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(patch: Partial<FlockSnapshot>) {
      state = { ...state, ...patch };
      listeners.forEach((l) => l());
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

type FlockStore = ReturnType<typeof createFlockStore>;

const FlockContext = createContext<FlockStore | null>(null);
const SERVER_SNAPSHOT: FlockSnapshot = { turn: 0, birds: null };

/** Shares the canvas's turn count with the figure caption, without re-rendering the hero each frame. */
export function FlockStateProvider({ children }: { children: ReactNode }) {
  const store = useRef<FlockStore>(null);
  store.current ??= createFlockStore();
  return <FlockContext.Provider value={store.current}>{children}</FlockContext.Provider>;
}

export function useFlockStore(): FlockStore {
  const store = useContext(FlockContext);
  if (!store) throw new Error("useFlockStore needs a FlockStateProvider");
  return store;
}

export function useFlockState(): FlockSnapshot {
  const store = useFlockStore();
  return useSyncExternalStore(store.subscribe, store.get, () => SERVER_SNAPSHOT);
}
