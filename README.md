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

`ImmunityRegistry` is the hub — the source of truth for antibodies and their economics. The sibling
contracts plug in by address.

| Contract              | What it does |
|-----------------------|--------------|
| **ImmunityRegistry**  | The hub: antibodies, prepaid-fee `check()` settlement, non-refundable scaled bonds, fee escrow + maturation, corroboration, TTL lifecycle, and the slash/uphold hooks. |
| **Reputation**        | On-chain, slashable publisher reputation — built slowly by correct antibodies, cratered on a proven lie. Written only by the protocol (Registry now, ChallengeManager later); read live as the corroboration rep-floor. |
| **PublisherRegistrar**| Publisher identity: mints a contract-owned `*.immunity.eth` subname (Durin L2) + locks a registration bond, answers the Registry's `isRegistered` publish gate, and mirrors reputation into ENS text. |
| **ChallengeManager**  | The challenge game: lets anyone challenge an antibody, runs the two-layer jury, drives the Registry's slash/uphold, and routes the money so the loser funds the dispute and jurors get paid. |
| **CREVerdictReceiver**| Layer-1 jury sink: ingests the diverse-model Chainlink CRE verdict via the KeystoneForwarder (pinned forwarder + workflow id/owner) and forwards the tally to the ChallengeManager. |
| **VerifierPool**      | Layer-2 staked-juror backstop the manager escalates to when Layer-1 reaches no strong consensus. (Pass-1: escalation + timeout seam; the commit-reveal staked vote is pass-2.) |
| **ProtectedSet**      | Curated blue-chip allowlist (USDC, WETH, canonical routers…) under `Ownable2Step` governance; read by the Registry for bond scaling so flagging a blue-chip costs the large multiplier. |
| Mirror + ImmunityHook | Uniswap v4 consumer — replicates Registry state to execution chains and gates swaps on `check()`. (Planned, step 8.) |

**How it fits together:** a publisher `registerPublisher`s (PublisherRegistrar mints a contract-owned
subname + locks a bond) → `publish`es a bonded antibody (Registry, gated on `isRegistered`) → agents
`check()` and settle fees → independent publishers corroborate and anyone can `mature()` → anyone can
`challenge()` (ChallengeManager locks a scaled bond, flips the antibody to CHALLENGED) → the diverse-model
CRE jury reports via CREVerdictReceiver (Layer-1), escalating to VerifierPool (Layer-2) on no consensus →
the Registry slashes or upholds, the loser funds the payout, and `Reputation` moves accordingly.

The `contracts/mocks/` stubs (`StubPublisherRegistrar`, `StubReputation`, `StubProtectedSet`,
`StubL2Registry`, `Mock*`) remain as lightweight test doubles and as the pass-1 deploy placeholders. The
Registry stays standalone-deployable; the real contracts swap in by address at the unified #9 deploy.

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
   antibody is enforced and is forfeited on slash. `bond = max(BOND_FLOOR, BOND_BASE × (1 + severity/100))
   × (protected ? PROTECTED_MULT : 1)`.
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
./scripts/deploy.sh                      # deploys MockUSDC + Registry (+ dependency stubs) — testnet
./scripts/deploy.sh --usdc 0xCANONICAL   # uses canonical Base USDC
```

Canonical USDC on Base Sepolia: `0x036CbD53842c5426634e7929541eC2318f3dCF7e`.

> The current `deploy.sh` deploys the Registry against pass-1 dependency stubs. The **unified suite deploy
> + wiring (#9)** — deploy all real contracts, `setDependencies`, seed the protected list + transfer its
> ownership to a multisig, pin the CRE forwarder/workflow, and `addRegistrar` on Durin — is forthcoming.

## License

MIT © immunity-protocol
