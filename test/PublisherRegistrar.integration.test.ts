import { expect } from "chai";
import { getEthers, fund, makeParams } from "./utils.js";

const PARENT = "0x" + "ab".repeat(32);
const BOND = 10_000_000n;

// Wires the REAL ImmunityRegistry + REAL Reputation + REAL PublisherRegistrar
// (Durin stubbed) and proves the identity gate end-to-end through the Registry.
describe("PublisherRegistrar ⇄ ImmunityRegistry integration", function () {
  let ethers: any;
  let owner: any, alice: any, bob: any, challengeManager: any;
  let usdc: any, l2: any, reputation: any, protectedSet: any, registrar: any, registry: any;

  beforeEach(async function () {
    ethers = await getEthers();
    [owner, alice, bob, challengeManager] = await ethers.getSigners();

    usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    await usdc.waitForDeployment();
    l2 = await (await ethers.getContractFactory("StubL2Registry")).deploy();
    await l2.waitForDeployment();
    reputation = await (await ethers.getContractFactory("Reputation")).deploy();
    await reputation.waitForDeployment();
    protectedSet = await (await ethers.getContractFactory("StubProtectedSet")).deploy();
    await protectedSet.waitForDeployment();

    registrar = await (await ethers.getContractFactory("PublisherRegistrar")).deploy(
      await usdc.getAddress(),
    );
    await registrar.waitForDeployment();
    await registrar.setL2Registry(await l2.getAddress());
    await registrar.setReputation(await reputation.getAddress());
    await registrar.setParentNode(PARENT);

    registry = await (await ethers.getContractFactory("ImmunityRegistry")).deploy(
      await usdc.getAddress(),
      await registrar.getAddress(),
      await reputation.getAddress(),
      await protectedSet.getAddress(),
      challengeManager.address,
    );
    await registry.waitForDeployment();

    // alice has Registry balance for antibody bonds + registrar bond approval.
    await fund(registry, usdc, alice, 100_000_000n);
    await usdc.mint(alice.address, BOND);
    await usdc.connect(alice).approve(await registrar.getAddress(), BOND);
  });

  it("gates publish on registration: reverts → register → succeeds → deregister → reverts", async function () {
    // unregistered → publish blocked by the Registry's isRegistered gate
    await expect(
      registry.connect(alice).publish(makeParams(ethers)),
    ).to.be.revertedWithCustomError(registry, "NotRegistered");

    // register → publish now succeeds
    await registrar.connect(alice).registerPublisher("alice");
    await registry.connect(alice).publish(makeParams(ethers, { primaryMatcherHash: ethers.id("t1") }));

    // deregister → a NEW publish is blocked again
    await registrar.connect(alice).deregister();
    await expect(
      registry.connect(alice).publish(makeParams(ethers, { primaryMatcherHash: ethers.id("t2") })),
    ).to.be.revertedWithCustomError(registry, "NotRegistered");
  });

  it("deregistering does NOT affect already-published antibodies", async function () {
    await registrar.connect(alice).registerPublisher("alice");
    const params = makeParams(ethers, { primaryMatcherHash: ethers.id("t1") });
    const [id] = await registry.connect(alice).publish.staticCall(params);
    await registry.connect(alice).publish(params);

    await registrar.connect(alice).deregister();

    // antibody still present and still settles for a checker
    expect((await registry.getAntibody(id)).publisher).to.equal(alice.address);
    await fund(registry, usdc, bob, 10_000_000n);
    const settled = await registry.connect(bob).check.staticCall(id, ethers.ZeroAddress, 0, 0);
    expect(settled).to.equal(true);
  });

  it("syncReputation reflects a real canonical score change", async function () {
    await registrar.connect(alice).registerPublisher("alice");
    await reputation.grantGenesisReputation(alice.address, 100n); // owner-only canonical write

    await registrar.syncReputation(alice.address);
    const node = await registrar.nodeOf(alice.address);
    expect(await l2.text(node, "immunity.reputation")).to.equal("100");
  });
});
