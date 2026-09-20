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
  accounts: ReadonlyArray<StandardAccount>;
}

interface StandardAccount {
  address: string;
  publicKey: Uint8Array;
  features?: readonly string[];
}

interface ConnectFeature {
  connect: (input?: { silent?: boolean }) => Promise<{
    accounts: ReadonlyArray<StandardAccount>;
  }>;
}

interface SignAndSendFeature {
  signAndSendTransaction: (
    ...inputs: Array<{
      account: StandardAccount;
      transaction: Uint8Array;
      chain: string;
      options?: { preflightCommitment?: string; skipPreflight?: boolean };
    }>
  ) => Promise<Array<{ signature: Uint8Array }>>;
}

interface SignTransactionFeature {
  signTransaction: (
    ...inputs: Array<{
      account: StandardAccount;
      transaction: Uint8Array;
      chain?: string;
    }>
  ) => Promise<Array<{ signedTransaction: Uint8Array }>>;
}

const registry = new Map<string, StandardWallet>();

/**
 * The wallet and account this session connected with.
 *
 * Held here rather than inside the React session because a transaction needs
 * the live provider object, which is not serialisable and must not end up in
 * state that gets cloned or persisted.
 */
let active: {
  wallet: StandardWallet;
  account: StandardAccount;
  chain: string;
} | null = null;

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

export async function connectWallet(
  wallet: DetectedWallet,
  chain = "solana:devnet",
): Promise<string> {
  const standard = wallet.handle as StandardWallet;
  const feature = standard.features?.["standard:connect"] as
    ConnectFeature | undefined;
  if (!feature?.connect) {
    throw new Error(
      `${wallet.name} does not support the standard connect flow.`,
    );
  }

  const result = await feature.connect();
  const account = result.accounts[0] ?? standard.accounts[0];
  if (!account?.address) {
    throw new Error(`${wallet.name} connected but did not share an account.`);
  }

  active = { wallet: standard, account, chain };
  return account.address;
}

export function disconnectWallet(): void {
  active = null;
}

export interface ConnectedWallet {
  name: string;
  address: string;
  signAndSend(
    tx: import("@solana/web3.js").Transaction,
    connection: import("@solana/web3.js").Connection,
    options?: import("@solana/web3.js").SendOptions,
  ): Promise<string>;
}

/**
 * The connected wallet, wrapped so callers never touch the provider directly.
 *
 * Returns null when nothing is connected, which the caller must handle: a
 * wallet extension can be locked or disconnected between a page load and a
 * transaction, and that is a message to show rather than a crash.
 */
export function connectedWallet(): ConnectedWallet | null {
  if (!active) return null;
  const { wallet, account, chain } = active;

  return {
    name: wallet.name,
    address: account.address,

    /**
     * Sign and broadcast.
     *
     * Wallets that implement `signAndSendTransaction` broadcast themselves,
     * and that path is preferred: it is the one their own UI is built around,
     * and some do extra work there (priority fees, retries) that is lost if
     * the app broadcasts instead. `signTransaction` is the fallback.
     */
    async signAndSend(tx, connection, options) {
      const serialized = new Uint8Array(
        tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
      );

      const sendFeature = wallet.features?.["solana:signAndSendTransaction"] as
        SignAndSendFeature | undefined;
      if (sendFeature?.signAndSendTransaction) {
        const [result] = await sendFeature.signAndSendTransaction({
          account,
          transaction: serialized,
          chain,
          options: options?.skipPreflight ? { skipPreflight: true } : undefined,
        });
        return encodeSignature(result.signature);
      }

      const signFeature = wallet.features?.["solana:signTransaction"] as
        SignTransactionFeature | undefined;
      if (signFeature?.signTransaction) {
        const [result] = await signFeature.signTransaction({
          account,
          transaction: serialized,
          chain,
        });
        return connection.sendRawTransaction(result.signedTransaction, options);
      }

      throw new Error(
        `${wallet.name} connected but cannot sign transactions on this chain.`,
      );
    },
  };
}

/** Wallets return a raw signature; a transaction id is its base58 form. */
function encodeSignature(bytes: Uint8Array): string {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]];
  return out;
}
