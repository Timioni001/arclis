/**
 * Accounts without a seed phrase, without a password, and without custody.
 *
 * # The problem
 *
 * Arclis is for people who own stock. Most of them do not have a Solana
 * wallet, and the standard onboarding for that is a twelve-word phrase and a
 * warning that losing it loses their money. That is a reasonable thing to ask
 * of a crypto-native user and an unreasonable thing to ask of someone who just
 * wants to check what their tokenized AAPL is backed by. The usual escape
 * hatch is a custodial account, which solves the UX by taking the keys, and at
 * that point the product is a broker with extra steps.
 *
 * # What this does instead
 *
 * The WebAuthn **PRF extension** lets a passkey deterministically produce
 * secret bytes for a given salt, and those bytes never leave the
 * authenticator's control path. So:
 *
 *   1. Generate an Ed25519 key in WebCrypto. This is the Solana keypair.
 *   2. Ask the passkey for PRF output over a fixed salt. Derive an AES-GCM key
 *      from it with HKDF.
 *   3. Encrypt the private key with that AES key and store the ciphertext
 *      locally. The plaintext key is never written anywhere.
 *   4. To unlock, repeat the passkey ceremony. Same PRF output, same AES key,
 *      and the private key comes back.
 *
 * The user experiences Face ID or a fingerprint. What actually happens is a
 * non-custodial key that this application cannot decrypt without them standing
 * there, and that no server ever sees. There is no phrase to lose and no
 * password to phish, and the passkey itself syncs through the platform
 * keychain, so a new device is a sign-in rather than a recovery.
 *
 * # What it deliberately does not do
 *
 * It does not silently fall back to an unencrypted key when PRF is
 * unavailable. An authenticator without PRF cannot do this safely, and
 * pretending otherwise would put a bare private key in `localStorage` behind a
 * biometric prompt that is protecting nothing. On those devices the interface
 * offers wallet connect and says why, which is the honest answer.
 *
 * `crypto.subtle` Ed25519 is required and is present in current Chrome, Safari
 * and Firefox. Where it is missing, same rule: say so, offer the wallet.
 */

import { encodeBase58 } from "./base58";

/** Namespaced so a future key rotation can change the salt and re-wrap. */
const PRF_SALT = new TextEncoder().encode("arclis.account.v1");
const STORAGE_KEY = "arclis-account-v1";
const RP_NAME = "Arclis";

export interface StoredAccount {
  /** The Solana address, base58. Public, so it is stored in the clear. */
  address: string;
  /** The passkey credential to re-derive the wrapping key from. */
  credentialId: string;
  /** AES-GCM ciphertext of the PKCS8 private key, base64. */
  wrappedKey: string;
  /** The AES-GCM nonce, base64. Fresh per wrap. */
  iv: string;
  createdAt: number;
}

export interface PasskeySupport {
  supported: boolean;
  /** Present and human-readable when `supported` is false. */
  reason?: string;
}

/**
 * Can this browser do the whole ceremony?
 *
 * Checked up front rather than discovered halfway through, because the failure
 * mode otherwise is a biometric prompt followed by an error, which reads as
 * "my fingerprint was rejected".
 */
export async function checkPasskeySupport(): Promise<PasskeySupport> {
  if (typeof window === "undefined" || !window.PublicKeyCredential) {
    return {
      supported: false,
      reason: "This browser does not support passkeys.",
    };
  }
  if (!window.isSecureContext) {
    return {
      supported: false,
      reason: "Passkeys need a secure (https) connection.",
    };
  }
  if (!crypto?.subtle) {
    return {
      supported: false,
      reason: "This browser does not expose the Web Crypto API.",
    };
  }

  // Ed25519 support is uneven enough to be worth probing rather than assuming.
  try {
    await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ]);
  } catch {
    return {
      supported: false,
      reason:
        "This browser cannot generate Ed25519 keys, which Solana requires.",
    };
  }

  const available =
    await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable?.().catch(
      () => false,
    );
  if (!available) {
    return {
      supported: false,
      reason:
        "No device unlock (Face ID, Touch ID, Windows Hello) is set up on this device.",
    };
  }

  return { supported: true };
}

// --- encoding helpers ------------------------------------------------------

const toBase64 = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes as ArrayBuffer)));

const fromBase64 = (value: string) =>
  Uint8Array.from(atob(value), (c) => c.charCodeAt(0));

/**
 * Turn PRF output into an AES-GCM key.
 *
 * HKDF rather than using the PRF bytes directly: the PRF output is a MAC, not
 * a uniformly random key, and the `info` string domain-separates this use from
 * any other thing the same passkey might one day derive.
 */
