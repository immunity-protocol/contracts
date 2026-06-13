import { expect } from "chai";
import {
  setupRegistryFixture,
  fund,
  registerPublisher,
  makeParams,
  STATUS,
  CHECK_FEE,
} from "./utils.js";

// The attack that drove the v1 redesign (audit finding C-1 / H-2 / H-1 / A-1):
// a cheap, low-reputation actor flags a genuine address (the Uniswap router) as
// malicious. In the OLD registry this was a *winning* move — real trades blocked,
// the liar collected fees, and the stake was refunded after 72h. v1 must make the
// attacker strictly net-negative and never let a single low-rep voice hard-block.
describe("ImmunityRegistry — C-1 attack replay (flag the Uniswap router)", function () {
  it("attacker ends net-negative, never hard-blocks, matcher freed", async function () {
    const env = await setupRegistryFixture();
    const { registry, ethers, usdc } = env;
    const attacker = env.alice;
    const checker = env.bob;
    const challengeManager = env.challengeManager;
    const challenger = env.challenger;

    // A genuine, prominent address — the Uniswap router — is on the protected set.
    const UNISWAP_ROUTER = "0x2626664c2603336E57B271c5C0b26F421741e481";
    await env.protectedSet.setProtected(UNISWAP_ROUTER, true);

    // The attacker is a registered but low-reputation publisher (rep below the floor).
    await registerPublisher(env.registrar, env.reputation, attacker, 0n);
    await fund(registry, usdc, attacker, 100_000_000n);

    const attackerStart = await registry.balances(attacker.address);

    // Attacker flags the router (max severity to look scary).
    const aux = ethers.zeroPadValue(UNISWAP_ROUTER, 32);
    const params = makeParams(ethers, {
      severity: 100,
      primaryMatcherHash: ethers.id("uniswap-router"),
      auxiliaryKey: aux,
    });
    const [id] = await registry.connect(attacker).publish.staticCall(params);
    await registry.connect(attacker).publish(params);

    const ab0 = await registry.getAntibody(id);
    // Bond is large (protected target ×10) and locked — real skin in the game.
    expect(ab0.bondAmount).to.be.greaterThan(0n);
    expect(ab0.prominenceTier).to.equal(1);

    // (1) Advisory-only: a single low-rep publisher yields ZERO corroboration, so
    //     the read-side enforcement inputs can never justify a hard-block.
    const inputs = await registry.getEnforcementInputs(id);
    expect(inputs.status).to.equal(STATUS.PROBATION);
    expect(inputs.corroboration).to.equal(0); // rep below floor → doesn't count
    expect(inputs.publisherRep).to.equal(0n);

    // (2) Fees never pay out: a checker that matches only escrows the publisher share.
    await fund(registry, usdc, checker, 10_000_000n);
    await registry.connect(checker).check(id, UNISWAP_ROUTER, 1_000_000n, 8453);
    expect((await registry.getAntibody(id)).escrowedFees).to.be.greaterThan(0n);
    expect(await registry.balances(attacker.address)).to.equal(
      attackerStart - ab0.bondAmount, // only the bond debit so far; no earnings
    );

    // (3) A bounty-hunter challenges; the jury (via ChallengeManager) rules INVALID.
    await registry.connect(challengeManager).onChallengeOpened(id);
    await registry.connect(challengeManager).onChallengeResolved(id, true, challenger.address);

    // (4) Outcome: attacker forfeits bond + escrow, reputation slashed, matcher freed.
    const ab = await registry.getAntibody(id);
    expect(ab.status).to.equal(STATUS.SLASHED);
    expect(await registry.balances(attacker.address)).to.equal(attackerStart - ab0.bondAmount);
    expect(await registry.balances(attacker.address)).to.be.lessThan(attackerStart); // net-negative
    expect(await env.reputation.slashCalls(attacker.address)).to.equal(1n);
    expect((await registry.getAntibodiesByMatcher(ab0.primaryMatcherHash)).length).to.equal(0);

    // Genuine trades were never hard-blockable: corroboration stayed 0 throughout.
    expect(await registry.corroborationOf(ab0.primaryMatcherHash)).to.equal(0);
  });
});
