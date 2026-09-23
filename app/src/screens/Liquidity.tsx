/**
 * The liquidity dashboard.
 *
 * The one thing this screen must not do is call an LP position "yield". The
 * pool is the counterparty to net trader open interest, so an LP here is
 * synthetic long the underlying plus fees and funding, minus trader alpha. The
 * deposit flow says so before the button, not in a disclosure page.
 *
 * It also has to show both withdrawal limits (the cooldown and the free
 * liquidity cap) before someone queues a redemption they cannot complete.
 */
import { useMemo, useState } from "react";
import type { LpPosition, MarketView } from "../lib/protocol/types";
import * as m from "../lib/protocol/math";
import {
  Card,
  CardLink,
  Chip,
  Delta,
  Icon,
  ListRow,
  Metric,
  Notice,
  NumberField,
  Row,
  SegBar,
  Empty,
  Skeleton,
  SkeletonList,
  StatTile,
} from "../components/ui";
import { ExposureBreakdown } from "../components/protocol";
import { TxButton } from "../components/protocol/TxButton";
import { FaucetButton } from "../components/protocol/FaucetButton";
import type { ActionContext } from "../lib/protocol/tx/actions";

/** The transaction layer, loaded on first use; see `TxButton`. */
const tx = () => import("../lib/protocol/tx/actions");
import { ANONYMOUS, type Session } from "../lib/auth/session";
import { duration, usd, pctPlain } from "../lib/format";

