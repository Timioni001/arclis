/**
 * The sign-in sheet.
 *
 * Two routes, presented as equals rather than as a primary and a fallback,
 * because they serve genuinely different people: someone arriving from Solana
 * already has a wallet and wants one click, and someone arriving from a stock
 * app has never seen a seed phrase and should not be handed one.
 *
 * What the sheet will not do is open itself. It appears when a person asks to
 * sign in, or when an action needs a signature and explains which action. The
 * registry never triggers it at all.
 */

import { useEffect, useState } from "react";
import {
  checkPasskeySupport,
  createPasskeyAccount,
  loadAccount,
  unlockPasskeyAccount,
  type PasskeySupport,
} from "../../lib/auth/passkey";
import {
  connectWallet,
  startWalletDiscovery,
  type DetectedWallet,
  isMobileBrowser,
  openInWalletLinks,
} from "../../lib/auth/wallet";
import {
  passkeySession,
  walletSession,
  type Session,
} from "../../lib/auth/session";
import { GlassPanel } from "../ui/Glass";
import { Icon } from "../ui";
import { shortAddress } from "../../lib/format";

type Route = "choose" | "passkey" | "wallets";

export function AuthSheet({
  open,
  onClose,
  onSession,
  /** Why the sheet opened, when something specific asked for it. */
  reason,
}: {
  open: boolean;
  onClose: () => void;
  onSession: (session: Session) => void;
  reason?: string;
}) {
  const [route, setRoute] = useState<Route>("choose");
  const [wallets, setWallets] = useState<DetectedWallet[]>([]);
  const [support, setSupport] = useState<PasskeySupport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const existing = loadAccount();

  useEffect(() => {
    if (!open) return;
    setRoute("choose");
    setError(null);
    const stop = startWalletDiscovery(setWallets);
    checkPasskeySupport().then(setSupport);
    return stop;
  }, [open]);

  // Escape closes, and focus is not trapped anywhere the user cannot leave.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function run(work: () => Promise<Session>) {
    setBusy(true);
    setError(null);
    try {
      onSession(await work());
      onClose();
    } catch (e) {
      // A cancelled biometric prompt is a normal thing a person does, not an
      // error to shout about, so it is reported in the same quiet place as a
      // real failure rather than as a toast.
      setError(
        e instanceof Error ? e.message : "That did not work. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sheet-scrim" role="presentation" onClick={onClose}>
      <GlassPanel
        weight="lens"
        radius={28}
        className="auth-sheet"
        innerClassName="auth-inner crisp"
        as="section"
        style={{ pointerEvents: "auto" }}
      >
        <div onClick={(e) => e.stopPropagation()} className="auth-stack">
          <header className="auth-head">
            <div>
              <h2 id="auth-title">Sign in to Arclis</h2>
              <p>
                {reason ??
                  "Browsing markets and the registry needs no account. Signing in is for holding a position."}
              </p>
            </div>
            <button
              className="icon-btn auth-close"
              onClick={onClose}
              aria-label="Close"
            >
              <Icon name="plus" size={18} />
            </button>
          </header>

          {route === "choose" && (
            <div className="auth-routes">
              <button
                className="auth-route"
                onClick={() => setRoute("wallets")}
                disabled={busy}
              >
                <span className="auth-route-icon">
                  <Icon name="wallet" size={20} />
                </span>
                <span className="auth-route-text">
                  <strong>Connect a wallet</strong>
                  <span>
                    Phantom, Solflare, Backpack or any wallet that speaks the
                    Solana Wallet Standard. Your keys stay where they are.
                  </span>
                </span>
                <Icon name="arrowRight" size={16} />
              </button>

              <button
                className="auth-route"
                onClick={() => setRoute("passkey")}
                disabled={busy || support?.supported === false}
              >
                <span className="auth-route-icon">
                  <Icon name="shield" size={20} />
                </span>
                <span className="auth-route-text">
                  <strong>
                    {existing ? "Unlock your account" : "Create an account"}
                  </strong>
                  <span>
                    {existing
                      ? `Face ID, Touch ID or your device PIN unlocks ${shortAddress(existing.address)}.`
                      : "No seed phrase and no password. A passkey on this device encrypts a key only you can unwrap."}
                  </span>
                </span>
                <Icon name="arrowRight" size={16} />
              </button>

              {support?.supported === false && (
                <p className="auth-note">
                  Accounts are unavailable on this device: {support.reason}{" "}
                  Connecting a wallet works regardless.
                </p>
              )}
            </div>
          )}

          {route === "wallets" && (
            <div className="auth-panel">
              <button className="auth-back" onClick={() => setRoute("choose")}>
                Back
              </button>

              {wallets.length === 0 ? (
                isMobileBrowser() ? (
                  <div className="auth-open-in">
                    <p className="auth-note">
                      Mobile browsers cannot reach a wallet app directly. Open
                      this page inside your wallet&apos;s own browser, where it
                      connects in one tap.
                    </p>
                    {openInWalletLinks().map((l) => (
                      <a key={l.name} className="btn btn-block" href={l.href}>
                        Open in {l.name}
                      </a>
                    ))}
                  </div>
                ) : (
                  <p className="auth-note">
                    No Solana wallet found in this browser. Install Phantom,
                    Solflare or Backpack; it appears here as soon as it loads,
                    without a page reload.
                  </p>
                )
              ) : (
                <ul className="auth-wallets">
                  {wallets.map((w) => (
                    <li key={w.name}>
                      <button
                        disabled={busy}
                        onClick={() =>
                          run(async () =>
                            walletSession(await connectWallet(w), w.name),
                          )
                        }
                      >
                        {w.icon ? (
                          <img src={w.icon} alt="" width={22} height={22} />
                        ) : (
                          <Icon name="wallet" size={20} />
                        )}
                        <span>{w.name}</span>
                        <Icon name="arrowRight" size={15} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {route === "passkey" && (
            <div className="auth-panel">
              <button className="auth-back" onClick={() => setRoute("choose")}>
                Back
              </button>

              <ol className="auth-steps">
                <li>
                  <strong>A key is generated in this browser.</strong> It is an
                  ordinary Solana keypair. It is never sent anywhere.
                </li>
                <li>
                  <strong>Your passkey encrypts it.</strong> Your device
                  produces a secret only it can reproduce, and that secret locks
                  the key.
                </li>
                <li>
                  <strong>Only the locked copy is stored.</strong> Arclis cannot
                  open it. Nor can anyone who takes this device without your
                  face or fingerprint.
                </li>
              </ol>

              <p className="auth-note">
                Clearing this browser's site data deletes the locked copy, and
                the passkey alone cannot bring it back. Treat an account holding
                real value the way you would treat a hardware wallet: move it,
                or keep a wallet connection as well.
              </p>

              <button
                className="btn btn-primary auth-cta"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    if (existing) {
                      const unlocked = await unlockPasskeyAccount(existing);
                      return passkeySession(existing, unlocked.sign);
                    }
                    const account = await createPasskeyAccount(
                      `Arclis · ${new Date().toISOString().slice(0, 10)}`,
                    );
                    const unlocked = await unlockPasskeyAccount(account);
                    return passkeySession(account, unlocked.sign);
                  })
                }
              >
                {busy
                  ? "Waiting for your device…"
                  : existing
                    ? "Unlock with passkey"
                    : "Create account with passkey"}
              </button>
            </div>
          )}

          {error && (
            <p className="auth-error" role="alert">
              {error}
            </p>
          )}
        </div>
      </GlassPanel>
    </div>
  );
}
