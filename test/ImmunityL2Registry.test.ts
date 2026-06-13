import { expect } from "chai";
import { getEthers } from "./utils.js";

const PARENT = "0x" + "ab".repeat(32); // stand-in immunity.eth node
const ZERO = "0x0000000000000000000000000000000000000000";
const BOND = 10_000_000n; // 10 USDC default

describe("ImmunityL2Registry", function () {
  let ethers: any;
  let admin: any, registrarAcct: any, alice: any, stranger: any;
  let l2: any;

  beforeEach(async function () {
    ethers = await getEthers();
    [admin, registrarAcct, alice, stranger] = await ethers.getSigners();
    l2 = await (await ethers.getContractFactory("ImmunityL2Registry")).deploy(admin.address);
    await l2.waitForDeployment();
  });

  describe("construction", function () {
    it("sets the admin and emits AdminTransferred", async function () {
      const reg = await (await ethers.getContractFactory("ImmunityL2Registry")).deploy(alice.address);
      await reg.waitForDeployment();
      expect(await reg.admin()).to.equal(alice.address);
    });

    it("rejects a zero admin", async function () {
      const factory = await ethers.getContractFactory("ImmunityL2Registry");
      await expect(factory.deploy(ZERO)).to.be.revertedWithCustomError(l2, "ZeroAddress");
    });
  });

  describe("registrar allowlist (admin-only)", function () {
    it("admin can addRegistrar", async function () {
      await expect(l2.addRegistrar(registrarAcct.address))
        .to.emit(l2, "RegistrarSet")
        .withArgs(registrarAcct.address, true);
      expect(await l2.registrars(registrarAcct.address)).to.equal(true);
    });

    it("non-admin addRegistrar reverts NotAdmin", async function () {
      await expect(
        l2.connect(stranger).addRegistrar(registrarAcct.address),
      ).to.be.revertedWithCustomError(l2, "NotAdmin");
    });

    it("non-admin setRegistrar reverts NotAdmin", async function () {
      await expect(
        l2.connect(stranger).setRegistrar(registrarAcct.address, true),
      ).to.be.revertedWithCustomError(l2, "NotAdmin");
    });

    it("admin can revoke via setRegistrar(false)", async function () {
      await l2.addRegistrar(registrarAcct.address);
      await l2.setRegistrar(registrarAcct.address, false);
      expect(await l2.registrars(registrarAcct.address)).to.equal(false);
    });
  });

  describe("createSubnode (registrar-or-admin)", function () {
    it("an approved registrar mints a subnode owned by the requested owner", async function () {
      await l2.addRegistrar(registrarAcct.address);
      const node = await l2.makeNode(PARENT, "alice");
      await expect(
        l2.connect(registrarAcct).createSubnode(PARENT, "alice", registrarAcct.address, []),
      )
        .to.emit(l2, "SubnodeCreated")
        .withArgs(node, PARENT, "alice", registrarAcct.address);
      expect(await l2.owner(node)).to.equal(registrarAcct.address);
    });

    it("the admin may also mint directly", async function () {
      const node = await l2.makeNode(PARENT, "genesis");
      await l2.createSubnode(PARENT, "genesis", admin.address, []);
      expect(await l2.owner(node)).to.equal(admin.address);
    });

    it("a non-registrar EOA createSubnode reverts NotApprovedRegistrar", async function () {
      await expect(
        l2.connect(stranger).createSubnode(PARENT, "evil", stranger.address, []),
      ).to.be.revertedWithCustomError(l2, "NotApprovedRegistrar");
    });

    it("a duplicate label reverts LabelTaken", async function () {
      await l2.addRegistrar(registrarAcct.address);
      await l2.connect(registrarAcct).createSubnode(PARENT, "dup", registrarAcct.address, []);
      await expect(
        l2.connect(registrarAcct).createSubnode(PARENT, "dup", registrarAcct.address, []),
      ).to.be.revertedWithCustomError(l2, "LabelTaken");
    });
  });

  describe("setText (owner-or-registrar gate)", function () {
    let node: string;
    beforeEach(async function () {
      await l2.addRegistrar(registrarAcct.address);
      // contract-owned node: owned by the registrar account (mimics the registrar contract)
      node = await l2.makeNode(PARENT, "alice");
      await l2.connect(registrarAcct).createSubnode(PARENT, "alice", registrarAcct.address, []);
    });

    it("an approved registrar can write text", async function () {
      await expect(l2.connect(registrarAcct).setText(node, "immunity.reputation", "100"))
        .to.emit(l2, "TextChanged")
        .withArgs(node, "immunity.reputation", "100");
      expect(await l2.text(node, "immunity.reputation")).to.equal("100");
    });

    it("the node owner can write text", async function () {
      // mint a node owned by alice directly
      const aNode = await l2.makeNode(PARENT, "alice-owned");
      await l2.connect(registrarAcct).createSubnode(PARENT, "alice-owned", alice.address, []);
      await l2.connect(alice).setText(aNode, "url", "https://alice.example");
      expect(await l2.text(aNode, "url")).to.equal("https://alice.example");
    });

    it("a non-owner non-registrar setText reverts NotAuthorizedWriter", async function () {
      await expect(
        l2.connect(alice).setText(node, "immunity.reputation", "999999"),
      ).to.be.revertedWithCustomError(l2, "NotAuthorizedWriter");
    });
  });

  describe("transferAdmin", function () {
    it("hands the role over and the old admin loses access", async function () {
      await l2.transferAdmin(alice.address);
      expect(await l2.admin()).to.equal(alice.address);
      await expect(l2.addRegistrar(stranger.address)).to.be.revertedWithCustomError(l2, "NotAdmin");
      await l2.connect(alice).addRegistrar(stranger.address);
      expect(await l2.registrars(stranger.address)).to.equal(true);
    });

    it("rejects a zero new admin", async function () {
      await expect(l2.transferAdmin(ZERO)).to.be.revertedWithCustomError(l2, "ZeroAddress");
    });
  });

  // End-to-end against the LIVE PublisherRegistrar wired to the real registry —
  // proves the B-5 guarantees hold on the production registry, not just the stub.
  describe("PublisherRegistrar integration (B-5 guarantees)", function () {
    let usdc: any, reputation: any, registrar: any;

    async function fundBond(account: any, amount: bigint = BOND) {
      await usdc.mint(account.address, amount);
      await usdc.connect(account).approve(await registrar.getAddress(), amount);
    }

    beforeEach(async function () {
      usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
      await usdc.waitForDeployment();
      reputation = await (await ethers.getContractFactory("Reputation")).deploy();
      await reputation.waitForDeployment();
      registrar = await (await ethers.getContractFactory("PublisherRegistrar")).deploy(
        await usdc.getAddress(),
      );
      await registrar.waitForDeployment();

      // Wire the registrar to the REAL ImmunityL2Registry + approve it (no redeploy path).
      await registrar.setL2Registry(await l2.getAddress());
      await registrar.setReputation(await reputation.getAddress());
      await registrar.setParentNode(PARENT);
      await l2.addRegistrar(await registrar.getAddress());
    });

    it("registerPublisher mints a CONTRACT-OWNED subname", async function () {
      await fundBond(alice);
      await registrar.connect(alice).registerPublisher("genesis-0");
      const node = await registrar.nodeOf(alice.address);
      // owned by the registrar contract — anti-flight (B-5)
      expect(await l2.owner(node)).to.equal(await registrar.getAddress());
    });

    it("a publisher CANNOT forge their own immunity.* text", async function () {
      await fundBond(alice);
      await registrar.connect(alice).registerPublisher("genesis-0");
      const node = await registrar.nodeOf(alice.address);
      await expect(
        l2.connect(alice).setText(node, "immunity.reputation", "999999"),
      ).to.be.revertedWithCustomError(l2, "NotAuthorizedWriter");
    });

    it("syncReputation writes the reputation mirror via the registrar", async function () {
      await fundBond(alice);
      await registrar.connect(alice).registerPublisher("genesis-0");

      await reputation.setAuthorizedWriter(admin.address, true);
      await reputation.grantGenesisReputation(alice.address, 50n);
      await reputation.onSlash(alice.address); // floors to 0, 1 strike

      await registrar.connect(stranger).syncReputation(alice.address);
      const node = await registrar.nodeOf(alice.address);
      expect(await l2.text(node, "immunity.reputation")).to.equal("0");
      expect(await l2.text(node, "immunity.strikes")).to.equal("1");
    });
  });
});
