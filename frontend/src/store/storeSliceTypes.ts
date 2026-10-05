import type { StoreApi } from "zustand";
import type { AppState } from "./storeStateTypes";

/** `set` / `get` handed to every slice of the root store. */
export type StoreSet = StoreApi<AppState>['setState'];
export type StoreGet = StoreApi<AppState>['getState'];
