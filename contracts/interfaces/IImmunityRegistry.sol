// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IImmunityRegistry — external interface for the Immunity registry on Base.
/// @notice Antibody envelope, publisher prepaid balances, non-refundable scaled
///         bonds, fee escrow + maturation, corroboration, TTL lifecycle, and the
///         challenge hooks the ChallengeManager calls. Enforcement strength
///         (advisory vs hard-block) is NOT decided here — it is derived read-side
///         by the SDK/Hook from the inputs this contract exposes.
interface IImmunityRegistry {
    // ------------------------------------------------------------------
    //  Enums
    // ------------------------------------------------------------------

    /// @notice Top-level antibody classification.
    enum AntibodyType {
        ADDRESS,        // 0 — blacklisted wallet
        CALL_PATTERN,   // 1 — function selector + args fingerprint
        BYTECODE,       // 2 — runtime bytecode hash for clone detection
        GRAPH,          // 3 — taint topology
        SEMANTIC        // 4 — manipulation embedding / structural markers
    }

    /// @notice Determination produced by the reviewer.
    enum Verdict {
        MALICIOUS,      // 0
        SUSPICIOUS      // 1
    }

    /// @notice Antibody lifecycle status.
    /// @dev PROBATION → ACTIVE (matured) → CHALLENGED → {SLASHED | back}; terminal
    ///      off-ramps EXPIRED (TTL) and SLASHED. Enforcement is read-derived, NOT
    ///      gated on ACTIVE — see `getEnforcementInputs`.
    enum Status {
        PROBATION,      // 0 — published, advisory, fees escrow
        ACTIVE,         // 1 — matured, escrow released, fees pay directly
        CHALLENGED,     // 2 — under challenge (set by ChallengeManager)
        SLASHED,        // 3 — proven false; bond + escrow forfeited
        EXPIRED         // 4 — past TTL
    }

    // ------------------------------------------------------------------
    //  Structs
    // ------------------------------------------------------------------

    /// @notice Stored antibody envelope. Off-chain consumers hydrate richer data
    ///         from Lighthouse via `evidenceCid` / `contextHash` (CID anchors).
    /// @dev Field ordering targets 9 packed storage slots.
    struct Antibody {
        bytes32 primaryMatcherHash;     // slot 0 — keccak of canonicalized matcher
        bytes32 evidenceCid;            // slot 1 — Lighthouse CID anchor (public envelope)
        bytes32 contextHash;            // slot 2 — Lighthouse CID anchor (encrypted context)
        bytes32 embeddingHash;          // slot 3 — SEMANTIC only; zero if unused
        bytes32 attestation;            // slot 4 — reviewer attestation hash
        address publisher;              // slot 5 — packed: publisher(20)+immSeq(4)+createdAt(8)
        uint32  immSeq;
        uint64  createdAt;
        address reviewer;               // slot 6 — packed: reviewer(20)+expiresAt(8)+4×uint8
        uint64  expiresAt;              //          0 = permanent (slash/retire only); else future
        uint8   abType;                 //          AntibodyType
        uint8   flavor;                 //          sub-type for SEMANTIC, ignored otherwise
        uint8   verdict;                //          Verdict
        uint8   confidence;             //          0..100
        uint96  bondAmount;             // slot 7 — packed: bond(12)+escrow(12)+maturedAt(8)
        uint96  escrowedFees;           //          publisher fees held until maturation
        uint64  maturedAt;              //          0 = not matured
        uint8   severity;               // slot 8 — packed (4 bytes): severity/status/seeded/prominence
        uint8   status;                 //          Status
        uint8   isSeeded;               //          1 if genesis-seeded (no bond, no escrow)
        uint8   prominenceTier;         //          cached at publish (0 normal, 1 protected)
    }

    /// @notice Calldata shape used by `publish` and `seedAntibody`.
    struct PublishParams {
        uint8   abType;
        uint8   flavor;
        uint8   verdict;
        uint8   confidence;
        uint8   severity;
        bytes32 primaryMatcherHash;
        bytes32 evidenceCid;
        bytes32 contextHash;
        bytes32 embeddingHash;
        bytes32 attestation;
        uint64  expiresAt;              // 0 = permanent; a finite value must be in the future
        address reviewer;
        bytes32 auxiliaryKey;           // typed dispatch — see auxiliary events
    }

    /// @notice Denormalized publisher display metrics. Authoritative reputation
    ///         lives in the Reputation contract; these are for explorer/UI only.
    struct PublisherStats {
        uint128 totalBonded;            // cumulative USDC bonded across publishes
        uint128 totalEarned;            // cumulative USDC reward income (released escrow + direct)
        uint64  publishedCount;
        uint64  slashedCount;
    }

