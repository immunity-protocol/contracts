# ENS / Durin Integration (Base Sepolia)

Swap the live `PublisherRegistrar` off `StubL2Registry` and onto a **real Durin `L2Registry`** so that a
live `registerPublisher("alice")` mints a real, resolvable, **contract-owned** `alice.immunity.eth`
(CCIP-read: Sepolia ENS → Durin L1Resolver → the Base `L2Registry`).

Prereqs (already true): the deployer EOA owns `immunity.eth` on Sepolia, and the live registrar's
`parentNode` is already `namehash("immunity.eth")`.

## Step-0 API verdict — real Durin matches `IL2Registry` → **direct wiring, no adapter, no redeploy**

The deployed `PublisherRegistrar` binds to the minimal `contracts/interfaces/IL2Registry.sol`. Reviewing
the durin.dev contracts (`namestonehq/durin`, `src/L2Registry.sol` + the inherited ENS `TextResolver`),
every method the registrar uses matches:

| Registrar call (`PublisherRegistrar.sol`) | `IL2Registry` | Real namestonehq/durin `L2Registry` | Match |
|---|---|---|---|
| mint: `createSubnode(parentNode, label, address(this), new bytes[](0)) → node` | `createSubnode(bytes32,string,address,bytes[]) → bytes32` | `createSubnode(bytes32 node, string label, address _owner, bytes[] data) onlyOwnerOrRegistrar(node) returns (bytes32)` | ✅ exact |
| ownership read | `owner(bytes32 node) → address` | `owner(bytes32 node)` → `_ownerOf(uint256(node))` | ✅ exact |
| mirror write: `setText(node, "immunity.reputation"/"immunity.strikes", …)` | `setText(bytes32,string,string)` | inherited ENS `TextResolver.setText`, auth = node owner **or** approved registrar | ✅ |
| mirror read | `text(bytes32,string) → string` | inherited `TextResolver.text` | ✅ |
| authorize the registrar | (owner authorizes) | `addRegistrar(address) onlyOwner` + `registrars` mapping | ✅ exact |

**Why it works as-is:**
- The registrar mints with `owner = address(this)` → it *is* the subnode owner → its later `setText`
  passes the node-owner auth. A non-owner / non-registrar EOA `setText` reverts (B-5: un-forgeable
  reputation mirror; a slashed publisher can't transfer the name to escape history).
- `createSubnode`'s `onlyOwnerOrRegistrar(parentNode)` passes once the owner calls
  `addRegistrar(PublisherRegistrar)` on the Durin registry (the registrar isn't the parent-node owner).
- `createSubnode` returns the node; the registrar stores it (`nodeOf`). The `data` multicall is passed
  empty; records are written later by `syncReputation`.

**Conclusion:** neither an adapter (Path A) nor a registrar redeploy (Path B) is required.
The smallest, safest change is, on Base Sepolia:
`addRegistrar(PublisherRegistrar)` on the new Durin registry, then `setL2Registry(durin)` on the live
`PublisherRegistrar`. No new Solidity. The existing `PublisherRegistrar` unit/integration tests run
against `StubL2Registry`, which mirrors this exact API, so they remain the unit proof.

## Owner runbook (live; Base Sepolia + Sepolia ENS only — no mainnet)

Secrets via keystore/env only (`IMMUNITY_DEPLOYER_PK`, `IMMUNITY_BASE_SEPOLIA_RPC`, Alchemy `ENS_RPC_URL`,
`TEST_PK`) — never commit them.

1. **Deploy Durin (durin.dev).** Deploy an `L2Registry` for `immunity.eth` on Base Sepolia via the
   durin.dev wizard / `L2RegistryFactory`. In the same flow, connect `immunity.eth`'s **Sepolia** resolver
   to Durin's **L1Resolver** + CCIP gateway (this is what routes `*.immunity.eth` to Base). Record the
   addresses in the table below.
2. **Wire (deployer keystore):**
   ```
   DURIN_L2REGISTRY=0x… npx hardhat run scripts/wire-durin.ts --network baseSepolia
   ```
   Calls `addRegistrar(PublisherRegistrar)` on Durin, then `setL2Registry(durin)` on the live registrar.
   Paste the two tx hashes back.
3. **Verify E2E (test wallet + Alchemy Sepolia):**
   ```
   DURIN_L2REGISTRY=0x… TEST_PK=0x… ENS_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/KEY \
     npx hardhat run scripts/verify-ens.ts --network baseSepolia
   ```
   Asserts: `registerPublisher("imm-test")` mints a subname **owned by the PublisherRegistrar contract**
   (not the test wallet); a non-authorized EOA `setText` on that node **reverts**; and
   `imm-test.immunity.eth` **resolves via CCIP-read** from L1 (owner + `immunity.reputation`/`immunity.strikes`).

Keep `StubL2Registry` deployed as a fallback — do not delete it.

> ⚠️ Unblocks live-seed: the 3 genesis publishers' subnames must mint on **real Durin** so they resolve.
> `registerPublisher` reverts if already registered — do NOT seed on the stub and migrate later. Land this
> ENS swap first, then seed.

## Deployed addresses (fill after the durin.dev deploy)

| What | Address / URL |
|---|---|
| Durin `L2Registry` (Base Sepolia) | `0x… (TBD)` |
| Durin `L2Registrar` (if separate) | `0x… (n/a for namestonehq single-registry)` |
| Durin `L1Resolver` (Sepolia) | `0x… (TBD)` |
| CCIP gateway URL | `https://… (TBD)` |
| `PublisherRegistrar` (live, unchanged) | `0x35F65a08a11f44F73622f51ade1911BC28036faF` |
| `StubL2Registry` (fallback, unchanged) | `0xd37D0ad21179219796dD257E78357159bC8551e8` |

Mirror the final values into `contracts-v1-plan/DEPLOYED-base-sepolia.md` too.