async function wrappingKeyFrom(prf: ArrayBuffer): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", prf, "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: PRF_SALT,
      info: new TextEncoder().encode("arclis-account-wrapping-key"),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function prfOutput(credential: PublicKeyCredential): ArrayBuffer {
  const results = credential.getClientExtensionResults() as {
    prf?: { results?: { first?: ArrayBuffer } };
  };
  const first = results.prf?.results?.first;
  if (!first) {
    throw new Error(
      "This device's passkey cannot derive an encryption key (no PRF support). " +
        "Connect an existing wallet instead.",
    );
  }
  return first;
}

/**
 * Solana addresses are the raw 32-byte Ed25519 public key, base58. WebCrypto
 * exports Ed25519 public keys as SPKI, whose last 32 bytes are exactly that.
 */
async function addressOf(publicKey: CryptoKey): Promise<string> {
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", publicKey));
  return encodeBase58(spki.slice(spki.length - 32));
}

// --- the ceremony ----------------------------------------------------------

/** Create an account: one passkey, one Ed25519 key, wrapped and stored. */
export async function createPasskeyAccount(
  label: string,
): Promise<StoredAccount> {
  const userId = crypto.getRandomValues(new Uint8Array(16));

  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: RP_NAME, id: window.location.hostname },
      user: { id: userId, name: label, displayName: label },
      // ES256 then RS256. Both are universally supported; the passkey's own
      // algorithm is unrelated to the Ed25519 key it protects.
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
        authenticatorAttachment: "platform",
      },
      timeout: 60_000,
      extensions: {
        prf: { eval: { first: PRF_SALT } },
      } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;

  if (!credential) throw new Error("Account creation was cancelled.");

  // Some authenticators only return PRF output on an assertion, not on
  // creation, so the registration is immediately followed by one. It costs a
  // second prompt once, and it is the difference between working on every
  // platform and working on some of them.
  let prf: ArrayBuffer;
  try {
    prf = prfOutput(credential);
  } catch {
    prf = await assertPrf(credential.rawId);
  }

  const wrappingKey = await wrappingKeyFrom(prf);
  const keyPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;

  const pkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    wrappingKey,
    pkcs8,
  );

  const account: StoredAccount = {
    address: await addressOf(keyPair.publicKey),
    credentialId: toBase64(credential.rawId),
    wrappedKey: toBase64(wrapped),
    iv: toBase64(iv),
    createdAt: Math.floor(Date.now() / 1000),
  };

  saveAccount(account);
  return account;
}

async function assertPrf(credentialId: ArrayBuffer): Promise<ArrayBuffer> {
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rpId: window.location.hostname,
      allowCredentials: [{ type: "public-key", id: credentialId }],
      userVerification: "required",
      timeout: 60_000,
      extensions: {
        prf: { eval: { first: PRF_SALT } },
      } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;

  if (!assertion) throw new Error("Unlock was cancelled.");
  return prfOutput(assertion);
}

/**
 * Unlock a stored account and return a signing key.
 *
 * The returned `CryptoKey` is non-extractable, so even after unlocking, the
 * private key cannot be read back out of the page. It signs and nothing else.
 */
export async function unlockPasskeyAccount(account: StoredAccount): Promise<{
  address: string;
  sign: (message: Uint8Array) => Promise<Uint8Array>;
}> {
  const prf = await assertPrf(
    fromBase64(account.credentialId).buffer as ArrayBuffer,
  );
  const wrappingKey = await wrappingKeyFrom(prf);

  let pkcs8: ArrayBuffer;
  try {
    pkcs8 = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(account.iv) },
      wrappingKey,
      fromBase64(account.wrappedKey),
    );
  } catch {
    // AES-GCM authenticates, so a failure here means the ciphertext or the
    // derived key is wrong, not that the data is merely unreadable.
    throw new Error(
      "That passkey does not unlock this account. It may belong to a different account on this device.",
    );
  }

  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "Ed25519" },
    false,
    ["sign"],
  );

  return {
    address: account.address,
    sign: async (message) => {
      const signature = await crypto.subtle.sign(
        { name: "Ed25519" },
        privateKey,
        message as unknown as BufferSource,
      );
      return new Uint8Array(signature);
    },
  };
}

// --- storage ---------------------------------------------------------------

export function loadAccount(): StoredAccount | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredAccount;
    // A half-written record is worse than none: it would present a working
    // account that fails at signing time.
    if (
      !parsed.address ||
      !parsed.wrappedKey ||
      !parsed.credentialId ||
      !parsed.iv
    )
      return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveAccount(account: StoredAccount): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(account));
  } catch {
    // Private browsing. The account works for this session and will need
    // creating again next time, which the interface states rather than hides.
  }
}

/**
 * Forget the wrapped key on this device.
 *
 * Note what this does not do: it cannot delete the passkey, which lives in the
 * platform keychain, and without the ciphertext the passkey alone cannot
 * recover the account. So this is destructive, and the interface asks first.
 */
export function forgetAccount(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing stored, nothing to clear */
  }
}
