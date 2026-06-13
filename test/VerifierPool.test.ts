import { expect } from "chai";
import { setupChallengeFixture, makeParams, STATUS, increaseTime } from "./utils.js";

const ANTIBODY_BOND = 1_600_000n;
const MIN_CHALLENGE_BOND = 5_000_000n;
const LAYER_TIMEOUT = 3600;

describe("VerifierPool (Layer-2 stub)", function () {
  let env: any;
  let id: string;

  async function publishAndChallenge() {
    const { registry, manager, ethers, alice, challenger } = env;
    const p = makeParams(ethers, { primaryMatcherHash: ethers.id("threat") });
    const [pid] = await registry.connect(alice).publish.staticCall(p);
    await registry.connect(alice).publish(p);
    await manager.connect(challenger).challenge(pid);
    return pid;
  }

  beforeEach(async function () {
    env = await setupChallengeFixture();
    id = await publishAndChallenge();
  });

  it("escalate is ChallengeManager-only", async function () {
    const { pool, challenger } = env;
    await expect(pool.connect(challenger).escalate(id)).to.be.revertedWithCustomError(
      pool,
      "NotChallengeManagerCaller",
    );
  });

  it("records the escalation when the manager escalates (no Layer-1 supermajority)", async function () {
    const { manager, pool, bob } = env;
    await manager.setCreReceiver(bob.address);
    await manager.connect(bob).submitLayer1Verdict(id, 1, 1); // split → escalate
    expect(await pool.escalatedAt(id)).to.be.greaterThan(0n);
  });

  describe("after escalation", function () {
    beforeEach(async function () {
      await env.manager.setCreReceiver(env.bob.address);
      await env.manager.connect(env.bob).submitLayer1Verdict(id, 1, 1); // escalate
    });

    it("stubResolve drives the Layer-2 → manager seam (INVALID pays jurors via the pool)", async function () {
      const { manager, pool, registry, usdc } = env;
      await pool.stubResolve(id, true); // owner forwards a Layer-2 INVALID verdict

      expect((await registry.getAntibody(id)).status).to.equal(STATUS.SLASHED);
      // Layer-2 path → juror fee (30% of the forfeited antibody bond) lands in the pool
      const jurorFee = (ANTIBODY_BOND * 3000n) / 10000n;
      expect(await usdc.balanceOf(await pool.getAddress())).to.equal(jurorFee);
    });

    it("stubResolve is owner-only", async function () {
      const { pool, challenger } = env;
      await expect(pool.connect(challenger).stubResolve(id, true)).to.be.revertedWithCustomError(
        pool,
        "OwnableUnauthorizedAccount",
      );
    });

    it("resolveTimeout (Layer-2) upholds conservatively and refunds the challenger", async function () {
      const { manager, registry, usdc, ethers, challenger } = env;
      const before = await usdc.balanceOf(challenger.address);
      await increaseTime(ethers, LAYER_TIMEOUT + 1);
      await manager.resolveTimeout(id);

      expect((await registry.getAntibody(id)).status).to.equal(STATUS.PROBATION); // upheld, no slash
      expect(await usdc.balanceOf(challenger.address)).to.equal(before + MIN_CHALLENGE_BOND); // full refund
    });
  });

  it("resolveTimeout (Layer-1) upholds when no verdict arrives", async function () {
    const { manager, registry, usdc, ethers, challenger } = env;
    const before = await usdc.balanceOf(challenger.address);
    await increaseTime(ethers, LAYER_TIMEOUT + 1);
    await manager.resolveTimeout(id);

    expect((await registry.getAntibody(id)).status).to.equal(STATUS.PROBATION);
    expect(await usdc.balanceOf(challenger.address)).to.equal(before + MIN_CHALLENGE_BOND);
  });
});
