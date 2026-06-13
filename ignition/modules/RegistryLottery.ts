import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/// Registry-only redeploy for the earliness-weighted fee lottery (check()).
/// Deploys a FRESH ImmunityRegistry wired to the EXISTING, unchanged core
/// dependencies (USDC / Reputation / PublisherRegistrar / ProtectedSet /
/// ChallengeManager) — so publisher registrations + ENS names + reputation
/// scores all survive. Re-points the two cross-references that name the Registry:
///   - Reputation.setAuthorizedWriter(newRegistry, true)  (Registry writes rep)
///   - ChallengeManager.setRegistry(newRegistry)          (CM slashes via Registry)
/// and re-applies the bond + maturation params (constructor wires the deps).
///
/// Existing antibodies live in the OLD Registry and must be RE-SEEDED onto this
/// one (genesis corpus + EVIL) — a separate off-chain step after deploy.
export default buildModule("RegistryLottery", (m) => {
  const usdc = m.contractAt("MockUSDC", "0xe697EF7724453F239D8c0EB9295D87C344D9CE60");
  const reputation = m.contractAt("Reputation", "0x828666a9E2887F8dD03E61b0D9546C32CaDB52d3");
  const registrar = m.contractAt("PublisherRegistrar", "0x762CF28bE7502CC99B6286076e9b4Fb71EE84002");
  const protectedSet = m.contractAt("ProtectedSet", "0x95faC80e27419619A9108C53573bf9A77967397A");
  const challengeManager = m.contractAt("ChallengeManager", "0xc71c354fFf57652A64b214F654E1A68c7f3cef79");

  const registry = m.contract("ImmunityRegistry", [
    usdc,
    registrar,
    reputation,
    protectedSet,
    challengeManager,
  ]);

  // Match ImmunityCore's pass-1 params.
  m.call(reputation, "setAuthorizedWriter", [registry, true], { after: [registry] });
  const b = m.call(registry, "setBondParams", [1_000_000n, 1_000_000n, 1000n], { after: [registry] });
  m.call(registry, "setMaturationParams", [3, 25n, 0n], { after: [b] });
  m.call(challengeManager, "setRegistry", [registry], { after: [registry] });

  return { registry };
});
