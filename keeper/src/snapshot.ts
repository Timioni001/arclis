/**
 * Every market account, read once here and served to every visitor.
 *
 * The interface used to read the whole book from the public devnet endpoint
 * itself, and rebuild each market's price history from transactions on first
 * load. With thirty-five markets that was hundreds of requests from one
 * browser, the endpoint's per-IP limit answered with 429, the first paint sat
 * on skeletons, and a trade could not even fetch a blockhash.
 *
 * Here the keeper reads each market's oracle, market, pool and vaults every
 * few seconds (a handful of batched calls, however many people are looking)
 * and serves the raw account data at `/snapshot`. The browser decodes it with
 * the same decoders it always used, so the snapshot is the chain's bytes, not
 * a second interpretation of them. Treasuries are scanned less often, because
 * `getProgramAccounts` is the heaviest read there is.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { utils } from "@coral-xyz/anchor";
import idl from "../../idl/arclis.json";
import { addressesFor } from "./cranks";

export interface SnapshotJson {
  /** Unix seconds of the last successful account read. */
  fetchedAt: number;
  /** Base64 account data by address; null for an account that does not exist. */
  accounts: Record<string, string | null>;
  /** Every AgentTreasury account, from the last successful scan. */
  treasuries: { pubkey: string; data: string }[];
}

const CHUNK = 100;

function treasuryDiscriminator(): number[] {
  const acc = (idl as { accounts?: { name: string; discriminator?: number[] }[] })
    .accounts?.find((a) => a.name === "AgentTreasury");
  if (!acc?.discriminator) throw new Error("AgentTreasury missing from the IDL");
  return acc.discriminator;
}

export class AccountSnapshot {
  private accounts: Record<string, string | null> = {};
  private treasuries: { pubkey: string; data: string }[] = [];
  private fetchedAt = 0;
  private readonly keys: PublicKey[];

  constructor(
    private readonly connection: Connection,
    private readonly programId: PublicKey,
    symbols: string[],
  ) {
    this.keys = symbols.flatMap((s) => {
      const a = addressesFor(programId, s);
      return [a.oracle, a.market, a.pool, a.poolVault, a.marketVault];
    });
  }

  /** The book. A failed read keeps the last good copy and its timestamp. */
  async refresh(): Promise<void> {
    const next: Record<string, string | null> = {};
    for (let i = 0; i < this.keys.length; i += CHUNK) {
      const chunk = this.keys.slice(i, i + CHUNK);
      const infos = await this.connection.getMultipleAccountsInfo(chunk);
      chunk.forEach((k, j) => {
        const info = infos[j];
        next[k.toBase58()] = info ? Buffer.from(info.data).toString("base64") : null;
      });
    }
    this.accounts = next;
    this.fetchedAt = Math.floor(Date.now() / 1000);
  }

  /** Agent treasuries. A failed scan keeps the last good list. */
  async refreshTreasuries(): Promise<void> {
    const found = await this.connection.getProgramAccounts(this.programId, {
      filters: [
        {
          memcmp: {
            offset: 0,
            bytes: utils.bytes.bs58.encode(Uint8Array.from(treasuryDiscriminator())),
          },
        },
      ],
    });
    this.treasuries = found.map(({ pubkey, account }) => ({
      pubkey: pubkey.toBase58(),
      data: Buffer.from(account.data).toString("base64"),
    }));
  }

  json(): SnapshotJson {
    return {
      fetchedAt: this.fetchedAt,
      accounts: this.accounts,
      treasuries: this.treasuries,
    };
  }
}
