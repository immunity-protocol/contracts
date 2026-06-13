import { expect } from "chai";
import {
  setupRegistryFixture,
  fund,
  registerPublisher,
  makeParams,
  STATUS,
  BOND_BASE,
  PROTECTED_MULT,
} from "./utils.js";

describe("ImmunityRegistry — views", function () {
  let env: any;

  beforeEach(async function () {
    env = await setupRegistryFixture();
    await fund(env.registry, env.usdc, env.alice, 100_000_000n);
    await registerPublisher(env.registrar, env.reputation, env.alice, 42n);
  });

  it("computeBond is a pure preview of the published bond", async function () {
    const { registry, ethers } = env;
    // severity 100, unprotected: base × 2
    expect(await registry.computeBond(100, ethers.ZeroAddress)).to.equal(BOND_BASE * 2n);
  });

  it("getEnforcementInputs exposes the read-side decision inputs", async function () {
    const { registry, ethers, alice } = env;
    const params = makeParams(ethers);
    const [id] = await registry.connect(alice).publish.staticCall(params);
    await registry.connect(alice).publish(params);

    const out = await registry.getEnforcementInputs(id);
    expect(out.status).to.equal(STATUS.PROBATION);
    expect(out.corroboration).to.equal(1); // alice alone, rep 42 ≥ floor
    expect(out.publisherRep).to.equal(42n);
    expect(out.prominenceTier).to.equal(0);
    expect(out.maturedAt).to.equal(0n);
    expect(out.expiresAt).to.be.greaterThan(0n);
  });

  it("computeKeccakId matches the id assigned on publish", async function () {
    const { registry, ethers, alice } = env;
    const params = makeParams(ethers);
    const predicted = await registry.computeKeccakId(
      params.abType,
      params.flavor,
      params.primaryMatcherHash,
      alice.address,
    );
    const [actual] = await registry.connect(alice).publish.staticCall(params);
    expect(actual).to.equal(predicted);
  });

  it("getAntibodyByImmSeq round-trips", async function () {
    const { registry, ethers, alice } = env;
    const params = makeParams(ethers);
    const [id, immSeq] = await registry.connect(alice).publish.staticCall(params);
    await registry.connect(alice).publish(params);
    const ab = await registry.getAntibodyByImmSeq(immSeq);
    expect(ab.primaryMatcherHash).to.equal(params.primaryMatcherHash);
  });
});
