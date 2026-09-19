//! Three ways a tokenized stock breaks infrastructure built for tokens.
//!
//!     cargo run --example stock_hazards
//!
//! Every number below comes from the real `arclis::math` functions the program
//! uses on-chain - nothing here is re-implemented for the demo. The "naive"
//! column is what a protocol built for continuously-traded tokens does when a
//! security is dropped into it.
//!
//! Needs only Rust. No validator, no wallet, no network.

use arclis::constants::*;
use arclis::math::corporate_actions::{
    advance_split_factor, rescale_price, rescale_size, SplitRatio,
};
use arclis::math::liquidity::{absorb_shortfall, net_trader_pnl, pool_nav, utilization_bps};
use arclis::math::pnl;
use arclis::math::session::{check_session, MarketSession, PriceUse};

const UNIT: i64 = BASE_SCALE as i64;
const DAY: i64 = 86_400;

fn usd(v: i128) -> String {
    let neg = v < 0;
    let a = v.abs();
    let whole = a / QUOTE_SCALE;
    let cents = (a % QUOTE_SCALE) / 10_000;
    format!("{}${}.{:02}", if neg { "-" } else { "" }, whole, cents)
}

fn price(p: u64) -> String {
    usd(i128::from(p))
}

fn rule(title: &str) {
    println!("\n\x1b[1m{}\x1b[0m", title);
    println!("{}", "-".repeat(title.len()));
}

fn main() {
    println!("\n\x1b[1mWhy a tokenized stock is not a token\x1b[0m");
    println!("Numbers produced by the same code that runs on-chain.");

    hazard_one_weekend();
    hazard_two_split();
    hazard_three_counterparty();

    println!(
        "\n\x1b[1mThe common thread\x1b[0m\n\
         Every DeFi primitive on Solana assumes four things: the asset trades\n\
         continuously, its price always exists, its supply is never restated,\n\
         and someone is on the other side. A stock violates all four.\n\n\
         None of these failures show up in a demo. They show up at 4pm on a\n\
         Friday, on an ex-date, or the first time a market goes one-way.\n"
    );
}

/// ---------------------------------------------------------------------------
/// 1. The market is shut for 81% of the week, and the price is frozen.
/// ---------------------------------------------------------------------------
fn hazard_one_weekend() {
    rule("1. The weekend free option");

    println!(
        "Friday 16:00. AAPL closes at {}. The perp trades all weekend; the\n\
         stock does not. By Sunday everyone knows where Monday opens - from\n\
         futures, from news, from every other market on earth.\n",
        price(250 * PRICE_SCALE as u64)
    );

    println!("  A naive protocol has one staleness setting, so it either:");
    println!("    - accepts the stale price   -> free option: buy Sunday, sell Monday");
    println!("    - rejects it                -> market shut 81% of the week, nobody can exit\n");

    println!("  Arclis asks what you want to *do* with the price:\n");

    let cases = [
        (
            MarketSession::Open,
            PriceUse::IncreaseRisk,
            "open a long, Tuesday 11:00",
        ),
        (
            MarketSession::Open,
            PriceUse::ReduceRisk,
            "close it, Tuesday 11:00",
        ),
        (
            MarketSession::Closed,
            PriceUse::IncreaseRisk,
            "open a long, Sunday",
        ),
        (
            MarketSession::Closed,
            PriceUse::ReduceRisk,
            "close it, Sunday",
        ),
        (
            MarketSession::Halted,
            PriceUse::ReduceRisk,
            "close during a halt",
        ),
    ];

    for (session, use_, label) in cases {
        let age = if session == MarketSession::Open {
            30
        } else {
            2 * DAY
        };
        let verdict = match check_session(session, use_, age) {
            Ok(()) => "\x1b[32mallowed\x1b[0m".to_string(),
            Err(e) => format!("\x1b[31mrefused\x1b[0m  ({e:?})"),
        };
        println!("    {label:<34} {verdict}");
    }

    println!(
        "\n  So the weekend is not a shutdown. You cannot take on new risk\n\
         \x20 against a frozen price, and you can always get out of what you hold."
    );
}