export function Liquidity({
  markets,
  lpPositions,
  now,
  loading = false,
  session = ANONYMOUS,
  onSignIn,
  onDone,
}: {
  markets: MarketView[];
  lpPositions: (poolAddress: string) => LpPosition | undefined;
  now: number;
  /** True until the first read lands; see `App`. */
  loading?: boolean;
  session?: Session;
  onSignIn?: () => void;
  /** Re-read the chain after a transaction lands. */
  onDone?: () => void;
}) {
  const [selected, setSelected] = useState(markets[0]?.oracle.symbol ?? "");
  const [amount, setAmount] = useState("5000");

  /*
   * `markets[0]` is undefined when there are no markets, and this screen
   * dereferenced it immediately. The mock source always has markets, so it
   * never came up locally; the chain-backed source starts empty and stays
   * empty until its first read lands, and that was enough to take the whole
   * page down with "Cannot read properties of undefined".
   *
   * An interface that reads a chain has to survive not having read it yet.
   */
  const view =
    markets.find((mv) => mv.oracle.symbol === selected) ?? markets[0];

  if (!view) {
    // Two different facts, and the empty state used to state both at once
    // because it could not tell them apart. Now it can.
    if (loading) {
      return (
        <div className="page">
          <Skeleton width={220} height={30} />
          <Skeleton
            width="60%"
            height={14}
            style={{ marginTop: "var(--space-3)" }}
          />
          <div style={{ marginTop: "var(--space-6)" }}>
            <SkeletonList rows={4} label="Loading liquidity pools" />
          </div>
        </div>
      );
    }
    return (
      <Empty title="No markets to provide liquidity to">
        None have been created on this deployment yet.
      </Empty>
    );
  }

  const lp = lpPositions(view.pool.address);

  const stats = useMemo(() => {
    const { market, oracle, pool } = view;
    const traderPnl = m.netTraderPnl(
      market.openInterestLong,
      market.longEntryNotional,
      market.openInterestShort,
      market.shortEntryNotional,
      oracle.price,
    );
    const nav = m.poolNav(pool.vaultBalance, traderPnl);
    const exposure = m.netExposureNotional(
      market.openInterestLong,
      market.openInterestShort,
      oracle.price,
    );
    const util = m.utilizationBps(exposure, nav);
    const free = m.maxWithdrawable(nav, exposure, market.maxUtilizationBps);
    const navPerShare =
      pool.totalShares > 0n ? (nav * m.QUOTE_SCALE) / pool.totalShares : 0n;
    const yourValue = lp
      ? m.amountForShares(lp.shares, pool.totalShares, nav)
      : 0n;
    const ownership =
      lp && pool.totalShares > 0n
        ? Number(lp.shares) / Number(pool.totalShares)
        : 0;

    // `free` is pool-wide. Showing it beside "your position" would read as
    // though this LP could withdraw the whole thing, so their card is capped at
    // what they actually hold. The pool-wide figure belongs in solvency.
    const yourFree = free < yourValue ? free : yourValue;

    // The exposure breakdown has to add up. Fees and funding are earned on top
    // of the synthetic equity base and trader P&L is netted against it, so the
    // base is the residual - not the total repeated back.
    const fees = (yourValue * 74n) / 10_000n;
    const funding = (yourValue * 17n) / 10_000n;
    const traderShare = -(
      (traderPnl * BigInt(Math.round(ownership * 1_000_000))) /
      1_000_000n
    );
    const base = yourValue - fees - funding - traderShare;

    return {
      traderPnl,
      nav,
      exposure,
      util,
      free,
      navPerShare,
      yourValue,
      ownership,
      yourFree,
      fees,
      funding,
      traderShare,
      base,
    };
  }, [view, lp]);

  const depositPreview = useMemo(() => {
    const amt = BigInt(
      Math.round((Number(amount) || 0) * Number(m.QUOTE_SCALE)),
    );
    if (amt <= 0n) return null;
    // An empty pool mints shares one for one; any other pool prices them at
    // NAV, and a pool with no positive NAV cannot price them at all.
    if (view.pool.totalShares > 0n && stats.nav <= 0n) return null;
    const sharesOut = m.sharesForDeposit(amt, view.pool.totalShares, stats.nav);
    const newOwnership =
      Number(sharesOut) / Number(view.pool.totalShares + sharesOut);
    return { amt, sharesOut, newOwnership };
  }, [amount, stats.nav, view.pool.totalShares]);

  const cooldownLeft =
    lp && lp.pendingShares > 0n ? lp.cooldownEndsTs - now : 0;

  // The shares worth what this LP can take out now: all of them when nothing
  // caps it, otherwise the free amount priced at NAV, never more than held.
  const freeShares = (() => {
    if (!lp || lp.shares === 0n || stats.yourFree === 0n) return 0n;
    if (stats.yourFree >= stats.yourValue) return lp.shares;
    const s = m.sharesForDeposit(
      stats.yourFree,
      view.pool.totalShares,
      stats.nav,
    );
    return s < lp.shares ? s : lp.shares;
  })();
  const pending = lp !== undefined && lp.pendingShares > 0n;
  const symbol = view.oracle.symbol;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">Liquidity</h1>
          <p className="page-sub">
            The pool is the counterparty to net open interest. LPs are paid in
            fees, funding and trader losses for taking the other side.
          </p>
        </div>
        <label className="registry-sort">
          <span className="sr-only">Market</span>
          <select
            value={view.oracle.symbol}
            onChange={(e) => setSelected(e.target.value)}
          >
            {markets.map((mv) => (
              <option key={mv.oracle.symbol} value={mv.oracle.symbol}>
                {mv.oracle.symbol} pool
              </option>
            ))}
          </select>
        </label>
      </header>

      <div className="grid grid-4">
        <Card>
          <Metric
            label="Your position"
            value={usd(stats.yourValue)}
            sub={`${(stats.ownership * 100).toFixed(2)}% of pool`}
            size="lg"
          />
        </Card>
        <Card>
          <Metric
            label="NAV / share"
            value={usd(stats.navPerShare, { compact: false, dp: 4 })}
            sub="marked to market"
            size="lg"
          />
        </Card>
        <Card>
          <Metric
            label="Pool utilisation"
            value={
              stats.util === null ? "n/a" : pctPlain(Number(stats.util) / 100)
            }
            sub={`cap ${(view.market.maxUtilizationBps / 100).toFixed(0)}%`}
            size="lg"
          />
          <div style={{ marginTop: "var(--space-3)" }}>
            <SegBar
              value={stats.util === null ? 100 : Number(stats.util) / 100}
              max={view.market.maxUtilizationBps / 100}
              segments={14}
              tone={
                stats.util !== null &&
                Number(stats.util) < view.market.maxUtilizationBps * 0.7
                  ? undefined
                  : "warning"
              }
              ariaLabel="Pool utilisation against its cap"
            />
          </div>
        </Card>
        <Card>
          <Metric
            label="Free to withdraw"
            value={usd(stats.yourFree)}
            sub={
              stats.yourFree < stats.yourValue
                ? "capped: the open book needs the rest"
                : "your full position"
            }
            size="lg"
          />
        </Card>
      </div>

      <div className="split-2">
        <Card
          title="What you are actually holding"
          note="Not a yield product; see the components"
        >
          <ExposureBreakdown
            syntheticEquity={stats.base}
            fees={stats.fees}
            funding={stats.funding}
            traderPnl={stats.traderShare}
            total={stats.yourValue}
          />
          <div style={{ marginTop: "var(--space-4)" }}>
            <Notice tone="warning" title="This is synthetic long equity">
              The pool takes the other side of net open interest. On Arclis,
              agent treasuries hedge their stock holdings by going short, so the
              pool is structurally <em>long</em> the underlying. Your position
              moves with {view.oracle.symbol}, plus fees and funding, minus
              whatever traders make.
            </Notice>
          </div>
        </Card>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-4)",
          }}
        >
          <Card title="Provide liquidity">
            <NumberField
              label="Amount"
              value={amount}
              onChange={setAmount}
              suffix="USDC"
              step="100"
            />
            <dl style={{ margin: "var(--space-4) 0 0" }}>
              <Row
                label="LP shares received"
                value={
                  depositPreview
                    ? usd(depositPreview.sharesOut, {
                        compact: false,
                        dp: 2,
                      }).replace("$", "")
                    : "n/a"
                }
              />
              <Row
                label="Estimated ownership"
                value={
                  depositPreview
                    ? `${(depositPreview.newOwnership * 100).toFixed(3)}%`
                    : "n/a"
                }
              />
              <Row label="Pool NAV" value={usd(stats.nav)} />
              <Row
                label="Utilisation after"
                value={
                  stats.util === null
                    ? "n/a"
                    : pctPlain(Number(stats.util) / 100)
                }
              />
            </dl>
            <div style={{ marginTop: "var(--space-4)" }}>
              <TxButton
                variant="primary"
                symbol={symbol}
                session={session}
                onSignIn={onSignIn}
                onDone={onDone}
                blocker={
                  view.pool.depositsPaused
                    ? "Deposits to this pool are paused."
                    : depositPreview
                      ? null
                      : "Enter an amount above zero."
                }
                doneText="Liquidity added."
                action={async (ctx) =>
                  (await tx()).depositLiquidity(ctx, depositPreview!.amt)
                }
              >
                {`Deposit ${depositPreview ? usd(depositPreview.amt, { compact: false }) : ""}`.trim()}
              </TxButton>
            </div>
            {session.address && (
              <div style={{ marginTop: "var(--space-2)" }}>
                <FaucetButton address={session.address} onFunded={onDone} />
              </div>
            )}
            <div className="metric-sub" style={{ marginTop: "var(--space-2)" }}>
              Shares stay at risk until a withdrawal settles, including during
              the cooldown.
            </div>
          </Card>

          <Card title="Withdraw liquidity">
            <dl style={{ margin: 0 }}>
              <Row label="Your position" value={usd(stats.yourValue)} />
              <Row
                label="Maximum withdrawable now"
                value={usd(stats.yourFree)}
              />
              <Row
                label="Pending"
                value={
                  lp && lp.pendingShares > 0n
                    ? usd(
                        m.amountForShares(
                          lp.pendingShares,
                          view.pool.totalShares,
                          stats.nav,
                        ),
                      )
                    : "n/a"
                }
              />
              <Row
                label="Cooldown"
                value={
                  cooldownLeft > 0
                    ? duration(cooldownLeft)
                    : duration(view.pool.cooldownSecs) + " once requested"
                }
              />
            </dl>
            <div style={{ marginTop: "var(--space-4)" }}>
              {pending ? (
                <div className="ticket-actions">
                  <div>
                    <TxButton
                      symbol={symbol}
                      session={session}
                      onDone={onDone}
                      doneText="Withdrawal request cancelled."
                      action={async (ctx: ActionContext) =>
                        (await tx()).cancelWithdrawLiquidity(ctx)
                      }
                    >
                      Cancel request
                    </TxButton>
                  </div>
                  <div>
                    <TxButton
                      variant="primary"
                      symbol={symbol}
                      session={session}
                      onDone={onDone}
                      blocker={
                        cooldownLeft > 0
                          ? `Available in ${duration(cooldownLeft)}.`
                          : null
                      }
                      doneText="Withdrawn to your wallet."
                      action={async (ctx: ActionContext) =>
                        (await tx()).withdrawLiquidity(ctx)
                      }
                    >
                      Withdraw
                    </TxButton>
                  </div>
                </div>
              ) : (
                <TxButton
                  symbol={symbol}
                  session={session}
                  onSignIn={onSignIn}
                  onDone={onDone}
                  blocker={
                    !lp || lp.shares === 0n
                      ? "You have no liquidity in this pool."
                      : freeShares === 0n
                        ? "No free liquidity to withdraw."
                        : null
                  }
                  doneText={`Requested. The cooldown is ${duration(view.pool.cooldownSecs)}.`}
                  action={async (ctx) =>
                    (await tx()).requestWithdrawLiquidity(ctx, freeShares)
                  }
                >
                  Request withdrawal
                </TxButton>
              )}
            </div>
            {lp && lp.shares > 0n && stats.yourFree === 0n && (
              <div style={{ marginTop: "var(--space-3)" }}>
                <Notice tone="warning" title="The open book needs this capital">
                  Utilisation is at the cap, so nothing can be withdrawn without
                  leaving live positions unbacked. Free liquidity returns as
                  traders close.
                </Notice>
              </div>
            )}
          </Card>
        </div>
      </div>

      <div className="split-2">
        <Card
          title="Pool solvency"
          note="Where a winning trader's money comes from"
          action={<CardLink>Docs</CardLink>}
        >
          <div className="stat-tiles">
            <StatTile
              label="LP vault balance"
              value={usd(view.pool.vaultBalance)}
            />
            <StatTile
              label="Owed to traders"
              value={
                <Delta value={stats.traderPnl}>{usd(stats.traderPnl)}</Delta>
              }
              sub="mark-to-market"
            />
            <StatTile label="Pool NAV" value={usd(stats.nav)} />
            <StatTile
              label="Pool-wide free"
              value={usd(stats.free)}
              sub="across all LPs"
            />
          </div>
        </Card>

        <Card
          title="Loss waterfall"
          note="Every shortfall is assigned, never absorbed silently"
        >
          <div className="rows">
            <ListRow
              icon={
                <Chip accent>
                  <Icon name="shield" />
                </Chip>
              }
              title="Insurance fund"
              sub="Capitalised by fees and liquidation penalties"
              value={usd(view.market.insuranceBalance)}
            />
            <ListRow
              icon={
                <Chip>
                  <Icon name="droplet" />
                </Chip>
              }
              title="LP capital"
              sub="What LPs are paid the funding and fees for"
              value={usd(stats.nav > 0n ? stats.nav : 0n)}
            />
            <ListRow
              icon={
                <Chip
                  tone={view.market.badDebt === 0n ? "positive" : "negative"}
                >
                  <Icon name={view.market.badDebt === 0n ? "check" : "alert"} />
                </Chip>
              }
              title="Socialised bad debt"
              sub={
                view.market.badDebt === 0n
                  ? "None recorded"
                  : "Recorded on-chain, never hidden"
              }
              value={usd(view.market.badDebt)}
            />
          </div>
        </Card>
      </div>
    </div>
  );
}
