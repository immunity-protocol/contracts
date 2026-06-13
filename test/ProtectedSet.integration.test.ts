import { expect } from "chai";
import {
  setupRegistryFixture,
  fund,
  registerPublisher,
  makeParams,
  ABTYPE,
  BOND_BASE,
  PROTECTED_MULT,
} from "./utils.js";

// Wires the REAL ProtectedSet into the REAL Registry and asserts the only effect
// the Registry takes from it: bond scaling (× multiplier) + prominenceTier on a
// publish that flags a protected target.
describe("ProtectedSet ⇄ ImmunityRegistry integration (bond scaling)", function () {
  let env: any;
  let protectedSet: any;
  const PROTECTED = "0x2626664c2603336E57B271c5C0b26F421741e481"; // e.g. a canonical router
  const NORMAL = "0x00000000000000000000000000000000DeaDBeef";

  beforeEach(async function () {
    env = await setupRegistryFixture();
    const { registry, ethers, registrar, reputation, challengeManager } = env;

    // Deploy the real ProtectedSet and swap it in for the stub.
    protectedSet = await (await ethers.getContractFactory("ProtectedSet")).deploy();
    await protectedSet.waitForDeployment();
    await registry.setDependencies(
      await registrar.getAddress(),
      await reputation.getAddress(),
      await protectedSet.getAddress(),
      challengeManager.address,
    );

    await registerPublisher(registrar, reputation, env.alice);
    await fund(registry, env.usdc, env.alice, 100_000_000n);
    await protectedSet.setProtected(PROTECTED, true);
  });

  async function publishFlagging(target: string) {
    const { registry, ethers, alice } = env;
    const params = makeParams(ethers, {
      abType: ABTYPE.ADDRESS,
      severity: 0, // bond = floor (= base); isolates the protected multiplier
      primaryMatcherHash: ethers.id("matcher-" + target),
      auxiliaryKey: ethers.zeroPadValue(target, 32),
    });
    const [id] = await registry.connect(alice).publish.staticCall(params);
    await registry.connect(alice).publish(params);
    return registry.getAntibody(id);
  }

  it("flagging a protected target costs base × multiplier and sets prominenceTier", async function () {
    const ab = await publishFlagging(PROTECTED);
    expect(ab.bondAmount).to.equal(BOND_BASE * PROTECTED_MULT);
    expect(ab.prominenceTier).to.equal(1);
  });

  it("flagging a non-protected target costs the base bond", async function () {
    const ab = await publishFlagging(NORMAL);
    expect(ab.bondAmount).to.equal(BOND_BASE);
    expect(ab.prominenceTier).to.equal(0);
  });

  it("computeBond previews the multiplier for the SDK", async function () {
    const { registry } = env;
    expect(await registry.computeBond(0, PROTECTED)).to.equal(BOND_BASE * PROTECTED_MULT);
    expect(await registry.computeBond(0, NORMAL)).to.equal(BOND_BASE);
  });
});