    // ------------------------------------------------------------------
    //  Events — publish + typed auxiliary
    // ------------------------------------------------------------------

    /// @notice Emitted on every successful publish (and seed). Carries the whole
    ///         envelope so the indexer never needs a follow-up RPC.
    event Published(
        bytes32 indexed keccakId,
        uint32  indexed immSeq,
        address indexed publisher,
        uint8   abType,
        uint8   flavor,
        uint8   verdict,
        uint8   severity,
        uint8   confidence,
        address reviewer,
        bytes32 primaryMatcherHash,
        bytes32 evidenceCid,
        bytes32 contextHash,
        bytes32 embeddingHash,
        bytes32 attestation,
        uint256 bond,
        uint64  expiresAt,
        uint64  createdAt,
        bool    isSeeded
    );

    // Auxiliary events: exactly one per publish, dispatched on `abType`. The
    // Mirror contracts on execution chains emit the same signatures so indexers
    // see uniform shapes across all chains.

    event AddressBlocked(address indexed target, bytes32 indexed keccakId, address indexed publisher);
    event CallPatternBlocked(bytes4 indexed selector, bytes32 indexed keccakId, address indexed publisher);
    event BytecodeBlocked(bytes32 indexed bytecodeHash, bytes32 indexed keccakId, address indexed publisher);
    event GraphTaintAdded(bytes32 indexed taintSetId, bytes32 indexed keccakId, address indexed publisher);
    event SemanticPatternAdded(uint8 indexed flavor, bytes32 indexed keccakId, address indexed publisher);

    // ------------------------------------------------------------------
    //  Events — check / settlement
    // ------------------------------------------------------------------

    /// @notice The three telemetry params are SDK-derived observable facts; the
    ///         contract stores them in the log but NEVER treats them as truth
    ///         (A-6). `tokenAddress` gets an indexed slot for "all USDC" queries.
    event Checked(
        address indexed agent,
        bytes32 indexed antibodyId,
        address indexed tokenAddress,
        bool    wasMatch,
        uint256 fee,
        uint256 originChainId,
        uint256 tokenAmount,
        uint64  timestamp
    );

    /// @notice A check matched an antibody. `escrowed` is true while the antibody
    ///         is on PROBATION (publisher share held), false once matured (paid).
    event Matched(
        bytes32 indexed keccakId,
        address indexed agent,
        address indexed publisher,
        address tokenAddress,
        uint256 tokenAmount,
        uint256 originChainId,
        uint256 publisherShare,
        uint256 treasuryShare,
        bool    escrowed
    );

    // ------------------------------------------------------------------
    //  Events — lifecycle + economics
    // ------------------------------------------------------------------

    event Matured(bytes32 indexed keccakId, address indexed publisher, uint256 releasedFees, uint64 maturedAt);
    event Expired(bytes32 indexed keccakId, address indexed publisher, uint256 bondReleased, uint256 escrowClawedBack);
    event Retired(bytes32 indexed keccakId, address indexed publisher, uint256 bondReleased);
    event ChallengeOpened(bytes32 indexed keccakId);
    event ChallengeUpheld(bytes32 indexed keccakId, address indexed publisher);
    event Slashed(
        bytes32 indexed keccakId,
        address indexed publisher,
        address indexed challenger,
        uint256 bondForfeited,
        uint256 escrowClawedBack
    );

    event BondLocked(bytes32 indexed keccakId, address indexed publisher, uint256 amount);
    event BondReleased(bytes32 indexed keccakId, address indexed publisher, uint256 amount);
    event FeesEscrowed(bytes32 indexed keccakId, address indexed publisher, uint256 amount);
    event FeesReleased(bytes32 indexed keccakId, address indexed publisher, uint256 amount);
    event FeesClawedBack(bytes32 indexed keccakId, address indexed publisher, uint256 amount);

    event Deposited(address indexed operator, uint256 amount);
    event Withdrew(address indexed operator, uint256 amount);
    event TreasuryWithdrawn(address indexed to, uint256 amount);
    event Seeded(bytes32 indexed keccakId, uint32 indexed immSeq);

    // ------------------------------------------------------------------
    //  Events — admin params
    // ------------------------------------------------------------------

    event DependenciesUpdated(address registrar, address reputation, address protectedSet, address challengeManager);
    event BondParamsUpdated(uint256 bondBase, uint256 bondFloor, uint256 protectedMultiplier);
    event MaturationParamsUpdated(uint16 corroborationK, uint256 minCorroborationRep, uint256 volumeThreshold);

