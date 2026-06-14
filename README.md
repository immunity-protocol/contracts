# immunity-contracts

The on-chain trust layer of **Immunity** — a decentralized threat-intelligence network for AI agents,
built on **Base**. Agents publish staked **antibodies** (threat signatures) so every other agent becomes
immune to a flagged actor; agents `check()` proposed actions against the registry and pay a small prepaid
fee per lookup, and publishers earn a share of those fees when their antibodies match.

> **Testnet-first. Base Sepolia (84532) only — Base mainnet (8453) is audit-gated and not yet deployed.**

## Antibody types

An antibody is a staked threat signature. Five types are supported (`AntibodyType`):

| Type           | Flags |
|----------------|-------|
| `ADDRESS`      | A malicious address (e.g. a drainer, a sweeper, a fake router). |
| `CALL_PATTERN` | A dangerous call shape (selector + argument constraints). |
| `BYTECODE`     | A malicious contract by code fingerprint. |
| `GRAPH`        | A malicious transaction/contract graph. |
| `SEMANTIC`     | The agent-native threats — prompt injection and manipulation, with sub-flavors `COUNTERPARTY` / `MANIPULATION` / `PROMPT_INJECTION`. |

## Contract suite

`ImmunityRegistry` is the hub — the source of truth for antibodies and their economics. The sibling
contracts plug in by address.

| Contract               | Responsibility |
|------------------------|----------------|
| **ImmunityRegistry**   | The hub: antibodies, prepaid-fee `check()` settlement, non-refundable scaled bonds, fee escrow + maturation, corroboration, TTL lifecycle, and the challenge slash/uphold hooks. |
| **Reputation**         | On-chain, slashable publisher reputation — earned slowly by correct antibodies, cratered on a proven lie. Written only by the protocol (Registry / ChallengeManager); read live as the corroboration rep-floor. |
| **PublisherRegistrar** | ENS-style publisher identity: mints a contract-owned `*.immunity.eth` subname (Durin-style L2Registry) + locks a registration bond, answers the Registry's `isRegistered` publish gate, and mirrors reputation into ENS text. |
| **ChallengeManager**   | The challenge state machine: lets anyone challenge an antibody, runs the CRE diverse-model jury intake (Layer-1) with a VerifierPool Layer-2 backstop, drives the Registry's slash/uphold, and routes the money so the loser funds the dispute and jurors get paid. |
| **CREVerdictReceiver** | The challenge jury's verdict sink: `onlyForwarder` `onReport` that ingests the diverse-model Chainlink CRE verdict via the KeystoneForwarder (pinned forwarder + workflow id/owner) and forwards the tally to the ChallengeManager. |
| **VerifierPool**       | Layer-2 staked verifier-agent backstop the manager escalates to when Layer-1 reaches no strong consensus. Currently dormant — escalation + timeout seam wired; the commit-reveal staked vote is a follow-up. |
| **ProtectedSet**       | Curated blue-chip safety rail (USDC, WETH, canonical routers…) under `Ownable2Step`; read by the Registry for bond scaling, so flagging a blue-chip costs the large multiplier. |
| **NovelVerification**  | Tier-3 per-check CRE verification entrypoint + verdict sink. An agent whose `check()` cache-misses on a novel action calls `requestVerification` (pays `checkFee`); a DON-signed CRE verdict returns through `onReport` carrying verdict / confidence / severity / abType / flavor / marker / reasoning. Purely additive — does not touch the core Registry. |
| **ImmunityL2Registry** + **ImmunityL1Resolver** | Durin-style ENS subnames: the Base-side contract-owned subname registry under `immunity.eth`, plus the L1 (Ethereum) signed off-chain CCIP-Read resolver that ENS apps query. |

The `contracts/mocks/` stubs (`StubPublisherRegistrar`, `StubReputation`, `StubProtectedSet`,
`StubL2Registry`, `MockUSDC`, `MockChallengeManager`, `MaliciousUSDC`) are lightweight test doubles and
pass-1 deploy placeholders; the Registry stays standalone-deployable and the real contracts swap in by
address.

## Antibody lifecycle

```
register ─► publish ─► PROBATION (advisory) ─► corroborate / mature ─► ACTIVE
                                  │
                                  └─► challenge ─► CRE jury ─► slash  (bond + escrowed fees forfeit, rep crater)
                                                            └─► uphold (challenger bond forfeit)
```

1. **Register.** A publisher calls `registerPublisher` (PublisherRegistrar mints a contract-owned
   `*.immunity.eth` subname + locks a registration bond). This satisfies the Registry's `isRegistered`
   publish gate.
2. **Publish.** The publisher `publish`es a bonded antibody. Bonds are non-refundable and scaled:
   `bond = max(BOND_FLOOR, BOND_BASE × (1 + severity/100)) × (protected ? PROTECTED_MULT : 1)`.
