/**
 * "Get test USDC": the keeper's devnet faucet, one click from the place the
 * shortfall shows up.
 *
 * Nothing secret is involved. The keeper holds the test mint's authority and
 * enforces the limits; this only names the wallet to fund.
 */
import { useState } from "react";
import { Button } from "../ui";
import { DATA_SOURCE, KEEPER_URL } from "../../lib/config";

type Step =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "done"; message: string }
  | { kind: "error"; message: string };

export function faucetAvailable(): boolean {
  return DATA_SOURCE === "rpc" && Boolean(KEEPER_URL);
}

export async function requestTestUsdc(
  address: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const url = `${KEEPER_URL.replace(/\/$/, "")}/faucet?address=${encodeURIComponent(address)}`;
  let res: Response;
  try {
    res = await fetchImpl(url, { method: "POST" });
  } catch {
    throw new Error("The faucet could not be reached. Try again shortly.");
  }
  const body = (await res.json().catch(() => ({}))) as {
    amount?: number;
    sol?: number;
    error?: string;
  };
  if (!res.ok)
    throw new Error(body.error ?? `The faucet answered ${res.status}.`);
  const usdc = (body.amount ?? 0).toLocaleString("en-US");
  return body.sol
    ? `Sent ${usdc} test USDC and ${body.sol} SOL for fees.`
    : `Sent ${usdc} test USDC.`;
}

export function FaucetButton({
  address,
  onFunded,
}: {
  address: string;
  onFunded?: () => void;
}) {
  const [step, setStep] = useState<Step>({ kind: "idle" });
  if (!faucetAvailable()) return null;

  async function run() {
    setStep({ kind: "sending" });
    try {
      const message = await requestTestUsdc(address);
      setStep({ kind: "done", message });
      onFunded?.();
    } catch (e) {
      setStep({ kind: "error", message: (e as Error).message });
    }
  }

  return (
    <div className="faucet">
      <Button
        block
        onClick={run}
        disabled={step.kind === "sending" || step.kind === "done"}
      >
        {step.kind === "sending" ? "Requesting…" : "Get test USDC"}
      </Button>
      {(step.kind === "done" || step.kind === "error") && (
        <p
          className="metric-sub ticket-note"
          role={step.kind === "error" ? "alert" : "status"}
        >
          {step.message}
        </p>
      )}
    </div>
  );
}
