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

import { getWallets } from "@wallet-standard/app";
import { CLUSTER } from "../config";

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
 * Through `@wallet-standard/app`, the reference implementation of the
 * discovery handshake, rather than the thirty hand-written lines that used to
 * be here. Those had the protocol backwards on both sides: the
 * `register-wallet` event carries a *callback* that must be called with the
 * app's API, and was treated as an object with a `register` method; and
 * `app-ready` must carry that API as its detail, and was dispatched empty.
 * Neither half ever completed, so no wallet was ever detected, on any device,
 * whether or not one was installed.
 *
 * Only wallets that can connect and speak Solana are listed. Some extensions
 * announce themselves for Ethereum or Bitcoin too, and offering one of those
 * here would be a button that fails.
 */
export function startWalletDiscovery(
  onChange: (wallets: DetectedWallet[]) => void,
): () => void {
  const api = getWallets();

  const emit = () =>
    onChange(
      (api.get() as unknown as StandardWallet[])
        .filter(isSolanaWallet)
        .map((w) => ({ name: w.name, icon: w.icon, handle: w })),
    );

  const offRegister = api.on("register", emit);
  const offUnregister = api.on("unregister", emit);
  emit();

  // Android Chrome has no wallet extensions. The Mobile Wallet Adapter
  // registers a Wallet Standard wallet that hands signing to the installed
  // Phantom or Solflare app, which is the only way a mobile browser tab can
  // reach one. Loaded only on Android, where it can work, so every other
  // visitor does not download it.
  if (/android/i.test(navigator.userAgent)) {
    void registerMobileWalletAdapter();
  }

  return () => {
    offRegister();
    offUnregister();
  };
}

function isSolanaWallet(w: StandardWallet): boolean {
  const chains = (w as unknown as { chains?: readonly string[] }).chains ?? [];
  return (
    Boolean(w.features?.["standard:connect"]) &&
    chains.some((c) => c.startsWith("solana:"))
  );
}

let mwaRegistered = false;

async function registerMobileWalletAdapter() {
  if (mwaRegistered) return;
  mwaRegistered = true;
  try {
    const mwa = await import("@solana-mobile/wallet-standard-mobile");
    mwa.registerMwa({
      appIdentity: {
        name: "Arclis",
        uri: window.location.origin,
        icon: "/favicon-180.png",
      },
      authorizationCache: mwa.createDefaultAuthorizationCache(),
      chains: [chainId() as `solana:${string}`],
      chainSelector: mwa.createDefaultChainSelector(),
      onWalletNotFound: mwa.createDefaultWalletNotFoundHandler(),
    });
  } catch (e) {
    // Discovery of every other wallet is unaffected; this only means the
    // Android app hand-off is unavailable on this device.
    console.warn("Mobile Wallet Adapter unavailable", e);
  }
}

/**
 * Links that reopen this page inside a wallet app's own browser.
 *
 * On iOS, and in any mobile browser where the adapter above cannot run, the
 * page cannot reach a wallet app at all. Every major Solana wallet ships an
 * in-app browser that injects itself into the page it opens, so the practical
 * route is to send the visitor there, on this exact URL.
 */
export function openInWalletLinks(): { name: string; href: string }[] {
  const url = encodeURIComponent(window.location.href);
  const ref = encodeURIComponent(window.location.origin);
  return [
    { name: "Phantom", href: `https://phantom.app/ul/browse/${url}?ref=${ref}` },
    { name: "Solflare", href: `https://solflare.com/ul/v1/browse/${url}?ref=${ref}` },
  ];
}

/** A phone or tablet, where an installed extension is not an option. */
export function isMobileBrowser(): boolean {
  return /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent);
}

/**
 * The Wallet Standard chain identifier for wherever this build points.
 *
 * It was hardcoded to devnet, which happened to be right for a devnet
 * deployment and would have been wrong everywhere else: a wallet asked to
 * sign for `solana:devnet` while the app talks to mainnet either refuses or,
 * worse, signs against the wrong chain. The cluster is already configured;
 * there is no reason to state it twice when only one of the two can be right.
 */
function chainId(): string {
  switch (CLUSTER) {
    case "mainnet-beta":
      return "solana:mainnet";
    case "devnet":
      return "solana:devnet";
    default:
      // A local validator has no registered chain identifier of its own, and
      // wallets treat devnet as the nearest equivalent.
      return "solana:devnet";
  }
}

export async function connectWallet(
  wallet: DetectedWallet,
  chain = chainId(),
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
  /**
   * Sign without broadcasting, when the wallet supports it. Returns the signed
   * wire bytes, or null if the wallet can only sign-and-send.
   */
  signOnly(tx: import("@solana/web3.js").Transaction): Promise<Uint8Array | null>;
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
    /**
     * Preferred path. The app, not the wallet, broadcasts: a wallet sends
     * through its own RPC for whichever network it is set to, and a devnet
     * transaction broadcast to mainnet never lands. It then expires with
     * "block height exceeded" after the user has already approved it.
     */
    async signOnly(tx) {
      const signFeature = wallet.features?.["solana:signTransaction"] as
        SignTransactionFeature | undefined;
      if (!signFeature?.signTransaction) return null;
      const serialized = new Uint8Array(
        tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
      );
      const [result] = await signFeature.signTransaction({
        account,
        transaction: serialized,
        chain,
      });
      return result.signedTransaction;
    },

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
