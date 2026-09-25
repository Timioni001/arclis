/**
 * The open market's oracle, re-read every ten seconds on the Trade page.
 *
 * The data source re-reads the whole book every thirty seconds, which is the
 * right cadence for thirty-five markets and the wrong one for the market being
 * traded: its price could look over a minute old while the chain held a fresh
 * one, the page warned about a delay that did not exist, and the order ticket
 * judged staleness against a number up to thirty seconds behind the program's.
 * One account read every ten seconds keeps the price, its age and the ticket's
 * check within a few seconds of what the program itself sees.
 */
import { useEffect, useState } from "react";
import type { Connection } from "@solana/web3.js";
import type { Oracle } from "./types";
import { DATA_SOURCE, RPC_URL } from "../config";

type Live = Pick<
  Oracle,
  "price" | "confidence" | "lastUpdateTs" | "session" | "sessionUpdatedTs"
>;

let shared: Connection | null = null;

export function useLiveOracle(oracle: Oracle, intervalMs = 10_000): Oracle {
  const [live, setLive] = useState<Live | null>(null);

  useEffect(() => {
    setLive(null);
    if (DATA_SOURCE !== "rpc") return;
    let cancelled = false;
    const read = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const [{ Connection, PublicKey }, { decodeOracle }] = await Promise.all(
          [import("@solana/web3.js"), import("./rpc/decode")],
        );
        shared ??= new Connection(RPC_URL, "confirmed");
        const address = new PublicKey(oracle.address);
        const info = await shared.getAccountInfo(address);
        if (!info || cancelled) return;
        const o = decodeOracle(address, info.data as Buffer);
        setLive({
          price: o.price,
          confidence: o.confidence,
          lastUpdateTs: o.lastUpdateTs,
          session: o.session,
          sessionUpdatedTs: o.sessionUpdatedTs,
        });
      } catch {
        /* the thirty-second read is still there */
      }
    };
    void read();
    const id = setInterval(read, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [oracle.address, intervalMs]);

  // Whichever read is newer wins: the book read can land between these.
  return live && live.lastUpdateTs >= oracle.lastUpdateTs
    ? { ...oracle, ...live }
    : oracle;
}
