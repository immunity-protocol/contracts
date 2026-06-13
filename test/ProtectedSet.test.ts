import { expect } from "chai";
import { getEthers } from "./utils.js";

const A = "0x000000000000000000000000000000000000000A";
const B = "0x000000000000000000000000000000000000000b";
const C = "0x000000000000000000000000000000000000000C";

describe("ProtectedSet", function () {
  let ethers: any;
  let owner: any, stranger: any, nextOwner: any;
  let ps: any;

  beforeEach(async function () {
    ethers = await getEthers();
    [owner, stranger, nextOwner] = await ethers.getSigners();
    ps = await (await ethers.getContractFactory("ProtectedSet")).deploy();
    await ps.waitForDeployment();
  });

  describe("allowlist", function () {
    it("reflects set and unset", async function () {
      expect(await ps.isProtected(A)).to.equal(false);
      await expect(ps.setProtected(A, true)).to.emit(ps, "ProtectedUpdated").withArgs(A, true);
      expect(await ps.isProtected(A)).to.equal(true);
      await expect(ps.setProtected(A, false)).to.emit(ps, "ProtectedUpdated").withArgs(A, false);
      expect(await ps.isProtected(A)).to.equal(false);
    });

    it("guards against the zero address", async function () {
      await expect(ps.setProtected(ethers.ZeroAddress, true)).to.be.revertedWithCustomError(
        ps,
        "ZeroAddress",
      );
    });

    it("is a no-op when state is unchanged (no duplicate list entries)", async function () {
      await ps.setProtected(A, true);
      await ps.setProtected(A, true); // no-op
      expect(await ps.getProtectedCount()).to.equal(1n);
    });

    it("setProtectedBatch seeds many at once", async function () {
      await ps.setProtectedBatch([A, B, C], true);
      expect(await ps.getProtectedCount()).to.equal(3n);
      expect(await ps.isProtected(B)).to.equal(true);
      const all = await ps.getAll();
      expect(all).to.have.members([A, ethers.getAddress(B), C]);
    });
  });

  describe("enumeration consistency (swap-and-pop)", function () {
    it("stays consistent when removing a middle element", async function () {
      await ps.setProtectedBatch([A, B, C], true); // list: [A, B, C]
      await ps.setProtected(B, false); // remove middle → swap-pop puts C into B's slot
      expect(await ps.getProtectedCount()).to.equal(2n);
      expect(await ps.isProtected(B)).to.equal(false);
      const all = await ps.getAll();
      expect(all).to.have.members([A, C]);
      expect(all).to.not.include(ethers.getAddress(B));

      // re-adding works after removal
      await ps.setProtected(B, true);
      expect(await ps.getProtectedCount()).to.equal(3n);
      expect(await ps.isProtected(B)).to.equal(true);
    });
  });

  describe("governance", function () {
    it("setProtected / setProtectedBatch are owner-only", async function () {
      await expect(ps.connect(stranger).setProtected(A, true)).to.be.revertedWithCustomError(
        ps,
        "OwnableUnauthorizedAccount",
      );
      await expect(
        ps.connect(stranger).setProtectedBatch([A], true),
      ).to.be.revertedWithCustomError(ps, "OwnableUnauthorizedAccount");
    });

    it("Ownable2Step: transfer requires the pending owner to accept", async function () {
      await ps.transferOwnership(nextOwner.address);
      // ownership has NOT moved yet — old owner still in control
      expect(await ps.owner()).to.equal(owner.address);
      expect(await ps.pendingOwner()).to.equal(nextOwner.address);
      // the pending owner accepts → ownership transfers
      await ps.connect(nextOwner).acceptOwnership();
      expect(await ps.owner()).to.equal(nextOwner.address);
      // the old owner can no longer write
      await expect(ps.setProtected(A, true)).to.be.revertedWithCustomError(
        ps,
        "OwnableUnauthorizedAccount",
      );
      await ps.connect(nextOwner).setProtected(A, true); // new owner can
      expect(await ps.isProtected(A)).to.equal(true);
    });
  });
});