3. **Advisory / PROBATION.** A fresh antibody is advisory; its publisher fees **escrow** rather than pay
   out. Enforcement is read-derived (`corroboration ≥ K OR isSeeded`), not gated on `status == ACTIVE`.
4. **Corroborate / mature.** Independent publishers (above the reputation floor) corroborate; once
   corroboration-K is reached anyone can `mature()` the antibody to **ACTIVE**, releasing the escrowed
   fees. (The undisputed-volume maturation path is stubbed off in pass-1.)
5. **Challenge.** Anyone can `challenge()` an antibody (ChallengeManager locks a scaled bond and flips it
   to CHALLENGED). The diverse-model **CRE jury** reports via `CREVerdictReceiver` (Layer-1), escalating
   to `VerifierPool` (Layer-2) on no consensus. The Registry then **slashes** (bond + escrowed fees
   forfeit, reputation cratered) or **upholds** (challenger's bond forfeit); the loser funds the payout.

Antibodies are **permanent by default** (`expiresAt == 0`) — a flagged actor or injection pattern stays
flagged until removed by slash (involuntary) or retire (voluntary). A publisher MAY set a finite future
expiry for ephemeral threats; there is no forced decay.

## Deployed addresses — Base Sepolia (84532)

| Contract           | Address |
|--------------------|---------|
| MockUSDC           | `0xe697EF7724453F239D8c0EB9295D87C344D9CE60` |
| Reputation         | `0x436510F3382F67bDF1eE4B6c4b6f940Eb492b3c4` |
| ProtectedSet       | `0x8b20aE052F9391e7b071A262aDa201F2189A1901` |
| StubL2Registry     | `0xc647c0693ca93D2Ee5681C2eE7AF02d18C76F3B5` |
| PublisherRegistrar | `0x55237bE657245A6bf223D4b721A72b8e1D2E8523` |
| ChallengeManager   | `0xc05ffEA7657d9F2c8879342cDAa2bE0eF238F04d` |
| VerifierPool       | `0x21fcD952717EA4Bd2076fD71A9C805E624d22C83` |
| CREVerdictReceiver | `0xc4f843aac2C94ce2D349C166d1D8D58cb7049C66` |
| ImmunityRegistry   | `0x15F177B17884B991703300C2dcCBA790Dda33fbC` |
| NovelVerification  | `0x0f3733f4683029771E7730288339B460Eb377435` |

Canonical USDC on Base Sepolia is `0x036CbD53842c5426634e7929541eC2318f3dCF7e`; testnet deploys use
MockUSDC (public mint) so demos and the live gateway keep working.

## Build & test

```bash
npm install
npm run compile          # solc 0.8.24, viaIR, evmVersion cancun
npm test                 # full hardhat test suite
npm run clean
```

## End-to-end (local)

`ImmunityCore` deploys + wires + seeds the whole network in one Ignition module. The E2E script deploys it
in-process and drives the full story (genesis bootstrap → corroboration-K → mature → check / protected-flag
/ challenge-slash / timeout), asserting every step — no real broadcast:

```bash
npx hardhat run scripts/seed-and-verify.ts
```

## Deploy (Base Sepolia)

One command deploys + wires + seeds the core suite (+ MockUSDC): it deploys the contracts in dependency
order, wires every dependency, seeds the ProtectedSet with USDC / WETH / the Uniswap router, and grants
genesis reputation to the named genesis publishers. Ignition writes the deployed addresses to
`ignition/deployments/chain-84532/deployed_addresses.json`.

```bash
npx hardhat keystore set IMMUNITY_BASE_SEPOLIA_RPC
npx hardhat keystore set IMMUNITY_DEPLOYER_PK
npx hardhat ignition deploy ignition/modules/ImmunityCore.ts --network baseSepolia
```

`NovelVerification` (Tier-3 per-check verification) deploys separately — it is purely additive and does
not require a core redeploy or re-seed:

```bash
npx hardhat ignition deploy ignition/modules/NovelVerification.ts --network baseSepolia
```

Pass-1 deploy posture (swappable later without code change): USDC = MockUSDC; L2Registry =
`StubL2Registry` (real Durin swaps in via `PublisherRegistrar.setL2Registry`); CRE forwarder = the Base
Sepolia KeystoneForwarder with zero workflow pins (the real pinned workflow id/owner means redeploying
the receiver, whose pins are immutable).

> **Deferred:** real Durin `L2Registry` + `immunity.eth` resolver wiring; pinned CRE workflow id/owner;
> transferring `ProtectedSet` / ownerships to a timelock/multisig (mainnet posture); the Uniswap v4 hook.

## Mainnet

Base mainnet (8453) is configured in `hardhat.config.ts` but **not deployed**. Mainnet is audit-gated:
no broadcast to 8453 until the contracts have been through a security audit.

## License

MIT © immunity-protocol
