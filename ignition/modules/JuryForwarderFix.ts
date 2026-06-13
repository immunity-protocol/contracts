import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/// Redeploy the jury verdict sink with the CORRECT forwarder and re-wire it.
///
/// The original `CREVerdictReceiver` (in the ImmunityCore deploy) trusts the
/// deployer EOA as its forwarder — but `cre workflow simulate --broadcast`
/// transmits the DON-signed report THROUGH the CRE KeystoneForwarder, so the
/// report's msg.sender is the forwarder, never the broadcaster. With the wrong
/// forwarder, `onReport` reverts `NotForwarder` inside the forwarder (swallowed)
/// and the jury verdict never lands. This redeploys the receiver trusting the
/// real KeystoneForwarder and points the live ChallengeManager at it.
///
/// PURELY a re-wire: ChallengeManager/Registry/antibodies are untouched (no
/// re-seed). The old receiver `0x02ED0a…` is orphaned.
const KEYSTONE_FORWARDER = "0x82300bd7c3958625581cc2F77bC6464dcEcDF3e5";
const CHALLENGE_MANAGER = "0xc71c354fFf57652A64b214F654E1A68c7f3cef79";
const ZERO_HASH =
  "0x0000000000000000000000000000000000000000000000000000000000000000";
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

export default buildModule("JuryForwarderFix", (m) => {
  // Forwarder-only auth (zero workflow pins) — same posture as the per-check sink.
  const receiver = m.contract("CREVerdictReceiver", [
    KEYSTONE_FORWARDER,
    ZERO_HASH,
    ZERO_ADDR,
  ]);
  m.call(receiver, "setChallengeManager", [CHALLENGE_MANAGER]);

  const challengeManager = m.contractAt("ChallengeManager", CHALLENGE_MANAGER);
  m.call(challengeManager, "setCreReceiver", [receiver]);

  return { receiver };
});
