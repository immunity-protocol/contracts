import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import { namehash } from "ethers";

/// Unified deploy + wire + seed of the Immunity core network.
///
/// Deploys the seven core contracts (+ MockUSDC) in dependency order, then wires
/// every dependency, sets every param, seeds the protected list, and grants the
/// disclosed genesis reputation — all in one atomic Ignition run, so the network
/// is never left in a partial/half-wired state.
///
/// SERIALIZED: every step carries an explicit `after` so Ignition runs them in
/// strict sequence — one transaction outstanding at a time. This makes the deploy
/// robust on flaky/public RPCs: with no parallel batch, a dropped tx is simply
/// retried on the same nonce and no nonce gap (HHE10404) can form. It is slower
/// than a parallel deploy, but a one-time core deploy values reliability over speed.
///
/// Pass-1 deploy posture (swappable later without code change):
///   - USDC        = MockUSDC (public mint for demos)
///   - L2Registry  = StubL2Registry (real Durin swaps in via PublisherRegistrar.setL2Registry)
///   - CRE forwarder = the deployer EOA, zero workflow pins (so the E2E can drive
///     simulated Layer-1 verdicts; real KeystoneForwarder + pinned workflow = redeploy
///     the receiver, since its pins are immutable)
export default buildModule("ImmunityCore", (m) => {
  const deployer = m.getAccount(0);
  const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
  const ZERO_HASH = "0x0000000000000000000000000000000000000000000000000000000000000000";

  // ---- Tunable params (overridable via the parameters file) ----
  const parentNode = m.getParameter("parentNode", namehash("immunity.eth"));
  const protectedMultiplier = m.getParameter("protectedMultiplier", 1000n);
  const bondBase = m.getParameter("bondBase", 1_000_000n);
  const bondFloor = m.getParameter("bondFloor", 1_000_000n);
  const corroborationK = m.getParameter("corroborationK", 3);
  const minCorroborationRep = m.getParameter("minCorroborationRep", 1n);
  const volumeThreshold = m.getParameter("maturationVolumeThreshold", 0n);
  const genesisGrant = m.getParameter("genesisGrant", 100n);

  const challengeBondBps = m.getParameter("challengeBondBps", 10_000);
  const minChallengeBond = m.getParameter("minChallengeBond", 5_000_000n);
  const challengerBountyBps = m.getParameter("challengerBountyBps", 4_000);
  const jurorFeeBps = m.getParameter("jurorFeeBps", 3_000);
  const layer1FeeBps = m.getParameter("layer1FeeBps", 1_000);
  const supermajorityBps = m.getParameter("supermajorityBps", 6_700);
  const layer1Timeout = m.getParameter("layer1Timeout", 3_600);
  const layer2Timeout = m.getParameter("layer2Timeout", 3_600);

  const weth = m.getParameter("weth", "0x4200000000000000000000000000000000000006");
  const uniswapRouter = m.getParameter(
    "uniswapRouter",
    "0x2626664c2603336E57B271c5C0b26F421741e481",
  );

  const genesis0 = m.getParameter("genesis0", "0x18628A448938aD61C3AAd97Eca1f99DE310684B4");
  const genesis1 = m.getParameter("genesis1", "0xC325Fa14E5E48708b3e1cB16c6fde9D1bed5758E");
  const genesis2 = m.getParameter("genesis2", "0xA1E7E10e89dD7EFAc1e7CbDc34015Ce2A1773060");

  // ---- Deploy (strictly sequential via `after`) ----
  const usdc = m.contract("MockUSDC");
  const reputation = m.contract("Reputation", [], { after: [usdc] });
  const protectedSet = m.contract("ProtectedSet", [], { after: [reputation] });
  const l2registry = m.contract("StubL2Registry", [], { after: [protectedSet] });
  const registrar = m.contract("PublisherRegistrar", [usdc], { after: [l2registry] });
  const challengeManager = m.contract("ChallengeManager", [usdc], { after: [registrar] });
  const verifierPool = m.contract("VerifierPool", [], { after: [challengeManager] });
  const creReceiver = m.contract("CREVerdictReceiver", [deployer, ZERO_HASH, ZERO_ADDR], {
    after: [verifierPool],
  });
  const registry = m.contract(
    "ImmunityRegistry",
    [usdc, registrar, reputation, protectedSet, challengeManager],
    { after: [creReceiver] },
  );

  // ---- Wire + seed (each call after the previous → one tx at a time) ----
  const c1 = m.call(reputation, "setAuthorizedWriter", [registry, true], { after: [registry] });
  const c2 = m.call(registrar, "setReputation", [reputation], { after: [c1] });
  const c3 = m.call(registrar, "setL2Registry", [l2registry], { after: [c2] });
  const c4 = m.call(registrar, "setParentNode", [parentNode], { after: [c3] });
  const c5 = m.call(challengeManager, "setRegistry", [registry], { after: [c4] });
  const c6 = m.call(challengeManager, "setCreReceiver", [creReceiver], { after: [c5] });
  const c7 = m.call(challengeManager, "setVerifierPool", [verifierPool], { after: [c6] });
  const c8 = m.call(
    challengeManager,
    "setEconomics",
    [
      challengeBondBps,
      minChallengeBond,
      challengerBountyBps,
      jurorFeeBps,
      layer1FeeBps,
      supermajorityBps,
      layer1Timeout,
      layer2Timeout,
    ],
    { after: [c7] },
  );
  const c9 = m.call(creReceiver, "setChallengeManager", [challengeManager], { after: [c8] });
  const c10 = m.call(verifierPool, "setChallengeManager", [challengeManager], { after: [c9] });
  const c11 = m.call(registry, "setBondParams", [bondBase, bondFloor, protectedMultiplier], {
    after: [c10],
  });
  const c12 = m.call(
    registry,
    "setMaturationParams",
    [corroborationK, minCorroborationRep, volumeThreshold],
    { after: [c11] },
  );
  const c13 = m.call(protectedSet, "setProtectedBatch", [[usdc, weth, uniswapRouter], true], {
    after: [c12],
  });
  const c14 = m.call(reputation, "grantGenesisReputation", [genesis0, genesisGrant], {
    id: "genesis0",
    after: [c13],
  });
  const c15 = m.call(reputation, "grantGenesisReputation", [genesis1, genesisGrant], {
    id: "genesis1",
    after: [c14],
  });
  m.call(reputation, "grantGenesisReputation", [genesis2, genesisGrant], {
    id: "genesis2",
    after: [c15],
  });

  return {
    usdc,
    reputation,
    protectedSet,
    l2registry,
    registrar,
    challengeManager,
    verifierPool,
    creReceiver,
    registry,
  };
});