    // ------------------------------------------------------------------
    //  State-changing — operator balance
    // ------------------------------------------------------------------

    function deposit(uint256 amount) external;
    function withdraw(uint256 amount) external;

    // ------------------------------------------------------------------
    //  State-changing — publish / check / lifecycle
    // ------------------------------------------------------------------

    function publish(PublishParams calldata params)
        external
        returns (bytes32 keccakId, uint32 immSeq);

    /// @param antibodyId     a known antibody keccak id, or `bytes32(0)` for no-match
    /// @param tokenAddress   the ERC20 being interacted with, or `address(0)` for native
    /// @param tokenAmount    amount in the token's native decimals; `0` when no facts decoded
    /// @param originChainId  chain id the proposed tx would execute on; `0` when unknown
    function check(
        bytes32 antibodyId,
        address tokenAddress,
        uint256 tokenAmount,
        uint256 originChainId
    ) external returns (bool settled);

    /// @notice Permissionless idempotent poke: PROBATION → ACTIVE when corroboration
    ///         conditions hold and the antibody is not challenged. Releases escrow.
    function mature(bytes32 antibodyId) external;

    /// @notice TTL off-ramp for a single antibody. Releases bond; claws escrow to
    ///         treasury if it never matured. Clears the matcher set.
    function expire(bytes32 antibodyId) external;

    /// @notice Batched permissionless TTL poke over an explicit id list.
    function sweepExpired(bytes32[] calldata antibodyIds) external returns (uint256 numExpired);

    /// @notice Publisher voluntarily retires their own un-challenged antibody.
    function retire(bytes32 antibodyId) external;

    // ------------------------------------------------------------------
    //  State-changing — ChallengeManager hooks
    // ------------------------------------------------------------------

    function onChallengeOpened(bytes32 antibodyId) external;

    /// @param invalid     true → antibody proven false (slash); false → upheld
    /// @param challenger  recipient of the forfeited bond + escrow on slash
    function onChallengeResolved(bytes32 antibodyId, bool invalid, address challenger) external;

    // ------------------------------------------------------------------
    //  State-changing — admin
    // ------------------------------------------------------------------

    function seedAntibody(PublishParams calldata params)
        external
        returns (bytes32 keccakId, uint32 immSeq);

    function withdrawTreasury(uint256 amount, address to) external;

    function pause() external;
    function unpause() external;

    function setDependencies(
        address registrar,
        address reputation,
        address protectedSet,
        address challengeManager
    ) external;

    function setBondParams(uint256 bondBase, uint256 bondFloor, uint256 protectedMultiplier) external;

    function setMaturationParams(
        uint16 corroborationK,
        uint256 minCorroborationRep,
        uint256 volumeThreshold
    ) external;

    // ------------------------------------------------------------------
    //  Views
    // ------------------------------------------------------------------

    function getAntibody(bytes32 keccakId) external view returns (Antibody memory);

    function getAntibodyByImmSeq(uint32 immSeq) external view returns (Antibody memory);

    /// @notice The corroboration set: every antibody keccakId flagging this matcher.
    function getAntibodiesByMatcher(bytes32 matcherHash) external view returns (bytes32[] memory);

    /// @notice Distinct registered publishers flagging `matcherHash` whose current
    ///         reputation is at or above the corroboration rep-floor. Evaluated
    ///         live, so a slashed/decayed corroborator stops counting. On-chain
    ///         this enforces distinct-address + rep-floor only — true independence
    ///         rests on the bond + earned-rep cost + the genesis bootstrap.
    function corroborationOf(bytes32 matcherHash) external view returns (uint16);

    /// @notice The read-side enforcement inputs. The SDK/Hook derive hard-block
    ///         eligibility as `corroboration >= K OR isSeeded` — NEVER from
    ///         `status == ACTIVE` (a later pass can reach ACTIVE via time/volume
    ///         maturation without corroboration, which must not grant censorship).
    function getEnforcementInputs(bytes32 antibodyId)
        external
        view
        returns (
            uint8   status,
            uint16  corroboration,
            uint256 publisherRep,
            uint8   prominenceTier,
            uint64  maturedAt,
            uint64  expiresAt,
            bool    isSeeded
        );

    /// @notice Pure-view bond preview for the SDK/UI before publishing.
    function computeBond(uint8 severity, address target) external view returns (uint256);

    function getPublisherStats(address publisher) external view returns (PublisherStats memory);

    function computeKeccakId(
        uint8 abType,
        uint8 flavor,
        bytes32 primaryMatcherHash,
        address publisher
    ) external pure returns (bytes32);
}
