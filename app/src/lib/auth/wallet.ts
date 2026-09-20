/**
 * Wallet connect, over the Wallet Standard.
 *
 * Deliberately not `@solana/wallet-adapter-react`. That package pulls a
 * provider tree, a modal, a CSS file and a per-wallet adapter for each wallet
 * it supports, and it exists to paper over an era when every wallet injected
 * its own bespoke object. The Wallet Standard ended that: wallets announce
 * themselves on a window event, and discovery is the thirty lines below.
 *
 * The narrower surface is also the safer one. Nothing here ever asks for a
 * private key, and the only method used beyond connect is `signMessage`, so a
 * malicious injected wallet has very little to work with.
 */

export interface DetectedWallet {
  name: string;
  icon: string;
  /** Opaque handle back to the provider that announced itself. */
  handle: unknown;
}

interface StandardWallet {
  name: string;
  icon: string;
  features: Record<string, unknown>;
  accounts: ReadonlyArray<{ address: string; publicKey: Uint8Array }>;
}

interface ConnectFeature {
  connect: (input?: { silent?: boolean }) => Promise<{
    accounts: ReadonlyArray<{ address: string }>;
  }>;
}

const registry = new Map<string, StandardWallet>();

/**
 * Start listening for wallets.
 *
 * The handshake is deliberately two-way: wallets that loaded before this page
 * did are waiting for the `app-ready` event, and wallets that load afterwards
 * fire `register` at us. Listening for only one of the two is the classic
 * "works on refresh, not on first load" bug.
 */
export function startWalletDiscovery(
  onChange: (wallets: DetectedWallet[]) => void,
): () => void {
  const emit = () =>
    onChange(
      [...registry.values()].map((w) => ({
        name: w.name,
        icon: w.icon,
        handle: w,
      })),
    );

  const onRegister = (event: Event) => {
    const detail = (event as CustomEvent<{ register: (api: unknown) => void }>)
      .detail;
    detail?.register?.({
      register: (...wallets: StandardWallet[]) => {
        for (const w of wallets) registry.set(w.name, w);
        emit();
      },
    });
  };

  const onAnnounce = (event: Event) => {
    const wallet = (event as CustomEvent<StandardWallet>).detail;
    if (wallet?.name) {
      registry.set(wallet.name, wallet);
      emit();
    }
  };

  window.addEventListener("wallet-standard:register-wallet", onRegister);
  window.addEventListener("wallet-standard:wallet-announced", onAnnounce);
  window.dispatchEvent(new Event("wallet-standard:app-ready"));
  emit();

  return () => {
    window.removeEventListener("wallet-standard:register-wallet", onRegister);
    window.removeEventListener("wallet-standard:wallet-announced", onAnnounce);
  };
}

export async function connectWallet(wallet: DetectedWallet): Promise<string> {
  const standard = wallet.handle as StandardWallet;
  const feature = standard.features?.["standard:connect"] as
    ConnectFeature | undefined;
  if (!feature?.connect) {
    throw new Error(
      `${wallet.name} does not support the standard connect flow.`,
    );
  }

  const result = await feature.connect();
  const address = result.accounts[0]?.address ?? standard.accounts[0]?.address;
  if (!address) {
    throw new Error(`${wallet.name} connected but did not share an account.`);
  }
  return address;
}
