import { expect } from "chai";
import { setupChallengeFixture, makeParams, STATUS } from "./utils.js";

// Antibody bond at severity 60 (unprotected): base + base*60/100 = 1.6 USDC.
const ANTIBODY_BOND = 1_600_000n;
const MIN_CHALLENGE_BOND = 5_000_000n; // default floor (> scaled bond here)

describe("ChallengeManager", function () {
  let env: any;
  let id: string;

  async function publish(matcher: string) {
    const { registry, ethers, alice } = env;
    const p = makeParams(ethers, { primaryMatcherHash: matcher });
    const [pid] = await registry.connect(alice).publish.staticCall(p);
    await registry.connect(alice).publish(p);
    return pid;
  }

  beforeEach(async function () {
    env = await setupChallengeFixture();
    id = await publish(env.ethers.id("threat"));
  });

  describe("challenge", function () {
    it("locks a scaled bond, flips the antibody to CHALLENGED, emits VerdictRequested", async function () {
      const { manager, registry, usdc, challenger } = env;
      await expect(manager.connect(challenger).challenge(id)).to.emit(manager, "VerdictRequested");

      const c = await manager.getChallenge(id);
      expect(c.challenger).to.equal(challenger.address);
      expect(c.bond).to.equal(MIN_CHALLENGE_BOND); // floor dominates the 1.6 USDC scaled bond
      expect(await usdc.balanceOf(await manager.getAddress())).to.equal(MIN_CHALLENGE_BOND);
      expect((await registry.getAntibody(id)).status).to.equal(STATUS.CHALLENGED);
    });

    it("rejects a second concurrent challenge", async function () {
      const { manager, challenger } = env;
      await manager.connect(challenger).challenge(id);
      await expect(manager.connect(challenger).challenge(id)).to.be.revertedWithCustomError(
        manager,
        "ChallengeAlreadyOpen",
      );
    });
  });

  describe("verdict gating", function () {
    it("submitLayer1Verdict is CRE-receiver-only", async function () {
      const { manager, challenger } = env;
      await manager.connect(challenger).challenge(id);
      await expect(
        manager.connect(challenger).submitLayer1Verdict(id, 3, 0),
      ).to.be.revertedWithCustomError(manager, "NotCreReceiver");
    });

    it("submitLayer2Verdict is VerifierPool-only", async function () {
      const { manager, challenger } = env;
      await manager.connect(challenger).challenge(id);
      await expect(
        manager.connect(challenger).submitLayer2Verdict(id, true),
      ).to.be.revertedWithCustomError(manager, "NotVerifierPool");
    });
  });

  describe("Layer-1 economics", function () {
    let cre: any;
    beforeEach(async function () {
      // Drive Layer-1 verdicts directly by pointing creReceiver at an EOA.
      cre = env.bob;
      await env.manager.setCreReceiver(cre.address);
      await env.manager.connect(env.challenger).challenge(id);
    });

    it("INVALID: slashes the antibody and splits the forfeited pool", async function () {
      const { manager, registry, reputation, usdc, alice, challenger } = env;
      const challengerStart = await usdc.balanceOf(challenger.address);

      await expect(manager.connect(cre).submitLayer1Verdict(id, 3, 0)).to.emit(manager, "Resolved");

      // antibody slashed, matcher cleared, reputation slashed
      expect((await registry.getAntibody(id)).status).to.equal(STATUS.SLASHED);
      expect((await reputation.getPublisher(alice.address)).slashedCount).to.equal(1n);
      expect((await registry.getAntibodiesByMatcher(env.ethers.id("threat"))).length).to.equal(0);

      // forfeited = antibody bond (escrow 0). bounty = 40%; treasury = juror(30%)+layer1(10%)+remainder(20%)
      const forfeited = ANTIBODY_BOND;
      const bounty = (forfeited * 4000n) / 10000n;
      const treasury = forfeited - bounty; // juror+layer1+remainder all fold to treasury (no Layer-2)
      expect(await manager.treasuryBalance()).to.equal(treasury);
      // challenger gets their bond back + bounty (challengerStart is post-bond-payment)
      expect(await usdc.balanceOf(challenger.address)).to.equal(
        challengerStart + MIN_CHALLENGE_BOND + bounty,
      );
    });

    it("VALID: upholds and splits the challenger's bond to the publisher", async function () {
      const { manager, registry, reputation, usdc, alice } = env;
      const aliceStart = await usdc.balanceOf(alice.address);

      await manager.connect(cre).submitLayer1Verdict(id, 0, 3);

      // upheld → back to PROBATION (never matured), challenge-won signalled
      expect((await registry.getAntibody(id)).status).to.equal(STATUS.PROBATION);
      expect((await reputation.getPublisher(alice.address)).challengesWon).to.equal(1n);

      // pool = challenge bond (5 USDC). publisher comp = 40%; treasury = the rest.
      const pool = MIN_CHALLENGE_BOND;
      const publisherComp = (pool * 4000n) / 10000n;
      expect(await usdc.balanceOf(alice.address)).to.equal(aliceStart + publisherComp);
      expect(await manager.treasuryBalance()).to.equal(pool - publisherComp);
    });

    it("no supermajority → escalates to Layer-2", async function () {
      const { manager, pool } = env;
      await expect(manager.connect(cre).submitLayer1Verdict(id, 1, 1)).to.emit(manager, "Escalated");
      const c = await manager.getChallenge(id);
      expect(c.status).to.equal(2); // LAYER2_ESCALATED
      expect(await pool.escalatedAt(id)).to.be.greaterThan(0n);
    });
  });

  describe("economics config", function () {
    it("rejects bps shares that exceed 10_000", async function () {
      const { manager } = env;
      await expect(
        manager.setEconomics(10_000, 5_000_000n, 5000, 4000, 2000, 6700, 3600, 3600),
      ).to.be.revertedWithCustomError(manager, "InvalidBps");
    });
  });
});
