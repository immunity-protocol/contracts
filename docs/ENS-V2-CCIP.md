# ENS v2 + CCIP — be our own durin (Base Sepolia)

`immunity.eth` is an **ENS v2 (Namechain)** name. The durin.dev hosted factory/gateway only speaks the
classic ENS registry, so its wizard cannot "connect" a v2 name — it never finds `immunity.eth`. But durin
*under the hood* is just a pattern: a self-owned **L2 registry** on Base (holds the subname nodes + text)
plus an **L1 CCIP-read resolver** wired into the ENS name. We drop the hosted dependency and **deploy those
two pieces ourselves** — so the protocol owns its identity layer outright and nothing depends on a
third-party service surviving the v2 migration.

The deployer owns `immunity.eth` in the ENS v2 registry (gasless mint via app.ens.dev) with `setResolver`
available, and the live registrar's `parentNode` is already `namehash("immunity.eth")`.

## Invariant — conform to the live `IL2Registry`

The deployed `PublisherRegistrar` is wired into `ImmunityRegistry` and binds to the minimal
`contracts/interfaces/IL2Registry.sol`. Anything we deploy in its place must satisfy that ABI **exactly**,
so the switch is a single `setL2Registry(ours)` — **no registrar redeploy**.

| Registrar call | `IL2Registry` | `ImmunityL2Registry` | Match |
|---|---|---|---|
| mint: `createSubnode(parentNode, label, address(this), new bytes[](0)) → node` | `createSubnode(bytes32,string,address,bytes[]) → bytes32` | registrar-or-admin gated; `data` accepted, unused | ✅ |
| ownership read | `owner(bytes32 node) → address` | `owner(bytes32)` mapping (NOT ERC-721) | ✅ |
| mirror write: `setText(node, "immunity.reputation"/"immunity.strikes", …)` | `setText(bytes32,string,string)` | node-owner **or** approved registrar | ✅ |
| mirror read | `text(bytes32,string) → string` | `text(bytes32,string)` | ✅ |
| authorize the registrar | (owner authorizes) | `addRegistrar(address) onlyAdmin` + `registrars` mapping | ✅ |

`StubL2Registry` mirrors the same ABI and stays as the unit-test stand-in; `ImmunityL2Registry` is the
productionized version (adds admin/ownership, events, custom-error reverts). Both keep the `owner(bytes32)`
mapping shape — this is a display/identity mirror; **canonical reputation is the on-chain `Reputation`
contract**, ENS is only a mirror.

## Stopping ladder — know when "done enough" is reached

### Phase 1 — PROTOCOL-CRITICAL (the firm deliverable)

Contract-owned subnames + registrar-only text writes **on Base** — the B-5 identity / anti-flight
guarantees. These hold regardless of whether the name resolves in third-party ENS apps.

1. **`ImmunityL2Registry` (Base Sepolia)** — productionized from `StubL2Registry`; subname nodes + text
   live here, written only by an approved registrar.
2. Deploy it; `addRegistrar(PublisherRegistrar)`; `setL2Registry(ImmunityL2Registry)` on the live
   registrar (`scripts/ens/wire-base.ts`). **No registrar redeploy.**
3. Prove on-chain: `registerPublisher` mints a subname whose `owner(node)` == the PublisherRegistrar
   (contract-owned, not the publisher EOA); a non-registrar EOA `setText` **reverts**; `syncReputation`
   writes `immunity.reputation` / `immunity.strikes` (`scripts/ens/verify-base.ts`).

**Done-1 = these pass.** Everything below is optional.

### Phase 2 — PRIZE/DEMO CHERRY (timeboxed; hard stop)

`<label>.immunity.eth` actually **resolving via CCIP-read in standard ENS tooling** (the ENS-booth story).

- **SPIKE FIRST (make-or-break):** confirm the exact ENS v2 contract/method controlling `immunity.eth`'s
  resolver, that `setResolver` is callable by the deployer, and that v2 honors a custom L1 resolver +
  ENSIP-10 wildcard + EIP-3668 OffchainLookup on the name. Set a trivial test resolver and confirm viem
  resolves both `immunity.eth` and a wildcard `x.immunity.eth` through it. **Commit the verdict either way.**
- If the spike passes: **`ImmunityL1Resolver` (Sepolia)** — vendor ENS/durin's reference OffchainResolver,
  point it at our gateway, `setResolver` on the v2 `.eth` registry.
- **CCIP gateway** — vendor the ENS `ccip-read` server, read our Base `ImmunityL2Registry`, return signed
  `addr`/`text`; host on fly.io (or a tunnel for the demo).
- Verify `genesis-0.immunity.eth` resolves via CCIP + text reads back.

**Hard stop:** if v2 CCIP resolution or gateway hosting fights us, fall back — **our own explorer resolves /
displays the names directly from the Base registry**, and the protocol loses nothing. Do NOT chase
mainnet-grade CCIP over the weekend.

## Owner runbook (Base Sepolia + Sepolia ENS only — no mainnet)

Secrets via keystore/env only (`IMMUNITY_DEPLOYER_PK`, `IMMUNITY_BASE_SEPOLIA_RPC`, Alchemy `ENS_RPC_URL`,
`TEST_PK`) — never commit them.

**Phase 1 (firm):**

1. **Deploy the registry (deployer keystore):**
   ```
   npx hardhat ignition deploy ignition/modules/ImmunityL2Registry.ts --network baseSepolia
   ```
   Admin defaults to deployer account 0. Record the address below.
2. **Wire:**
   ```
   IMMUNITY_L2REGISTRY=0x… npx hardhat run scripts/ens/wire-base.ts --network baseSepolia
   ```
   Calls `addRegistrar(PublisherRegistrar)` on our registry, then `setL2Registry(ours)` on the live
   registrar. Paste the two tx hashes back.
3. **Verify (test wallet):**
   ```
   IMMUNITY_L2REGISTRY=0x… TEST_PK=0x… npx hardhat run scripts/ens/verify-base.ts --network baseSepolia
   ```
   Asserts: `registerPublisher` mints a subname **owned by the PublisherRegistrar contract**; a
   non-authorized EOA `setText` **reverts**; the reputation mirror reads back.

**Phase 2 (cherry, only if the spike is green):** vendor `ImmunityL1Resolver` + gateway, `setResolver` on
`immunity.eth` (v2), then `npx hardhat run scripts/ens/verify-ccip.ts --network baseSepolia` to confirm
`genesis-0.immunity.eth` resolves via CCIP-read.

> ⚠️ Unblocks live-seed: the 3 genesis publishers' subnames must mint on `ImmunityL2Registry` so they're
> contract-owned. `registerPublisher` reverts if already registered — do NOT seed on the stub and migrate
> later. Land the Phase-1 swap first, then seed.

## Deployed addresses

| What | Address / URL |
|---|---|
| `ImmunityL2Registry` (Base Sepolia) | `0xa0A4CE62b6Fa02ed5ddFbb1DE6e56fC559033C06` |
| `ImmunityL1Resolver` (Sepolia, Phase 2) | `0x… (TBD)` |
| CCIP gateway URL (Phase 2) | `https://… (TBD)` |
| `immunity.eth` ENS v2 registry (`setResolver` target) | `0x… (confirm in the Phase-2 spike — do NOT assume)` |
| `PublisherRegistrar` (live, unchanged) | `0x35F65a08a11f44F73622f51ade1911BC28036faF` |
| `StubL2Registry` (test/fallback, unchanged) | `0xd37D0ad21179219796dD257E78357159bC8551e8` |

Mirror the final values into `contracts-v1-plan/DEPLOYED-base-sepolia.md` too.
