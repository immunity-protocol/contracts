# immunity-contracts

The on-chain trust layer of [Immunity](https://immunity.xyz) — a decentralized threat-intelligence
network for AI agents — rebuilt on **Base**. Agents publish **antibodies** (threat signatures) so every
other agent becomes immune to a flagged actor; agents `check()` proposed transactions against the
registry and pay a small prepaid fee per lookup.

This repo is the v1 re-platform off the 0G stack:

| Concern  | Old (0G)        | New                          |
|----------|-----------------|------------------------------|
| Chain    | 0G Galileo      | **Base** (Sepolia → mainnet) |
| Storage  | 0G Storage      | **Lighthouse** (CID anchors) |
| Compute  | 0G Compute      | **Chainlink CRE** (verdicts) |

> **Testnet-first. Base Sepolia only — no mainnet deploy until audit-gated.**

## Contract suite

`ImmunityRegistry` is the hub — the source of truth for antibodies and their economics. It is built
first and standalone; sibling contracts plug in by address as they land.

| Contract             | Status      | Job |
|----------------------|-------------|-----|
| **ImmunityRegistry** | this repo   | antibodies, bonds, fee escrow/release, corroboration, maturation, lifecycle, TTL |
| Reputation           | later       | on-chain publisher reputation (Registry + ChallengeManager are the only writers) |
| PublisherRegistrar   | later       | Durin L2 subname + bonded registration; gates `publish` |
| ChallengeManager     | later       | challenge state machine; routes slash/uphold settlement |
| CREVerdictReceiver   | later       | Chainlink CRE verdict intake (diverse-model jury) |
| VerifierPool         | later       | staked Layer-2 verifiers (commit-reveal) |
| ProtectedSet         | later       | curated blue-chips; bond scaling + advisory-max |
| Mirror + ImmunityHook| later       | Uniswap v4 consumer |

In pass 1 the Registry's three dependencies (`IPublisherRegistrar`, `IReputation`, `IProtectedSet`) are
defined as interfaces and backed by simple stub implementations (`contracts/mocks/`) so the Registry
compiles, tests, and deploys on its own. Real implementations swap in by constructor address later.

## Why the Registry is shaped this way

The attack that drives the design: a $1 actor flags a *genuine* address (say the Uniswap router) as
malicious. In the old registry that was a **winning** move — everyone blocked real trades, the liar
collected a share of every check fee, and the $1 stake was **refunded** after 72h. Lying was free,
profitable, and uncorrectable. v1 makes honesty profitable and lying ruinous via three structural
changes:

1. **Corroboration set, not first-claimer.** Many publishers may flag the same target. Independent
   echoes (corroboration) are what earn an antibody the right to hard-block, and front-running the fee
   stream dies.
2. **Non-refundable scaled bond, not a refundable stake.** The bond stays at risk the whole time the
   antibody is enforced and is forfeited on slash. `bond = max(BOND_FLOOR, BOND_BASE × severity) ×
   (protected ? PROTECTED_MULT : 1)`.
3. **Fee escrow + maturation, not immediate payout.** An unproven (PROBATION) antibody's publisher fees
   escrow; they release only on **maturation** (positive signal — corroboration-K), and are **clawed
   back** on slash. A false antibody earns **zero**, ever.

**Enforcement (advisory vs hard-block) is read-derived**, never gated on `status == ACTIVE`. The
contract stores facts + money and exposes the inputs via `getEnforcementInputs`; the SDK and the Uniswap
hook derive hard-block eligibility as `corroboration ≥ K OR isSeeded` (genesis). A freshly-corroborated
real threat is protected instantly — the `mature()` poke and the ACTIVE flip are a financial settlement,
not the switch that turns protection on. (Keying on `ACTIVE` would be wrong: a later pass can reach ACTIVE
via time/volume maturation without corroboration, which must not grant censorship power.)

Antibodies are **permanent by default** (`expiresAt == 0`) — a bad actor or injection pattern stays
flagged until removed by slash (involuntary) or retire (voluntary). A publisher MAY set a finite future
expiry for ephemeral threats; there is no forced decay.

> **Pass-1 maturation is corroboration-K only.** The undisputed-volume path is stubbed off
> (`maturationVolumeThreshold = 0`). This is fine for testnet, but **a launch blocker for a real
> network**: with it off, nothing matures except via K independent corroborators. Wiring the volume path
> (and prominence-by-volume bond scaling) is a pass-2 must-do.

## Build & test

```bash
npm install
npm run compile          # solc 0.8.24, viaIR, evmVersion cancun
npm test
```

## Deploy (Base Sepolia)

```bash
npx hardhat keystore set IMMUNITY_BASE_SEPOLIA_RPC
npx hardhat keystore set IMMUNITY_DEPLOYER_PK
./scripts/deploy.sh                      # deploys MockUSDC + Registry (testnet)
./scripts/deploy.sh --usdc 0xCANONICAL   # uses canonical Base USDC
```

Canonical USDC on Base Sepolia: `0x036CbD53842c5426634e7929541eC2318f3dCF7e`.

## License

MIT © immunity-protocol
