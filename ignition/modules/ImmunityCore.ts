import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import { namehash } from "ethers";

/// Unified deploy + wire + seed of the Immunity core network.
///
/// Deploys the seven core contracts (+ MockUSDC) in dependency order, then wires
/// every dependency, sets every param, seeds the protected list, and grants the
/// disclosed genesis reputation — all in one atomic Ignition run, so the network
/// is never left in a partial/half-wired state.
///
/// Pass-1 deploy posture (swappable later without code change):
///   - USDC        = MockUSDC (public mint for demos)
///   - L2Registry  = StubL2Registry (real Durin swaps in via PublisherRegistrar.setL2Registry)
///   - CRE forwarder = the deployer EOA, zero workflow pins (so the E2E can drive
///     simulated Layer-1 verdicts; real KeystoneForwarder + pinned workflow = redeploy
///     the receiver, since its pins are immutable)
export default buildModule("ImmunityCore", (m) => {
  const deployer = m.getAccount(0);

  // ---- Tunable params (overridable via the parameters file) ----
  const parentNode = m.getParameter("parentNode", namehash("immunity.eth"));
  const protectedMultiplier = m.getParameter("protectedMultiplier", 1000n);
  const bondBase = m.getParameter("bondBase", 1_000_000n);
  const bondFloor = m.getParameter("bondFloor", 1_000_000n);
  const corroborationK = m.getParameter("corroborationK", 3);
  const minCorroborationRep = m.getParameter("minCorroborationRep", 1n);
  const volumeThreshold = m.getParameter("maturationVolumeThreshold", 0n);
  const genesisGrant = m.getParameter("genesisGrant", 100n);

  // Economics (bps; bounty+juror+layer1 ≤ 10_000, treasury = remainder).
  const challengeBondBps = m.getParameter("challengeBondBps", 10_000);
  const minChallengeBond = m.getParameter("minChallengeBond", 5_000_000n);
  const challengerBountyBps = m.getParameter("challengerBountyBps", 4_000);
  const jurorFeeBps = m.getParameter("jurorFeeBps", 3_000);
  const layer1FeeBps = m.getParameter("layer1FeeBps", 1_000);
  const supermajorityBps = m.getParameter("supermajorityBps", 6_700);
  const layer1Timeout = m.getParameter("layer1Timeout", 3_600);
  const layer2Timeout = m.getParameter("layer2Timeout", 3_600);

  // Protected blue-chips to seed (Base): WETH + canonical Uniswap SwapRouter02.
  const weth = m.getParameter("weth", "0x4200000000000000000000000000000000000006");
  const uniswapRouter = m.getParameter(
    "uniswapRouter",
    "0x2626664c2603336E57B271c5C0b26F421741e481",
  );

  // The 3 disclosed genesis publishers (corroboration-K=3 reachable at launch).
  const genesis0 = m.getParameter("genesis0", "0x18628A448938aD61C3AAd97Eca1f99DE310684B4");
  const genesis1 = m.getParameter("genesis1", "0xC325Fa14E5E48708b3e1cB16c6fde9D1bed5758E");
  const genesis2 = m.getParameter("genesis2", "0xA1E7E10e89dD7EFAc1e7CbDc34015Ce2A1773060");

  // ---- Deploy (dependency order; CM before Registry to avoid the Registry↔CM circular) ----
  const usdc = m.contract("MockUSDC");
  const reputation = m.contract("Reputation");
  const protectedSet = m.contract("ProtectedSet");
  const l2registry = m.contract("StubL2Registry");
  const registrar = m.contract("PublisherRegistrar", [usdc]);
  const challengeManager = m.contract("ChallengeManager", [usdc]);
  const verifierPool = m.contract("VerifierPool");
  const creReceiver = m.contract("CREVerdictReceiver", [
    deployer, // forwarder = deployer EOA (pass-1)
    "0x0000000000000000000000000000000000000000000000000000000000000000", // workflowId pin disabled
    "0x0000000000000000000000000000000000000000", // workflowOwner pin disabled
  ]);
  const registry = m.contract("ImmunityRegistry", [
    usdc,
    registrar,
    reputation,
    protectedSet,
    challengeManager, // real CM wired via constructor
  ]);

  // ---- Wire (Ignition orders by future refs) ----
  m.call(reputation, "setAuthorizedWriter", [registry, true]);

  m.call(registrar, "setReputation", [reputation]);
  m.call(registrar, "setL2Registry", [l2registry]);
  m.call(registrar, "setParentNode", [parentNode]);

  m.call(challengeManager, "setRegistry", [registry]);
  m.call(challengeManager, "setCreReceiver", [creReceiver]);
  m.call(challengeManager, "setVerifierPool", [verifierPool]);
  m.call(challengeManager, "setEconomics", [
    challengeBondBps,
    minChallengeBond,
    challengerBountyBps,
    jurorFeeBps,
    layer1FeeBps,
    supermajorityBps,
    layer1Timeout,
    layer2Timeout,
  ]);

  m.call(creReceiver, "setChallengeManager", [challengeManager]);
  m.call(verifierPool, "setChallengeManager", [challengeManager]);

  m.call(registry, "setBondParams", [bondBase, bondFloor, protectedMultiplier]);
  m.call(registry, "setMaturationParams", [corroborationK, minCorroborationRep, volumeThreshold]);

  // ---- Seed ----
  m.call(protectedSet, "setProtectedBatch", [[usdc, weth, uniswapRouter], true]);

  m.call(reputation, "grantGenesisReputation", [genesis0, genesisGrant], { id: "genesis0" });
  m.call(reputation, "grantGenesisReputation", [genesis1, genesisGrant], { id: "genesis1" });
  m.call(reputation, "grantGenesisReputation", [genesis2, genesisGrant], { id: "genesis2" });

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
