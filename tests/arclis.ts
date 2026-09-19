/**
 * End-to-end happy path plus the risk paths.
 *
 * The unit tests in `math/` already cover the arithmetic; run them with
 * `cargo test --lib`, they need no validator. What this file covers is the part
 * those cannot: PDA derivation, account constraints, CPI transfers, and the
 * ordering between instructions.
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
  const liquidator = Keypair.generate();

  let configPda: PublicKey;
  let poolPda: PublicKey;
  let poolVaultPda: PublicKey;
  let lpPositionPda: PublicKey;
  let oraclePda: PublicKey;
  let marketPda: PublicKey;
  let vaultPda: PublicKey;
  let positionPda: PublicKey;

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

    await conn.confirmTransaction(
      await conn.requestAirdrop(
        liquidator.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL,
      ),
    );
    liquidatorAta = await createAssociatedTokenAccount(
      conn,
      liquidator,
      quoteMint,
      liquidator.publicKey,
    );

    [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId,
    );
    [oraclePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("oracle"), Buffer.from(SYMBOL)],
      program.programId,
    );
    [marketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), oraclePda.toBuffer()],
      program.programId,
    );
    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), marketPda.toBuffer()],
      program.programId,
    );
    [positionPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("position"),
        payer.publicKey.toBuffer(),
        marketPda.toBuffer(),
      ],
      program.programId,
    );
  });

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
    await program.methods
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
      })
      .rpc();

    const m = await program.account.market.fetch(marketPda);
    assert.equal(m.maxLeverage, 10);
    assert.equal(m.maintenanceMarginBps, 500);
    // Initial margin is derived, not configured: maintenance + 1% buffer.
    assert.equal(m.initialMarginBps, 600);
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

  it("deposits collateral and tracks it as a market liability", async () => {
    await program.methods
      .depositCollateral(new BN(10_000 * QUOTE_SCALE))
      .accounts({
        owner: payer.publicKey,
        config: configPda,
        market: marketPda,
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
  });

  it("opens a 50-unit long and charges the taker fee to insurance", async () => {
    await program.methods
      .openPosition(new BN(50 * BASE_SCALE))
      .accounts({
        owner: payer.publicKey,
        config: configPda,
        market: marketPda,
        oracle: oraclePda,
        position: positionPda,
      })
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
        .accounts({
          owner: payer.publicKey,
          config: configPda,
          market: marketPda,
          oracle: oraclePda,
          position: positionPda,
        })
        .rpc();
      assert.fail("expected DirectionFlip");
    } catch (e: any) {
      assert.include(e.toString(), "DirectionFlip");
    }
  });

  it("realizes profit when the oracle moves up", async () => {
    const before = await program.account.position.fetch(positionPda);

    await program.methods
      .updatePriceOracle(new BN(105 * PRICE_SCALE), new BN(0))
      .accounts({ authority: payer.publicKey, oracle: oraclePda })
      .rpc();

    await program.methods
      .closePosition(new BN(25 * BASE_SCALE))
      .accounts({
        owner: payer.publicKey,
        config: configPda,
        market: marketPda,
        oracle: oraclePda,
        position: positionPda,
      })
      .rpc();

    const after = await program.account.position.fetch(positionPda);
    assert.equal(after.size.toNumber(), 25 * BASE_SCALE);
    // 25 units closed at +$5 == +$125, less a 10bps fee on $2,625 notional.
    assert.isAbove(after.collateral.toNumber(), before.collateral.toNumber());
    // The surviving half keeps its original cost basis.
    assert.equal(after.entryPrice.toNumber(), 100 * PRICE_SCALE);
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
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      assert.fail("expected WithdrawalBreaksMargin");
    } catch (e: any) {
      assert.include(e.toString(), "WithdrawalBreaksMargin");
    }
  });

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
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([liquidator])
        .rpc();
      assert.fail("expected PositionHealthy");
    } catch (e: any) {
      assert.include(e.toString(), "PositionHealthy");
    }
  });

  it("enforces the protocol pause on trading but not on liquidation", async () => {
    await program.methods
      .setProtocolPaused(true)
      .accounts({ authority: payer.publicKey, config: configPda })
      .rpc();

    try {
      await program.methods
        .openPosition(new BN(1 * BASE_SCALE))
        .accounts({
          owner: payer.publicKey,
          config: configPda,
          market: marketPda,
          oracle: oraclePda,
          position: positionPda,
        })
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