/// ---------------------------------------------------------------------------
/// 2. A 4-for-1 split looks exactly like a 75% crash.
/// ---------------------------------------------------------------------------
fn hazard_two_split() {
    rule("2. The split that liquidates everyone");

    let size = 10 * UNIT;
    let entry = 200 * PRICE_SCALE as u64;
    let collateral = 500 * QUOTE_SCALE as u64;

    println!(
        "A trader is long {} shares from {}, posting {} of margin.\n\
         Overnight, the company splits 4-for-1. The quoted price goes to {}.\n",
        size / UNIT,
        price(entry),
        usd(i128::from(collateral)),
        price(entry / 4)
    );

    // Naive: the oracle drops 75%, nothing else changes.
    let naive_pnl = pnl::unrealized_pnl(size, entry, entry / 4).unwrap();
    let naive_equity = i128::from(collateral) + naive_pnl;
    let naive_notional = pnl::notional(size, entry / 4).unwrap();
    let naive_margin = pnl::margin_ratio_bps(naive_equity, naive_notional).unwrap();

    println!("  Naive protocol - sees a price, does not know what a split is:");
    println!("    unrealised PnL   {}", usd(naive_pnl));
    println!("    equity           {}", usd(naive_equity));
    println!(
        "    margin ratio     {} bps   \x1b[31m<- wiped out and liquidated\x1b[0m",
        naive_margin
    );
    println!("    ...for a corporate action in which nobody lost a cent.\n");

    // Arclis: factor advances, position rescales, oracle rescales, atomically.
    let from = SPLIT_FACTOR_SCALE;
    let to = advance_split_factor(
        from,
        SplitRatio {
            numerator: 4,
            denominator: 1,
        },
    )
    .unwrap();
    let new_size = rescale_size(size, from, to).unwrap();
    let new_entry = rescale_price(entry, from, to).unwrap();
    let new_mark = rescale_price(entry, from, to).unwrap();

    let arclis_pnl = pnl::unrealized_pnl(new_size, new_entry, new_mark).unwrap();
    let arclis_equity = i128::from(collateral) + arclis_pnl;
    let arclis_notional = pnl::notional(new_size, new_mark).unwrap();
    let arclis_margin = pnl::margin_ratio_bps(arclis_equity, arclis_notional).unwrap();

    println!("  Arclis - oracle, open interest and funding index move together:");
    println!(
        "    position         {} shares @ {}  (was {} @ {})",
        new_size / UNIT,
        price(new_entry),
        size / UNIT,
        price(entry)
    );
    println!("    unrealised PnL   {}", usd(arclis_pnl));
    println!("    equity           {}", usd(arclis_equity));
    println!(
        "    margin ratio     {} bps   \x1b[32m<- unchanged, as it should be\x1b[0m",
        arclis_margin
    );
    println!(
        "    notional         {} -> {}  (identical)",
        usd(pnl::notional(size, entry).unwrap()),
        usd(arclis_notional)
    );

    println!(
        "\n  Solana cannot iterate accounts, so there is no way to walk every\n\
         \x20 position and rewrite it. Arclis stores a cumulative split factor\n\
         \x20 and each position rescales itself the next time it is touched -\n\
         \x20 provably identical to rewriting them all, and it rounds once\n\
         \x20 instead of once per split."
    );
}

/// ---------------------------------------------------------------------------
/// 3. Where does a winning trader's money actually come from?
/// ---------------------------------------------------------------------------
fn hazard_three_counterparty() {
    rule("3. The counterparty nobody funds");

    let oi_long = 100 * UNIT as u64;
    let entry = 250 * PRICE_SCALE as u64;
    let long_notional = u128::from(oi_long) * u128::from(entry);
    let mark = 275 * PRICE_SCALE as u64;

    let owed = net_trader_pnl(oi_long, long_notional, 0, 0, mark).unwrap();

    println!(
        "A one-sided market: {} shares long from {}, no shorts.\n\
         The stock rises to {}.\n",
        oi_long / UNIT as u64,
        price(entry),
        price(mark)
    );
    println!("  Traders are collectively up {}.", usd(owed));
    println!("  A cash-settled venue with no counterparty pays that out of the");
    println!("  vault - which holds other traders' deposits. \x1b[31mThat is not a");
    println!("  profit, it is someone else's collateral.\x1b[0m\n");

    let lp_capital = 50_000 * QUOTE_SCALE as u64;
    let nav = pool_nav(lp_capital, owed).unwrap();
    let exposure = pnl::notional(oi_long as i64, mark).unwrap();
    let util = utilization_bps(exposure, nav).unwrap();

    println!("  Arclis puts a liquidity pool on the other side:");
    println!("    LP capital       {}", usd(i128::from(lp_capital)));
    println!("    owed to traders  {}", usd(owed));
    println!("    pool NAV         {}", usd(nav));
    println!("    utilisation      {util} bps of NAV");
    println!(
        "    funding          amplified by utilisation, so the heavy side pays\n\
         \x20                    progressively more to whoever will take the other"
    );

    let shortfall = 8_000 * QUOTE_SCALE as u64;
    let split = absorb_shortfall(shortfall, 1_500 * QUOTE_SCALE as u64, nav);
    println!(
        "\n  And when a position blows through its margin - say {}:",
        usd(i128::from(shortfall))
    );
    println!(
        "    insurance absorbs   {}",
        usd(i128::from(split.from_insurance))
    );
    println!(
        "    LP capital absorbs  {}",
        usd(i128::from(split.from_pool))
    );
    println!(
        "    socialised          {}",
        usd(i128::from(split.socialized))
    );
    println!(
        "    \x1b[32mevery unit accounted for\x1b[0m - and the socialised part is recorded\n\
         \x20   on-chain rather than quietly eaten by whoever withdraws last."
    );
}
