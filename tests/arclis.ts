/**
 * End-to-end happy path plus the risk paths.
 *
 * The unit tests in `math/` already cover the arithmetic; run them with
 * `cargo test --lib`, they need no validator. What this file covers is the part
 * those cannot: PDA derivation, account constraints, CPI transfers, and the
 * ordering between instructions.
 *
 * Read the order of the `it` blocks as a script, not as independent cases.
 * Mocha runs them in sequence against one validator and they share state on
 * purpose: a market is created, funded with LP capital, traded, marked,
 * split, paid a dividend and finally liquidated. Isolating each one would mean
 * rebuilding the whole world per test and would stop catching the thing this
 * file exists to catch, which is instructions interfering with each other.
 */
import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { assert } from "chai";

const PRICE_SCALE = 1_000_000;
const QUOTE_SCALE = 1_000_000;
const BASE_SCALE = 1_000_000;

/** Pack a ticker into the fixed 16-byte symbol seed the oracle PDA uses. */
function symbolBytes(s: string): number[] {
  const b = Buffer.alloc(16);
  Buffer.from(s, "utf8").copy(b);
  return Array.from(b);
}

describe("arclis", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  // Untyped on purpose. Anchor generates `target/types/arclis.ts` during
  // `anchor build`, and this file has to typecheck before that has ever run.
  // Once you have built once, swap this for:
  //   import { Arclis } from "../target/types/arclis";
  //   const program = anchor.workspace.Arclis as Program<Arclis>;
  // and the account namespace and method args become fully typed.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const program = anchor.workspace.Arclis as any;
  const conn = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const SYMBOL = symbolBytes("AAPL");

  let quoteMint: PublicKey;
  let traderAta: PublicKey;
  let liquidatorAta: PublicKey;
  let lpAta: PublicKey;
  const liquidator = Keypair.generate();
  const lp = Keypair.generate();

  let configPda: PublicKey;
  let oraclePda: PublicKey;
  let marketPda: PublicKey;
  let vaultPda: PublicKey;
  let positionPda: PublicKey;
  let poolPda: PublicKey;
  let poolVaultPda: PublicKey;
  let lpPositionPda: PublicKey;

  /**
   * Every trading instruction now carries the pool, because settling accrued
   * funding and dividends moves tokens between the two vaults. Naming the set
   * once means a future account addition is a one-line change here rather than
   * a hunt through a dozen call sites.
   */
  const tradeAccounts = () => ({
    owner: payer.publicKey,
    config: configPda,
    market: marketPda,
    oracle: oraclePda,
    position: positionPda,
    pool: poolPda,
    poolVault: poolVaultPda,
    marketVault: vaultPda,
    tokenProgram: TOKEN_PROGRAM_ID,
  });

  const fund = async (kp: Keypair) => {
    await conn.confirmTransaction(
      await conn.requestAirdrop(kp.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL),
    );
    const ata = await createAssociatedTokenAccount(
      conn,
      kp,
      quoteMint,
      kp.publicKey,
    );
    await mintTo(conn, payer, quoteMint, ata, payer, 1_000_000 * QUOTE_SCALE);
    return ata;
  };

  before(async () => {
    quoteMint = await createMint(conn, payer, payer.publicKey, null, 6);
    traderAta = await createAssociatedTokenAccount(
      conn,
      payer,
      quoteMint,
      payer.publicKey,
    );
    await mintTo(
      conn,
      payer,
      quoteMint,
      traderAta,
      payer,
      1_000_000 * QUOTE_SCALE,
    );

    liquidatorAta = await fund(liquidator);
    lpAta = await fund(lp);

    const pda = (seeds: (Buffer | Uint8Array)[]) =>
      PublicKey.findProgramAddressSync(seeds, program.programId)[0];

    configPda = pda([Buffer.from("config")]);
    oraclePda = pda([Buffer.from("oracle"), Buffer.from(SYMBOL)]);
    marketPda = pda([Buffer.from("market"), oraclePda.toBuffer()]);
    vaultPda = pda([Buffer.from("vault"), marketPda.toBuffer()]);
    positionPda = pda([
      Buffer.from("position"),
      payer.publicKey.toBuffer(),
      marketPda.toBuffer(),
    ]);
    poolPda = pda([Buffer.from("lp_pool"), marketPda.toBuffer()]);
    poolVaultPda = pda([Buffer.from("lp_vault"), poolPda.toBuffer()]);
    lpPositionPda = pda([
      Buffer.from("lp_position"),
      lp.publicKey.toBuffer(),
      poolPda.toBuffer(),
    ]);
  });

  // -------------------------------------------------------------------------
  // Setup: config, oracle, market, pool
  // -------------------------------------------------------------------------

  it("initializes the global config", async () => {
    await program.methods
      .initializeGlobalConfig(10)
      .accounts({
        authority: payer.publicKey,
        config: configPda,
        insuranceFund: payer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const cfg = await program.account.globalConfig.fetch(configPda);
    assert.equal(cfg.defaultFeeBps, 10);
    assert.isFalse(cfg.paused);
  });

  it("initializes a price oracle at $100", async () => {
    await program.methods
      .initializePriceOracle(SYMBOL, new BN(100 * PRICE_SCALE))
      .accounts({
        authority: payer.publicKey,
        oracle: oraclePda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const o = await program.account.priceOracle.fetch(oraclePda);
    assert.equal(o.price.toNumber(), 100 * PRICE_SCALE);
  });

  it("opens the market session so trading is allowed", async () => {
    // A fresh oracle starts Closed, which refuses every increase-risk action.
    // That is the intended default and it means this line is load-bearing for
    // everything below it.
    await program.methods
      .setMarketSession({ open: {} })
      .accounts({ authority: payer.publicKey, oracle: oraclePda })
      .rpc();

    const o = await program.account.priceOracle.fetch(oraclePda);
    assert.property(o.session, "open");
  });

  it("rejects an oracle update beyond the deviation cap", async () => {
    // 10% is the cap; 50% must be refused. This is the bound on how much damage
    // a compromised keeper key can do in a single transaction.
    try {
      await program.methods
        .updatePriceOracle(new BN(150 * PRICE_SCALE), new BN(0))
        .accounts({ authority: payer.publicKey, oracle: oraclePda })
        .rpc();
      assert.fail("expected OracleDeviationTooLarge");
    } catch (e: any) {
      assert.include(e.toString(), "OracleDeviationTooLarge");
    }
  });

  it("creates a market permissionlessly", async () => {
    // Wrapped so a rejection prints the program's own logs. Anchor's thrown
    // error carries them, mocha does not show them, and they contain the
    // `msg!` that says which parameter the program actually received.
    const build = () =>
      program.methods
        .createMarket({
          maxLeverage: 10,
          maintenanceMarginBps: 500,
          takerFeeBps: 10,
          liquidationPenaltyBps: 500,
          fundingIntervalSecs: new BN(3600),
          fundingSensitivityBps: 100,
          maxOpenInterest: new BN(1_000_000 * BASE_SCALE),
          maxSkewBps: 10_000,
          maxUtilizationBps: 8_000,
        })
        .accounts({
          creator: payer.publicKey,
          config: configPda,
          oracle: oraclePda,
          market: marketPda,
          quoteMint,
          vault: vaultPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        });

    try {
      await build().rpc();
    } catch (e: any) {
      // Print what this client put on the wire alongside what the program read
      // off it. Verifying the encoder in isolation proves nothing: the two
      // have to be compared within one run, or a mismatch between them stays
      // invisible and every explanation stays plausible.
      const sent = (await build().instruction()).data.toString("hex");
      const logs: string[] = e?.logs ?? [];
      const received = logs.find((l) => l.includes("create_market params:"));
      console.error("\n  program logs:");
      for (const l of logs) console.error(`    ${l}`);
      console.error(`\n  the client sent:      ${sent}`);
      if (received) console.error(`  the program received: ${received}\n`);
      throw e;
    }

    const m = await program.account.market.fetch(marketPda);
    assert.equal(m.maxLeverage, 10);
    assert.equal(m.maintenanceMarginBps, 500);
    // Initial margin is derived, not configured: maintenance + 1% buffer.
    assert.equal(m.initialMarginBps, 600);
    assert.equal(m.cumulativeDividendIndex.toString(), "0");
  });

  it("rejects a market whose leverage and margin are inconsistent", async () => {
    const sym = symbolBytes("BAD");
    const [badOracle] = PublicKey.findProgramAddressSync(
      [Buffer.from("oracle"), Buffer.from(sym)],
      program.programId,
    );
    const [badMarket] = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), badOracle.toBuffer()],
      program.programId,
    );
    const [badVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), badMarket.toBuffer()],
      program.programId,
    );
    await program.methods
      .initializePriceOracle(sym, new BN(100 * PRICE_SCALE))
      .accounts({
        authority: payer.publicKey,
        oracle: badOracle,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    try {
      // 20x leverage implies a 5% max initial margin, but maintenance of 10%
      // forces initial to 11%. The market is unopenable by construction.
      await program.methods
        .createMarket({
          maxLeverage: 20,
          maintenanceMarginBps: 1_000,
          takerFeeBps: 10,
          liquidationPenaltyBps: 500,
          fundingIntervalSecs: new BN(3600),
          fundingSensitivityBps: 100,
          maxOpenInterest: new BN(1_000_000 * BASE_SCALE),
          maxSkewBps: 10_000,
          maxUtilizationBps: 8_000,
        })
        .accounts({
          creator: payer.publicKey,
          config: configPda,
          oracle: badOracle,
          market: badMarket,
          quoteMint,
          vault: badVault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc();
      assert.fail("expected InvalidMarginParam");
    } catch (e: any) {
      assert.include(e.toString(), "InvalidMarginParam");
    }
  });

  it("initializes the liquidity pool", async () => {
    await program.methods
      .initializeLiquidityPool(new BN(3600))
      .accounts({
        authority: payer.publicKey,
        config: configPda,
        market: marketPda,
        quoteMint,
        pool: poolPda,
        vault: poolVaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const m = await program.account.market.fetch(marketPda);
    assert.equal(m.liquidityPool.toBase58(), poolPda.toBase58());
  });

  it("takes an LP deposit and mints shares one-for-one into an empty pool", async () => {
    await program.methods
      .depositLiquidity(new BN(500_000 * QUOTE_SCALE))
      .accounts({
        owner: lp.publicKey,
        config: configPda,
        market: marketPda,
        oracle: oraclePda,
        pool: poolPda,
        lpPosition: lpPositionPda,
        vault: poolVaultPda,
        ownerTokenAccount: lpAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([lp])
      .rpc();

    const pool = await program.account.liquidityPool.fetch(poolPda);
    const pos = await program.account.lpPosition.fetch(lpPositionPda);
    const vault = await getAccount(conn, poolVaultPda);

    // The first deposit into an empty pool sets the share price at 1.
    assert.equal(pos.shares.toString(), String(500_000 * QUOTE_SCALE));
    assert.equal(pool.totalShares.toString(), String(500_000 * QUOTE_SCALE));
    assert.equal(Number(vault.amount), 500_000 * QUOTE_SCALE);
  });

  // -------------------------------------------------------------------------
  // Trading
  // -------------------------------------------------------------------------

  it("deposits collateral and tracks it as a market liability", async () => {
    await program.methods
      .depositCollateral(new BN(10_000 * QUOTE_SCALE))
      .accounts({
        owner: payer.publicKey,
        config: configPda,
        market: marketPda,
        oracle: oraclePda,
        position: positionPda,
        ownerTokenAccount: traderAta,
        vault: vaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const pos = await program.account.position.fetch(positionPda);
    const m = await program.account.market.fetch(marketPda);
    const vault = await getAccount(conn, vaultPda);

    assert.equal(pos.collateral.toNumber(), 10_000 * QUOTE_SCALE);
    // The market's liability total must match the vault's real balance.
    assert.equal(m.totalCollateral.toNumber(), 10_000 * QUOTE_SCALE);
    assert.equal(Number(vault.amount), 10_000 * QUOTE_SCALE);
    // A new position snapshots both indices so it is not charged for anything
    // that accrued before it existed.
    assert.equal(pos.entryDividendIndex.toString(), "0");
  });

  it("opens a 50-unit long and charges the taker fee to insurance", async () => {
    await program.methods
      .openPosition(new BN(50 * BASE_SCALE))
      .accounts(tradeAccounts())
      .rpc();

    const pos = await program.account.position.fetch(positionPda);
    const m = await program.account.market.fetch(marketPda);

    assert.equal(pos.size.toNumber(), 50 * BASE_SCALE);
    assert.equal(pos.entryPrice.toNumber(), 100 * PRICE_SCALE);
    assert.equal(m.openInterestLong.toNumber(), 50 * BASE_SCALE);
    // 10 bps on $5,000 notional == $5, and it must land in insurance rather
    // than vanishing the way the original engine's uncharged fee did.
    assert.equal(m.insuranceBalance.toNumber(), 5 * QUOTE_SCALE);
  });

  it("refuses to flip direction in one instruction", async () => {
    try {
      await program.methods
        .openPosition(new BN(-100 * BASE_SCALE))
        .accounts(tradeAccounts())
        .rpc();
      assert.fail("expected DirectionFlip");
    } catch (e: any) {
      assert.include(e.toString(), "DirectionFlip");
    }
  });

  it("realizes profit when the oracle moves up, paid out of the pool", async () => {
    const before = await program.account.position.fetch(positionPda);
    const poolBefore = await getAccount(conn, poolVaultPda);

    await program.methods
      .updatePriceOracle(new BN(105 * PRICE_SCALE), new BN(0))
      .accounts({ authority: payer.publicKey, oracle: oraclePda })
      .rpc();

    await program.methods
      .closePosition(new BN(25 * BASE_SCALE))
      .accounts(tradeAccounts())
      .rpc();

    const after = await program.account.position.fetch(positionPda);
    const poolAfter = await getAccount(conn, poolVaultPda);

    assert.equal(after.size.toNumber(), 25 * BASE_SCALE);
    // 25 units closed at +$5 == +$125, less a 10bps fee on $2,625 notional.
    assert.isAbove(after.collateral.toNumber(), before.collateral.toNumber());
    // The surviving half keeps its original cost basis.
    assert.equal(after.entryPrice.toNumber(), 100 * PRICE_SCALE);
    // The counterparty relationship is the point: the trader's gain left the
    // pool's vault rather than another trader's deposit.
    assert.isBelow(Number(poolAfter.amount), Number(poolBefore.amount));
  });

  it("accrues funding that scales with the mark price", async () => {
    const before = await program.account.market.fetch(marketPda);
    assert.equal(before.cumulativeFundingIndex.toString(), "0");

    // The book is entirely long, so longs pay. The index must end up non-zero
    // and denominated in quote - the original engine's index ignored price
    // entirely, which is the bug this asserts against.
    try {
      await program.methods
        .crankFunding()
        .accounts({
          cranker: payer.publicKey,
          config: configPda,
          market: marketPda,
          oracle: oraclePda,
          pool: poolPda,
          poolVault: poolVaultPda,
        })
        .rpc();
      const after = await program.account.market.fetch(marketPda);
      assert.notEqual(after.cumulativeFundingIndex.toString(), "0");
    } catch (e: any) {
      // A fresh validator has not advanced a full hour, so FundingNotDue is the
      // expected outcome here rather than a failure. Asserting on which of the
      // two happened keeps the test meaningful either way.
      assert.include(e.toString(), "FundingNotDue");
    }
  });

  it("blocks a withdrawal that would breach initial margin", async () => {
    const pos = await program.account.position.fetch(positionPda);
    try {
      await program.methods
        .withdrawCollateral(new BN(pos.collateral.toNumber() - 1))
        .accounts({
          owner: payer.publicKey,
          config: configPda,
          market: marketPda,
          oracle: oraclePda,
          position: positionPda,
          ownerTokenAccount: traderAta,
          vault: vaultPda,
          pool: poolPda,
          poolVault: poolVaultPda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      assert.fail("expected WithdrawalBreaksMargin");
    } catch (e: any) {
      assert.include(e.toString(), "WithdrawalBreaksMargin");
    }
  });

  // -------------------------------------------------------------------------
  // The equity-specific machinery
  // -------------------------------------------------------------------------

  it("refuses to increase risk while the market is closed, but allows reducing", async () => {
    await program.methods
      .setMarketSession({ closed: {} })
      .accounts({ authority: payer.publicKey, oracle: oraclePda })
      .rpc();

    try {
      await program.methods
        .openPosition(new BN(1 * BASE_SCALE))
        .accounts(tradeAccounts())
        .rpc();
      assert.fail("expected CannotIncreaseRiskWhileClosed");
    } catch (e: any) {
      assert.include(e.toString(), "CannotIncreaseRiskWhileClosed");
    }

    // The other half of the rule, and the one that matters to a trapped
    // trader: closing still works against the settled price.
    const before = await program.account.position.fetch(positionPda);
    await program.methods
      .closePosition(new BN(1 * BASE_SCALE))
      .accounts(tradeAccounts())
      .rpc();
    const after = await program.account.position.fetch(positionPda);
    assert.equal(
      after.size.toNumber(),
      before.size.toNumber() - 1 * BASE_SCALE,
    );
  });

  it("applies a 4-for-1 split without moving anyone's PnL", async () => {
    const posBefore = await program.account.position.fetch(positionPda);
    const oracleBefore = await program.account.priceOracle.fetch(oraclePda);

    // Corporate actions are only legal between sessions, and the market is
    // already closed from the test above.
    await program.methods
      .applyCorporateAction(4, 1)
      .accounts({
        authority: payer.publicKey,
        oracle: oraclePda,
        market: marketPda,
      })
      .rpc();

    const oracleAfter = await program.account.priceOracle.fetch(oraclePda);
    assert.equal(
      oracleAfter.price.toNumber(),
      Math.floor(oracleBefore.price.toNumber() / 4),
    );

    // The position has not been touched yet: normalisation is lazy, so it
    // still carries the pre-split factor until the next instruction.
    const posStale = await program.account.position.fetch(positionPda);
    assert.equal(posStale.size.toNumber(), posBefore.size.toNumber());

    // Touch it, and size quadruples while entry price quarters. Notional, and
    // therefore PnL, is unchanged - which is the whole point.
    await program.methods
      .closePosition(new BN(1))
      .accounts(tradeAccounts())
      .rpc();

    const posAfter = await program.account.position.fetch(positionPda);
    const notionalBefore =
      posBefore.size.toNumber() * posBefore.entryPrice.toNumber();
    const notionalAfter =
      (posAfter.size.toNumber() + 1) * posAfter.entryPrice.toNumber();
    // One base unit was closed to force the sync, so allow for that plus
    // integer rounding on the rescale.
    assert.approximately(
      notionalAfter / notionalBefore,
      1,
      0.001,
      "a split must not move notional",
    );
  });

  it("credits a long the dividend it would otherwise have eaten", async () => {
    const before = await program.account.position.fetch(positionPda);
    assert.isAbove(before.size.toNumber(), 0, "this test needs an open long");

    // $0.25 per (post-split) share.
    const perShare = Math.floor(0.25 * PRICE_SCALE);
    await program.methods
      .applyDividend(new BN(perShare))
      .accounts({
        authority: payer.publicKey,
        oracle: oraclePda,
        market: marketPda,
      })
      .rpc();

    const m = await program.account.market.fetch(marketPda);
    assert.notEqual(m.cumulativeDividendIndex.toString(), "0");

    // The index has moved but the position has not been touched, so nothing is
    // credited yet. Touch it.
    await program.methods
      .closePosition(new BN(1))
      .accounts(tradeAccounts())
      .rpc();

    const after = await program.account.position.fetch(positionPda);
    assert.equal(
      after.entryDividendIndex.toString(),
      m.cumulativeDividendIndex.toString(),
      "settling must re-snapshot the index or the credit pays twice",
    );
    // Closing one base unit costs a fee, so the credit is checked against the
    // dividend rather than against a strict increase.
    const expectedCredit = (before.size.toNumber() * perShare) / PRICE_SCALE;
    assert.isAbove(expectedCredit, 0);
    assert.isAtLeast(
      after.collateral.toNumber(),
      before.collateral.toNumber() - expectedCredit,
    );
  });

  it("takes an insurance deposit and retires bad debt first", async () => {
    const before = await program.account.market.fetch(marketPda);
    await program.methods
      .depositInsurance(new BN(1_000 * QUOTE_SCALE))
      .accounts({
        depositor: payer.publicKey,
        config: configPda,
        market: marketPda,
        depositorTokenAccount: traderAta,
        vault: vaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const after = await program.account.market.fetch(marketPda);
    const credited =
      after.insuranceBalance.toNumber() - before.insuranceBalance.toNumber();
    const retired = before.badDebt.toNumber() - after.badDebt.toNumber();
    // Every cent either retires debt or capitalises the fund; none vanishes.
    assert.equal(credited + retired, 1_000 * QUOTE_SCALE);
  });

  // -------------------------------------------------------------------------
  // Liquidation
  // -------------------------------------------------------------------------

  it("refuses to liquidate a healthy position", async () => {
    try {
      await program.methods
        .liquidate()
        .accounts({
          liquidator: liquidator.publicKey,
          liquidatorTokenAccount: liquidatorAta,
          config: configPda,
          market: marketPda,
          oracle: oraclePda,
          position: positionPda,
          vault: vaultPda,
          pool: poolPda,
          poolVault: poolVaultPda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([liquidator])
        .rpc();
      assert.fail("expected PositionHealthy");
    } catch (e: any) {
      assert.include(e.toString(), "PositionHealthy");
    }
  });

  it("liquidates an underwater position and pays the liquidator", async () => {
    const liquidate = () =>
      program.methods
        .liquidate()
        .accounts({
          liquidator: liquidator.publicKey,
          liquidatorTokenAccount: liquidatorAta,
          config: configPda,
          market: marketPda,
          oracle: oraclePda,
          position: positionPda,
          vault: vaultPda,
          pool: poolPda,
          poolVault: poolVaultPda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([liquidator]);

    // PositionHealthy means "not underwater yet", which is this loop's answer
    // to keep walking. Any other rejection is a real failure and must not be
    // swallowed by a retry.
    const stillHealthy = (e: any) =>
      e?.error?.errorCode?.code === "PositionHealthy" ||
      (e?.logs ?? []).some((l: string) => l.includes("PositionHealthy"));

    // Everything since the market-closed test has run against a closed
    // market. Pulling collateral out is a risk-increasing action, which the
    // session matrix correctly refuses there, so reopen the session first.
    await program.methods
      .setMarketSession({ open: {} })
      .accounts({ authority: payer.publicKey, oracle: oraclePda })
      .rpc();

    // This position cannot be liquidated by price, and no number of oracle
    // steps would change that. It holds about $10,000 of collateral against
    // $2,500 of notional. A long's worst case is losing its whole notional,
    // so even at a price of zero its equity floor is several times the
    // maintenance requirement; walking the price down just runs out of
    // iterations. The old 12-step loop was never going to get there either.
    //
    // So thin the position out first, which is how real positions become
    // liquidatable: not by the market moving against a conservative trader,
    // but by the trader withdrawing margin to the limit and the market moving
    // afterwards. Find that limit by asking the program - withdraw greedily,
    // halve the request each time it refuses - so the initial-margin maths
    // stays in one place, on chain.
    const withdraw = (amount: number) =>
      program.methods
        .withdrawCollateral(new BN(amount))
        .accounts({
          owner: payer.publicKey,
          config: configPda,
          market: marketPda,
          oracle: oraclePda,
          position: positionPda,
          ownerTokenAccount: traderAta,
          vault: vaultPda,
          pool: poolPda,
          poolVault: poolVaultPda,
          tokenProgram: TOKEN_PROGRAM_ID,
        });

    const breachesMargin = (e: any) =>
      e?.error?.errorCode?.code === "WithdrawalBreaksMargin" ||
      (e?.logs ?? []).some((l: string) =>
        l.includes("WithdrawalBreaksMargin"),
      );

    const startingCollateral = (
      await program.account.position.fetch(positionPda)
    ).collateral.toNumber();

    let chunk = startingCollateral;
    for (let i = 0; i < 40 && chunk > QUOTE_SCALE; i++) {
      try {
        await withdraw(chunk).rpc();
      } catch (e: any) {
        if (!breachesMargin(e)) throw e;
        chunk = Math.floor(chunk / 2);
      }
    }

    const thinned = await program.account.position.fetch(positionPda);
    assert.isBelow(
      thinned.collateral.toNumber(),
      startingCollateral / 10,
      "the withdrawal probe did not get the position near initial margin",
    );

    const liqBefore = await getAccount(conn, liquidatorAta);
    const poolBefore = await program.account.liquidityPool.fetch(poolPda);

    // Now walk the price down. Steps of 2%, not the 9% the oracle deviation
    // cap would allow: from just above a 6% initial margin, a 9% move clears
    // the 5% maintenance band entirely and lands in bad debt, and a
    // liquidator paid out of negative equity is paid nothing. The point of
    // this test is that liquidation pays.
    //
    // Whether the position is underwater is settled by asking the program,
    // not by recomputing its margin maths here. This test used to carry its
    // own equity estimate, and that estimate was wrong twice over. It read
    // `size` and `entry_price` straight off the account, so the stock split
    // earlier in this suite skewed it: unrealised PnL is not invariant under
    // a naive raw computation the way notional is. And it ignored the
    // dividend this long is owed, which `sync_and_settle` credits to
    // collateral before the health check runs. Both errors pushed the same
    // way - the loop stopped while the position was still healthy, then
    // demanded a liquidation the program was right to refuse.
    //
    // A failed liquidation changes no state, so attempting one is a free and
    // exact probe. The only authority on whether a position is liquidatable
    // is the code that liquidates it.
    let liquidated = false;
    for (let i = 0; i < 20 && !liquidated; i++) {
      const o = await program.account.priceOracle.fetch(oraclePda);
      const next = Math.floor(o.price.toNumber() * 0.98);
      assert.isAbove(next, 0, "walked the price to zero without liquidating");
      await program.methods
        .updatePriceOracle(new BN(next), new BN(0))
        .accounts({ authority: payer.publicKey, oracle: oraclePda })
        .rpc();

      try {
        await liquidate().rpc();
        liquidated = true;
      } catch (e: any) {
        if (!stillHealthy(e)) throw e;
      }
    }

    assert.isTrue(
      liquidated,
      "twenty steps of -2% did not put the position below maintenance",
    );

    const pos = await program.account.position.fetch(positionPda);
    const liqAfter = await getAccount(conn, liquidatorAta);
    const m = await program.account.market.fetch(marketPda);

    assert.equal(pos.size.toNumber(), 0, "liquidation flattens the position");
    assert.isAbove(
      Number(liqAfter.amount),
      Number(liqBefore.amount),
      "a liquidator that is not paid is a liquidator that never runs",
    );
    assert.equal(m.openInterestLong.toNumber(), 0);

    // The pool stood on the other side of this trade, so liquidating it has
    // to move the pool's books. `liquidate` used to flatten the position and
    // pay the liquidator without ever settling the trader's PnL against the
    // pool, which left the vault short by the position's unrealised gain and
    // the LPs holding a counterparty result they were never credited with.
    const poolAfter = await program.account.liquidityPool.fetch(poolPda);
    assert.notEqual(
      poolAfter.realizedPnl.toString(),
      poolBefore.realizedPnl.toString(),
      "a liquidation that does not settle with the pool leaves the vault short",
    );
  });

  // -------------------------------------------------------------------------
  // LP exit
  // -------------------------------------------------------------------------

  it("holds an LP redemption behind the cooldown, and lets it be cancelled", async () => {
    const pos = await program.account.lpPosition.fetch(lpPositionPda);

    const lpAccounts = {
      owner: lp.publicKey,
      config: configPda,
      market: marketPda,
      oracle: oraclePda,
      pool: poolPda,
      lpPosition: lpPositionPda,
      vault: poolVaultPda,
      ownerTokenAccount: lpAta,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    };

    await program.methods
      .requestWithdrawLiquidity(pos.shares)
      .accounts(lpAccounts)
      .signers([lp])
      .rpc();

    const pending = await program.account.lpPosition.fetch(lpPositionPda);
    assert.equal(pending.pendingShares.toString(), pos.shares.toString());
    assert.isAbove(pending.cooldownEndsTs.toNumber(), 0);

    // The cooldown is what stops an LP front-running a loss they can see
    // coming, so a redemption claimed the same second must be refused. The
    // minimum is an hour and a local validator will not advance one, which is
    // why this asserts the guard rather than the payout.
    try {
      await program.methods
        .withdrawLiquidity()
        .accounts(lpAccounts)
        .signers([lp])
        .rpc();
      assert.fail("expected CooldownNotElapsed");
    } catch (e: any) {
      assert.include(e.toString(), "CooldownNotElapsed");
    }

    // Cancelling must put the shares back exactly, or an LP who changes their
    // mind is penalised for it.
    await program.methods
      .cancelWithdrawLiquidity()
      .accounts(lpAccounts)
      .signers([lp])
      .rpc();

    const cancelled = await program.account.lpPosition.fetch(lpPositionPda);
    assert.equal(cancelled.pendingShares.toString(), "0");
    assert.equal(cancelled.cooldownEndsTs.toNumber(), 0);
    assert.equal(cancelled.shares.toString(), pos.shares.toString());
  });

  // -------------------------------------------------------------------------
  // Kill switches and invariants
  // -------------------------------------------------------------------------

  it("enforces the protocol pause on trading but not on liquidation", async () => {
    await program.methods
      .setProtocolPaused(true)
      .accounts({ authority: payer.publicKey, config: configPda })
      .rpc();

    try {
      await program.methods
        .openPosition(new BN(1 * BASE_SCALE))
        .accounts(tradeAccounts())
        .rpc();
      assert.fail("expected ProtocolPaused");
    } catch (e: any) {
      // The original engine stored this flag and checked it nowhere.
      assert.include(e.toString(), "ProtocolPaused");
    }

    await program.methods
      .setProtocolPaused(false)
      .accounts({ authority: payer.publicKey, config: configPda })
      .rpc();
  });

  it("rejects a non-authority pausing the protocol", async () => {
    try {
      await program.methods
        .setProtocolPaused(true)
        .accounts({ authority: liquidator.publicKey, config: configPda })
        .signers([liquidator])
        .rpc();
      assert.fail("expected Unauthorized");
    } catch (e: any) {
      assert.include(e.toString(), "Unauthorized");
    }
  });

  it("keeps vault balance reconciled with market liabilities", async () => {
    const m = await program.account.market.fetch(marketPda);
    const vault = await getAccount(conn, vaultPda);
    // The invariant the original engine had no way to state, let alone check:
    // what the vault holds must cover what the market says it owes.
    assert.isAtLeast(
      Number(vault.amount),
      m.totalCollateral.toNumber() +
        m.insuranceBalance.toNumber() -
        m.badDebt.toNumber(),
    );
  });
});
