/**
 * The stored account is the only copy of a passkey user's (encrypted) key, so
 * what is read back must be exactly what was written, and anything malformed
 * must read as "no account" rather than a half-account that cannot unlock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetAccount, loadAccount, saveAccount, type StoredAccount } from "./passkey";

const ACCOUNT: StoredAccount = {
  address: "HyEiyg5z2RSvLuTJtmGWgsQeicMRp3Qyu93j4GTSWP5T",
  credentialId: "Y3JlZA==",
  wrappedKey: "d3JhcHBlZA==",
  iv: "aXY=",
  createdAt: 1_790_000_000,
};

let store: Map<string, string>;
beforeEach(() => {
  store = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("the stored passkey account", () => {
  it("reads back exactly what was saved", () => {
    saveAccount(ACCOUNT);
    expect(loadAccount()).toEqual(ACCOUNT);
  });

  it("is gone after forgetting it", () => {
    saveAccount(ACCOUNT);
    forgetAccount();
    expect(loadAccount()).toBeNull();
  });

  it("reads a missing field or corrupt JSON as no account", () => {
    store.set("arclis-account-v1", JSON.stringify({ ...ACCOUNT, iv: "" }));
    expect(loadAccount()).toBeNull();
    store.set("arclis-account-v1", "{not json");
    expect(loadAccount()).toBeNull();
  });

  it("reads as no account when storage itself is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("SecurityError");
      },
    });
    expect(loadAccount()).toBeNull();
  });

  it("refuses to report an account created when it could not be kept", () => {
    // Private browsing, or storage full: the key would exist only in this
    // tab, and anything sent to the address would be lost on reload.
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    expect(() => saveAccount(ACCOUNT)).toThrow(/could not save/i);
  });
});
