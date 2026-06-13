import { expect } from "chai";
import { getEthers } from "./utils.js";

const PARENT = "0x" + "ab".repeat(32); // stand-in immunity.eth node
const BOND = 10_000_000n; // 10 USDC default

describe("PublisherRegistrar", function () {
  let ethers: any;
  let owner: any, alice: any, bob: any, stranger: any;
  let usdc: any, l2: any, reputation: any, registrar: any;

  async function fundBond(account: any, amount: bigint = BOND) {
    await usdc.mint(account.address, amount);
    await usdc.connect(account).approve(await registrar.getAddress(), amount);
  }

  beforeEach(async function () {
    ethers = await getEthers();
    [owner, alice, bob, stranger] = await ethers.getSigners();

    usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    await usdc.waitForDeployment();
    l2 = await (await ethers.getContractFactory("StubL2Registry")).deploy();
    await l2.waitForDeployment();
    reputation = await (await ethers.getContractFactory("Reputation")).deploy();
    await reputation.waitForDeployment();

    registrar = await (await ethers.getContractFactory("PublisherRegistrar")).deploy(
      await usdc.getAddress(),
    );
    await registrar.waitForDeployment();
    await registrar.setL2Registry(await l2.getAddress());
    await registrar.setReputation(await reputation.getAddress());
    await registrar.setParentNode(PARENT);
  });

  describe("registerPublisher", function () {
    it("locks the bond, mints a CONTRACT-OWNED subname, flips isRegistered", async function () {
      await fundBond(alice);
      await expect(registrar.connect(alice).registerPublisher("alice")).to.emit(registrar, "Registered");

      expect(await registrar.isRegistered(alice.address)).to.equal(true);
      // bond moved from alice into the registrar
      expect(await usdc.balanceOf(await registrar.getAddress())).to.equal(BOND);

      const node = await registrar.nodeOf(alice.address);
      expect(node).to.not.equal("0x" + "00".repeat(32));
      // the subname is owned by the registrar contract, NOT alice
      expect(await l2.owner(node)).to.equal(await registrar.getAddress());
      expect(await registrar.publisherOf(node)).to.equal(alice.address);
    });

    it("a publisher CANNOT forge their own immunity.* text (contract-owned)", async function () {
      await fundBond(alice);
      await registrar.connect(alice).registerPublisher("alice");
      const node = await registrar.nodeOf(alice.address);
      // alice is not the node owner (the registrar is) nor an approved registrar
      await expect(
        l2.connect(alice).setText(node, "immunity.reputation", "999999"),
      ).to.be.revertedWith("not authorised");
    });

    it("rejects a second registration by the same publisher", async function () {
      await fundBond(alice, BOND * 2n);
      await registrar.connect(alice).registerPublisher("alice");
      await expect(
        registrar.connect(alice).registerPublisher("alice2"),
      ).to.be.revertedWithCustomError(registrar, "AlreadyRegistered");
    });

    it("surfaces the L2Registry revert on a duplicate label", async function () {
      await fundBond(alice);
      await fundBond(bob);
      await registrar.connect(alice).registerPublisher("dup");
      await expect(registrar.connect(bob).registerPublisher("dup")).to.be.revertedWith("label taken");
    });

    it("reverts if the publisher hasn't approved the bond", async function () {
      // no mint/approve → SafeERC20 transferFrom fails on insufficient allowance
      await expect(
        registrar.connect(alice).registerPublisher("alice"),
      ).to.be.revertedWithCustomError(usdc, "ERC20InsufficientAllowance");
    });
  });

  describe("deregister", function () {
    beforeEach(async function () {
      await fundBond(alice);
      await registrar.connect(alice).registerPublisher("alice");
    });

    it("returns the bond and flips isRegistered false", async function () {
      const before = await usdc.balanceOf(alice.address);
      await expect(registrar.connect(alice).deregister())
        .to.emit(registrar, "Deregistered")
        .withArgs(alice.address, BOND);
      expect(await registrar.isRegistered(alice.address)).to.equal(false);
      expect(await usdc.balanceOf(alice.address)).to.equal(before + BOND);
    });

    it("leaves the subname contract-owned (not burned)", async function () {
      const node = await registrar.nodeOf(alice.address);
      await registrar.connect(alice).deregister();
      expect(await l2.owner(node)).to.equal(await registrar.getAddress());
    });

    it("reverts for a non-registered caller", async function () {
      await expect(registrar.connect(stranger).deregister()).to.be.revertedWithCustomError(
        registrar,
        "NotRegistered",
      );
    });
  });

  describe("syncReputation", function () {
    beforeEach(async function () {
      await fundBond(alice);
      await registrar.connect(alice).registerPublisher("alice");
    });

    it("mirrors score + strikes into ENS text (permissionless, read-only)", async function () {
      // bump the canonical reputation: grant + a slash via an authorized writer
      await reputation.setAuthorizedWriter(owner.address, true);
      await reputation.grantGenesisReputation(alice.address, 50n);
      await reputation.onSlash(alice.address); // 50 - 1000 → floors to 0, slashedCount 1

      // anyone can poke
      await expect(registrar.connect(stranger).syncReputation(alice.address)).to.emit(
        registrar,
        "ReputationSynced",
      );

      const node = await registrar.nodeOf(alice.address);
      expect(await l2.text(node, "immunity.reputation")).to.equal("0");
      expect(await l2.text(node, "immunity.strikes")).to.equal("1");

      // the registrar is NOT an authorized writer on Reputation (never writes scores)
      expect(await reputation.authorizedWriter(await registrar.getAddress())).to.equal(false);
    });

    it("reverts for an unregistered publisher", async function () {
      await expect(registrar.syncReputation(stranger.address)).to.be.revertedWithCustomError(
        registrar,
        "NotRegistered",
      );
    });
  });

  describe("owner config", function () {
    it("only the owner can set deps / bond", async function () {
      await expect(
        registrar.connect(stranger).setRegistrationBond(1n),
      ).to.be.revertedWithCustomError(registrar, "OwnableUnauthorizedAccount");
      await expect(
        registrar.connect(stranger).setL2Registry(await l2.getAddress()),
      ).to.be.revertedWithCustomError(registrar, "OwnableUnauthorizedAccount");
    });

    it("setRegistrationBond changes the locked amount", async function () {
      await registrar.setRegistrationBond(5_000_000n);
      await fundBond(bob, 5_000_000n);
      await registrar.connect(bob).registerPublisher("bob");
      expect((await registrar.getRegistration(bob.address)).bond).to.equal(5_000_000n);
    });
  });
});
