import { expect } from "chai";
import { getEthers } from "./utils.js";

// Default stake-weight scale (mirror the contract constructor; USDC 6dp).
const REP_BOND_UNIT = 100_000n; // 0.1 USDC of bond == 1 reputation point
const MATURE_CAP = 50n;
const CHALLENGE_WON_CAP = 100n;
const SLASH = 1000n;

// A unit bond (Registry bondFloor = bondBase = 1.0 USDC = 1_000_000).
const UNIT_BOND = 1_000_000n;
// Stake-weighted credit a unit-bond antibody earns.
const MATURE_CREDIT = UNIT_BOND / REP_BOND_UNIT; // 10
const WON_CREDIT = (2n * UNIT_BOND) / REP_BOND_UNIT; // 20

describe("Reputation", function () {
  let ethers: any;
  let owner: any, writer: any, pub: any, stranger: any;
  let reputation: any;

  beforeEach(async function () {
    ethers = await getEthers();
    [owner, writer, pub, stranger] = await ethers.getSigners();
    reputation = await (await ethers.getContractFactory("Reputation")).deploy();
    await reputation.waitForDeployment();
    // Authorize `writer` as the stand-in protocol writer.
    await reputation.setAuthorizedWriter(writer.address, true);
  });

  it("starts every publisher at score 0", async function () {
    expect(await reputation.scoreOf(pub.address)).to.equal(0n);
  });

  it("defaults to a stake-weight scale (slashPenalty ≫ any single credit)", async function () {
    expect(await reputation.repBondUnit()).to.equal(REP_BOND_UNIT);
    expect(await reputation.maturePointsCap()).to.equal(MATURE_CAP);
    expect(await reputation.challengeWonCap()).to.equal(CHALLENGE_WON_CAP);
    expect(await reputation.slashPenalty()).to.equal(SLASH);
    expect(await reputation.slashPenalty()).to.be.greaterThan(await reputation.challengeWonCap());
  });

  describe("authorized-writer gating", function () {
    it("reverts onMatured / onChallengeWon / onSlash for a non-writer EOA", async function () {
      await expect(
        reputation.connect(stranger).onMatured(pub.address, UNIT_BOND),
      ).to.be.revertedWithCustomError(reputation, "NotAuthorizedWriter");
      await expect(
        reputation.connect(stranger).onChallengeWon(pub.address, UNIT_BOND),
      ).to.be.revertedWithCustomError(reputation, "NotAuthorizedWriter");
      await expect(
        reputation.connect(stranger).onSlash(pub.address),
      ).to.be.revertedWithCustomError(reputation, "NotAuthorizedWriter");
    });

    it("reverts even for the publisher grading themselves", async function () {
      await expect(
        reputation.connect(pub).onMatured(pub.address, UNIT_BOND),
      ).to.be.revertedWithCustomError(reputation, "NotAuthorizedWriter");
    });

    it("lets the owner authorize and revoke writers", async function () {
      await reputation.setAuthorizedWriter(stranger.address, true);
      await reputation.connect(stranger).onMatured(pub.address, UNIT_BOND); // now allowed
      await reputation.setAuthorizedWriter(stranger.address, false);
      await expect(
        reputation.connect(stranger).onMatured(pub.address, UNIT_BOND),
      ).to.be.revertedWithCustomError(reputation, "NotAuthorizedWriter");
    });

    it("only the owner can manage writers / points", async function () {
      await expect(
        reputation.connect(stranger).setAuthorizedWriter(stranger.address, true),
      ).to.be.revertedWithCustomError(reputation, "OwnableUnauthorizedAccount");
      await expect(
        reputation.connect(stranger).setPoints(1n, 1n, 1n, 1n),
      ).to.be.revertedWithCustomError(reputation, "OwnableUnauthorizedAccount");
    });

    it("setPoints rejects a zero repBondUnit (it is a divisor)", async function () {
      await expect(
        reputation.setPoints(0n, MATURE_CAP, CHALLENGE_WON_CAP, SLASH),
      ).to.be.revertedWithCustomError(reputation, "ZeroAmount");
    });
  });

  describe("stake-weighted earning and losing score", function () {
    it("credits matured in proportion to bond, not a flat amount", async function () {
      await expect(reputation.connect(writer).onMatured(pub.address, UNIT_BOND))
        .to.emit(reputation, "Matured")
        .withArgs(pub.address, MATURE_CREDIT);
      expect(await reputation.scoreOf(pub.address)).to.equal(MATURE_CREDIT);
      expect((await reputation.getPublisher(pub.address)).maturedCount).to.equal(1n);

      // A 5× bond earns 5× the points (still below the cap).
      await reputation.connect(writer).onMatured(stranger.address, 5n * UNIT_BOND);
      expect(await reputation.scoreOf(stranger.address)).to.equal(5n * MATURE_CREDIT);
    });

    it("caps the per-mature credit at maturePointsCap", async function () {
      // A huge bond would credit 1000 pts; cap clamps it to 50.
      await reputation.connect(writer).onMatured(pub.address, 100n * UNIT_BOND);
      expect(await reputation.scoreOf(pub.address)).to.equal(MATURE_CAP);
    });

    it("credits challenge-won at a 2× premium over bond, capped", async function () {
      await expect(reputation.connect(writer).onChallengeWon(pub.address, UNIT_BOND))
        .to.emit(reputation, "ChallengeWon")
        .withArgs(pub.address, WON_CREDIT);
      expect(await reputation.scoreOf(pub.address)).to.equal(WON_CREDIT);
      expect((await reputation.getPublisher(pub.address)).challengesWon).to.equal(1n);

      // Cap clamps a large bond's win at challengeWonCap.
      await reputation.connect(writer).onChallengeWon(stranger.address, 1000n * UNIT_BOND);
      expect(await reputation.scoreOf(stranger.address)).to.equal(CHALLENGE_WON_CAP);
    });

    it("two small self-matures do NOT clear the corroboration floor (25)", async function () {
      await reputation.connect(writer).onMatured(pub.address, UNIT_BOND); // 10
      await reputation.connect(writer).onMatured(pub.address, UNIT_BOND); // 20
      expect(await reputation.scoreOf(pub.address)).to.equal(2n * MATURE_CREDIT); // 20
      expect(await reputation.scoreOf(pub.address)).to.be.lessThan(25n);
      // ...but three real matures cross it — an organic grinder gets there.
      await reputation.connect(writer).onMatured(pub.address, UNIT_BOND); // 30
      expect(await reputation.scoreOf(pub.address)).to.be.greaterThanOrEqual(25n);
    });

    it("one slash wipes many matures (slashPenalty ≫ a single credit)", async function () {
      // 50 unit matures = 500 < slashPenalty 1000 → one slash floors to 0
      for (let i = 0; i < 50; i++) await reputation.connect(writer).onMatured(pub.address, UNIT_BOND);
      expect(await reputation.scoreOf(pub.address)).to.equal(MATURE_CREDIT * 50n);

      await expect(reputation.connect(writer).onSlash(pub.address))
        .to.emit(reputation, "Slashed")
        .withArgs(pub.address, 0n);
      expect(await reputation.scoreOf(pub.address)).to.equal(0n);
      expect((await reputation.getPublisher(pub.address)).slashedCount).to.equal(1n);
    });

    it("floors at 0 and never underflows", async function () {
      await reputation.connect(writer).onMatured(pub.address, UNIT_BOND); // score 10
      await reputation.connect(writer).onSlash(pub.address); // 10 - 1000 → 0
      expect(await reputation.scoreOf(pub.address)).to.equal(0n);
      // a second slash on a zero score stays 0
      await reputation.connect(writer).onSlash(pub.address);
      expect(await reputation.scoreOf(pub.address)).to.equal(0n);
    });

    it("subtracts exactly when score exceeds the penalty", async function () {
      // Lift the mature cap so a big bond can build past slashPenalty.
      await reputation.setPoints(REP_BOND_UNIT, 600n, CHALLENGE_WON_CAP, 1000n);
      await reputation.connect(writer).onMatured(pub.address, 60n * UNIT_BOND); // 600
      await reputation.connect(writer).onMatured(pub.address, 60n * UNIT_BOND); // 1200
      await reputation.connect(writer).onSlash(pub.address); // 1200 - 1000 = 200
      expect(await reputation.scoreOf(pub.address)).to.equal(200n);
    });
  });

  describe("genesis bootstrap", function () {
    it("owner can grant genesis reputation; tracked + event emitted", async function () {
      await expect(reputation.grantGenesisReputation(pub.address, 100n))
        .to.emit(reputation, "GenesisGranted")
        .withArgs(pub.address, 100n, 100n);
      expect(await reputation.scoreOf(pub.address)).to.equal(100n);
      expect((await reputation.getPublisher(pub.address)).genesisGranted).to.equal(100n);
    });

    it("is owner-only and rejects the zero address", async function () {
      await expect(
        reputation.connect(stranger).grantGenesisReputation(pub.address, 100n),
      ).to.be.revertedWithCustomError(reputation, "OwnableUnauthorizedAccount");
      await expect(
        reputation.grantGenesisReputation(ethers.ZeroAddress, 100n),
      ).to.be.revertedWithCustomError(reputation, "ZeroAddress");
    });
  });
});
