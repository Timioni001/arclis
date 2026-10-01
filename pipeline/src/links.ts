/**
 * Checking that every source link on the registry still goes somewhere.
 *
 * Issuers move their documents. A registry whose whole promise is "every
 * claim links to its source" cannot let those links rot quietly, so each one
 * is fetched on the same schedule as the data and the result travels with the
 * snapshot. The page then sends a reader to the issuer's home page instead of
 * a dead document, and says so.
 *
 * Three outcomes, because the third one matters:
 *
 *   - `ok: true`   the page answered (any 2xx or 3xx that resolved).
 *   - `ok: false`  it is gone: 404, 410, a 5xx, or no answer at all.
 *   - `ok: null`   the site refused an automated visitor (401, 403, 429).
 *                  Bot protection says nothing about whether a person can
 *                  open the page, so it is not reported as broken.
 */

export interface LinkCheck {
  ok: boolean | null;
  status: number;
  checkedAt: number;
}

const REFUSED = new Set([401, 403, 405, 429]);

export async function checkLink(
  url: string,
  fetchImpl: typeof fetch = fetch,
  now = () => Math.floor(Date.now() / 1000),
): Promise<LinkCheck> {
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        accept: "text/html,application/pdf;q=0.9,*/*;q=0.8",
        "user-agent": "ArclisRegistryLinkCheck/1.0 (+https://arclis.world)",
      },
      signal: AbortSignal.timeout(12_000),
    });
    // Only the status matters; do not download a prospectus PDF to learn it.
    void response.body?.cancel().catch(() => {});
    const status = response.status;
    return {
      ok: REFUSED.has(status) ? null : status < 400,
      status,
      checkedAt: now(),
    };
  } catch {
    return { ok: false, status: 0, checkedAt: now() };
  }
}
