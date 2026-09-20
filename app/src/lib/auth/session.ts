/**
 * Who is signed in, and what that entitles them to.
 *
 * The important part of this file is `Capability`. Arclis has three tiers of
 * access and they are genuinely different, so they are modelled rather than
 * inferred from `address !== null`:
 *
 *   - **Anonymous.** Browse markets, and use the whole registry. This is not a
 *     degraded state, it is the intended one for most visitors, and the
 *     interface never nags it.
 *   - **Watching.** A signed-in account with no signing ability yet, or a
 *     locked one. Can hold a watchlist; cannot move money.
 *   - **Trading.** A connected wallet, or an unlocked passkey account. Can
 *     sign.
 *
 * Deriving that from a nullable address is how "connect your wallet to read
 * this page" happens, and this product's central claim is that you should not
 * have to.
 */

import { loadAccount, type StoredAccount } from "./passkey";

export type AuthMethod = "none" | "wallet" | "passkey";
export type Capability = "anonymous" | "watching" | "trading";

export interface Session {
  method: AuthMethod;
  address: string | null;
  /** Wallet name, or the passkey account's label. */
  label: string | null;
  capability: Capability;
  /** Present only while a passkey account is unlocked. */
  sign: ((message: Uint8Array) => Promise<Uint8Array>) | null;
}

export const ANONYMOUS: Session = {
  method: "none",
  address: null,
  label: null,
  capability: "anonymous",
  sign: null,
};

export function walletSession(address: string, walletName: string): Session {
  return {
    method: "wallet",
    address,
    label: walletName,
    capability: "trading",
    sign: null,
  };
}

export function passkeySession(
  account: StoredAccount,
  sign: ((message: Uint8Array) => Promise<Uint8Array>) | null,
): Session {
  return {
    method: "passkey",
    address: account.address,
    label: "Passkey account",
    // A stored account the user has not unlocked this session can be shown and
    // watched from, but must not appear able to sign.
    capability: sign ? "trading" : "watching",
    sign,
  };
}

/**
 * The session to start with on a cold load.
 *
 * A stored passkey account restores as `watching`, never as `trading`: the
 * wrapped key is on the device but nobody has proved they are the person who
 * can unwrap it. Unlocking happens when something actually needs a signature.
 */
export function restoreSession(): Session {
  const account = loadAccount();
  return account ? passkeySession(account, null) : ANONYMOUS;
}

export function canTrade(session: Session): boolean {
  return session.capability === "trading";
}
