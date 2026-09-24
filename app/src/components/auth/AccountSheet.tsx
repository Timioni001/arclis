/**
 * The account panel behind the header's wallet chip.
 *
 * The chip used to copy the address and nothing else, which left the one
 * question every new visitor has, "do I have any test USDC?", with no place to
 * be answered. This shows the wallet's SOL and test-USDC balances read from
 * the chain, offers the faucet, links the explorer, and signs out.
 */
import { useEffect, useState } from "react";
import { GlassPanel } from "../ui/Glass";
import { Icon } from "../ui";
import { AddressDisplay } from "../ui/data";
import { FaucetButton, faucetAvailable } from "../protocol/FaucetButton";
import type { Session } from "../../lib/auth/session";
import { DATA_SOURCE, QUOTE_MINT, RPC_URL, explorerAddress } from "../../lib/config";
import { usd } from "../../lib/format";

interface Balances {
  sol: number | null;
  usdc: bigint | null;
}

/** Both balances in one read. Missing token account is a zero balance. */
export async function readBalances(address: string): Promise<Balances> {
  const [{ Connection, PublicKey, LAMPORTS_PER_SOL }, { getAssociatedTokenAddressSync }] =
    await Promise.all([import("@solana/web3.js"), import("@solana/spl-token")]);
  const connection = new Connection(RPC_URL, "confirmed");
  const owner = new PublicKey(address);
  const ata = getAssociatedTokenAddressSync(new PublicKey(QUOTE_MINT), owner, true);
  const [lamports, token] = await Promise.all([
    connection.getBalance(owner).catch(() => null),
    connection
      .getTokenAccountBalance(ata)
      .then((r) => BigInt(r.value.amount))
      .catch(() => 0n),
  ]);
  return { sol: lamports === null ? null : lamports / LAMPORTS_PER_SOL, usdc: token };
}

export function AccountSheet({
  open,
  session,
  onClose,
  onSignOut,
  onFunded,
}: {
  open: boolean;
  session: Session;
  onClose: () => void;
  onSignOut: () => void;
  /** Ask the data source to re-read after the faucet lands. */
  onFunded?: () => void;
}) {
  const [balances, setBalances] = useState<Balances | null>(null);
  const [reads, setReads] = useState(0);
  const address = session.address;
  const live = DATA_SOURCE === "rpc";

  useEffect(() => {
    if (!open || !address || !live) return;
    let cancelled = false;
    setBalances(null);
    readBalances(address).then((b) => !cancelled && setBalances(b));
    return () => {
      cancelled = true;
    };
  }, [open, address, live, reads]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || !address) return null;

  const lowSol = balances?.sol !== null && balances?.sol !== undefined && balances.sol < 0.01;

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
              <h2 id="account-title">Your account</h2>
              <p>
                {session.method === "passkey"
                  ? "A passkey account on this device."
                  : `Connected with ${session.label ?? "a wallet"}.`}
              </p>
            </div>
            <button className="icon-btn auth-close" onClick={onClose} aria-label="Close">
              <Icon name="plus" size={18} />
            </button>
          </header>

          <AddressDisplay
            address={address}
            lead={8}
            tail={8}
            label={<Icon name={session.method === "passkey" ? "shield" : "wallet"} size={14} />}
            explorerHref={explorerAddress(address)}
          />

          {live ? (
            <div className="account-balances">
              <div className="account-balance">
                <span className="account-balance-label">Test USDC</span>
                <span className="account-balance-value num">
                  {balances === null
                    ? "…"
                    : balances.usdc === null
                      ? "n/a"
                      : usd(balances.usdc, { compact: false })}
                </span>
                <span className="metric-sub">Collateral for trading and liquidity</span>
              </div>
              <div className="account-balance">
                <span className="account-balance-label">Devnet SOL</span>
                <span className="account-balance-value num">
                  {balances === null
                    ? "…"
                    : balances.sol === null
                      ? "n/a"
                      : balances.sol.toFixed(4)}
                </span>
                <span className="metric-sub">
                  {lowSol ? "Too low to pay a network fee" : "Pays network fees"}
                </span>
              </div>
            </div>
          ) : (
            <p className="metric-sub">
              Demo data. Balances and the faucet run against the devnet deployment.
            </p>
          )}

          {live && faucetAvailable() && (
            <div>
              <FaucetButton
                address={address}
                onFunded={() => {
                  setReads((n) => n + 1);
                  setTimeout(() => setReads((n) => n + 1), 3000);
                  onFunded?.();
                }}
              />
              <p className="metric-sub ticket-note">
                10,000 test USDC per wallet per day, plus a little devnet SOL for fees if the
                wallet has none. Devnet only; nothing here has value.
              </p>
            </div>
          )}

          <div className="account-actions">
            <button className="btn btn-sm" onClick={() => setReads((n) => n + 1)}>
              Refresh
            </button>
            <button className="btn btn-sm" onClick={onSignOut}>
              Sign out
            </button>
          </div>
        </div>
      </GlassPanel>
    </div>
  );
}
