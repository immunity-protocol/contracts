import { expect } from "chai";
import { getEthers, fund, makeParams } from "./utils.js";

// Wires the REAL Registry + REAL Reputation together (no stub) and drives the
// reputation writes through the actual Registry call path: publish → corroborate
// → mature fires onMatured; a slash via onChallengeResolved fires onSlash.
describe("Reputation ⇄ ImmunityRegistry integration", function () {
  let ethers: any;
  let owner: any, alice: any, bob: any, carol: any, dave: any, challengeManager: any, challenger: any;
  let usdc: any, registrar: any, reputation: any, protectedSet: any, registry: any;
  const matcher = "0x" + "11".repeat(32);

  beforeEach(async function () {
    ethers = await getEthers();
    [owner, alice, bob, carol, dave, challengeManager, challenger] = await ethers.getSigners();

    usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    await usdc.waitForDeployment();
    registrar = await (await ethers.getContractFactory("StubPublisherRegistrar")).deploy();
    await registrar.waitForDeployment();
    protectedSet = await (await ethers.getContractFactory("StubProtectedSet")).deploy();
    await protectedSet.waitForDeployment();
    // The REAL reputation contract, not the stub.
    reputation = await (await ethers.getContractFactory("Reputation")).deploy();
    await reputation.waitForDeployment();

    registry = await (await ethers.getContractFactory("ImmunityRegistry")).deploy(
      await usdc.getAddress(),
      await registrar.getAddress(),
      await reputation.getAddress(),
      await protectedSet.getAddress(),
      challengeManager.address,
    );
    await registry.waitForDeployment();

    // Authorize the Registry to write reputation.
    await reputation.setAuthorizedWriter(await registry.getAddress(), true);

    // Genesis-bootstrap the three publishers so they clear minCorroborationRep (1)
    // and can corroborate at launch; register + fund them.
    for (const s of [alice, bob, carol]) {
      await reputation.grantGenesisReputation(s.address, 100n);
      await registrar.setRegistered(s.address, true);
      await fund(registry, usdc, s, 100_000_000n);
    }
  });

  it("a real maturation drives onMatured and raises the publisher's score", async function () {
    // Three distinct publishers flag the same target → corroboration 3 = K.
    for (const s of [alice, bob, carol]) {
      await registry.connect(s).publish(makeParams(ethers, { primaryMatcherHash: matcher }));
    }
    expect(await registry.corroborationOf(matcher)).to.equal(3);

    const aliceId = await registry.computeKeccakId(0, 0, matcher, alice.address);
    const before = await reputation.scoreOf(alice.address);

    await expect(registry.mature(aliceId)).to.emit(reputation, "Matured");

    expect(await reputation.scoreOf(alice.address)).to.equal(before + 10n); // maturePoints
    expect((await reputation.getPublisher(alice.address)).maturedCount).to.equal(1n);
  });

  it("a real slash drives onSlash and craters the score", async function () {
    for (const s of [alice, bob, carol]) {
      await registry.connect(s).publish(makeParams(ethers, { primaryMatcherHash: matcher }));
    }
    const aliceId = await registry.computeKeccakId(0, 0, matcher, alice.address);
    await registry.mature(aliceId); // score now 110

    await registry.connect(challengeManager).onChallengeOpened(aliceId);
    await expect(
      registry.connect(challengeManager).onChallengeResolved(aliceId, true, challenger.address),
    ).to.emit(reputation, "Slashed");

    // 110 - slashPenalty(1000) floors to 0; one proven lie wipes the earned score.
    expect(await reputation.scoreOf(alice.address)).to.equal(0n);
    expect((await reputation.getPublisher(alice.address)).slashedCount).to.equal(1n);
  });

  it("live reads: slashing a publisher drops their corroboration everywhere", async function () {
    for (const s of [alice, bob, carol]) {
      await registry.connect(s).publish(makeParams(ethers, { primaryMatcherHash: matcher }));
    }
    expect(await registry.corroborationOf(matcher)).to.equal(3);

    // Slash carol (open+resolve on carol's own antibody).
    const carolId = await registry.computeKeccakId(0, 0, matcher, carol.address);
    await registry.connect(challengeManager).onChallengeOpened(carolId);
    await registry.connect(challengeManager).onChallengeResolved(carolId, true, challenger.address);

    // carol's score is now 0 (< floor) AND her antibody was removed from the set →
    // corroboration drops to 2 live, with no bookkeeping in the Registry.
    expect(await reputation.scoreOf(carol.address)).to.equal(0n);
    expect(await registry.corroborationOf(matcher)).to.equal(2);
  });
});
