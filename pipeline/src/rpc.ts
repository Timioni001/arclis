/**
 * Reading a mint account over plain JSON-RPC.
 *
 * `fetch` rather than `@solana/web3.js`: the registry needs one method, and a
 * 300KB dependency for `getAccountInfo` is not a good trade. Shared by the
 * one-off pipeline script and the keeper's scheduled registry build.
 */

export type AccountReader = (
  address: string,
) => Promise<{ data: Uint8Array; owner: string } | null>;

export function accountReader(
  rpcUrl: string,
  fetchImpl: typeof fetch = fetch,
): AccountReader {
  return async (address) => {
    const response = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getAccountInfo",
        params: [address, { encoding: "base64" }],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`rpc ${response.status}`);

    const body = (await response.json()) as {
      result?: { value?: { data?: [string, string]; owner?: string } };
      error?: { message?: string };
    };
    if (body.error) throw new Error(body.error.message ?? "rpc error");

    const value = body.result?.value;
    if (!value?.data) return null;

    return {
      data: Uint8Array.from(Buffer.from(value.data[0], "base64")),
      owner: value.owner ?? "",
    };
  };
}
