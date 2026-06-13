// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IImmunityRegistry} from "./interfaces/IImmunityRegistry.sol";
import {IPublisherRegistrar} from "./interfaces/IPublisherRegistrar.sol";
import {IReputation} from "./interfaces/IReputation.sol";
import {IProtectedSet} from "./interfaces/IProtectedSet.sol";
import {
    InsufficientBalance,
    ZeroAddress,
    ZeroAmount,
    AntibodyExists,
    AntibodyNotFound,
    InvalidConfidence,
    InvalidSeverity,
    InvalidVerdict,
    InvalidAntibodyType,
    ExpiryRequired,
    NotRegistered,
    NotChallengeManager,
    NotPublisher,
    InvalidStatusTransition,
    NotYet,
    Challenged
} from "./libraries/Errors.sol";

/// @title ImmunityRegistry — the Immunity protocol hub on Base.
/// @notice Source of truth for antibodies and their economics: prepaid balances,
///         the prepaid-fee settlement on `check()`, a non-refundable scaled bond,
///         fee escrow + maturation, corroboration, TTL lifecycle, and the
///         slash/uphold hooks the ChallengeManager calls.
///
///         Every decision exists to make honesty profitable and lying ruinous.
///         The attack it defeats: a cheap actor flags a genuine address (e.g. the
///         Uniswap router) to DoS real trades AND collect fees. Here the bond
///         stays at risk while enforced and is forfeited on slash; an unproven
///         antibody's fees escrow and are clawed back on slash — so a false
///         antibody earns zero, ever; and many publishers may flag one target so
///         a single voice can't censor and fee front-running dies.
///
///         IMPORTANT: enforcement strength (advisory vs hard-block) is NOT decided
///         here. It is derived read-side by the SDK/Hook from `getEnforcementInputs`.
///         The `mature()` poke and the PROBATION→ACTIVE flip are a financial
///         settlement (escrow release / switch to direct-pay), never the switch
///         that turns protection on — a freshly-corroborated real threat is
///         protected instantly.
contract ImmunityRegistry is IImmunityRegistry, Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------
    //  Constants — tokenomics (USDC, 6 decimals)
    // ------------------------------------------------------------------

    uint256 public constant CHECK_FEE            = 2_000;   // 0.002 USDC
    uint16  public constant PUBLISHER_REWARD_BPS = 8000;    // 80%
    uint16  public constant TREASURY_REWARD_BPS  = 2000;    // 20%
    uint16  public constant BPS_DENOMINATOR      = 10_000;

    /// @notice Upper bound on how many corroboration-set entries a single
    ///         live count scans, keeping `mature()`/views gas-safe. K is small,
    ///         so scanning the head of the set is sufficient in practice.
    uint256 public constant MAX_CORROBORATION_SCAN = 64;

    // ------------------------------------------------------------------
    //  Immutables
    // ------------------------------------------------------------------

    IERC20 public immutable usdc;

    // ------------------------------------------------------------------
    //  Dependencies (set in constructor or via setDependencies)
    // ------------------------------------------------------------------

    IPublisherRegistrar public registrar;   // publish gate
    IReputation         public reputation;  // rep writes + reads (Registry is a writer)
    IProtectedSet       public protectedSet; // bond scaling
    address             public challengeManager; // only caller of onChallenge* hooks

    // ------------------------------------------------------------------
    //  Owner-tunable params (defaults below; all in USDC 6dp where money)
    // ------------------------------------------------------------------

    uint256 public bondBase            = 1_000_000;  // 1.0 USDC
    uint256 public bondFloor           = 1_000_000;  // 1.0 USDC — severity 0 still costs
    uint256 public protectedMultiplier = 10;         // flagging a protected target ×10
    uint16  public corroborationK      = 3;          // distinct reputable publishers to mature
    uint256 public minCorroborationRep = 1;          // rep floor to count toward K
    uint256 public maturationVolumeThreshold = 0;    // 0 = volume path DISABLED (pass 1)

    // ------------------------------------------------------------------
    //  State
    // ------------------------------------------------------------------

    mapping(bytes32 => Antibody) internal _antibodies;
    mapping(uint32 => bytes32) public immSeqToKeccakId;

    /// @notice Corroboration set: matcherHash → live antibody keccakIds. Replaces
    ///         the old first-claimer `matcherIndex`; many publishers may flag one
    ///         target. Entries are removed on expire/retire/slash (C-1).
    mapping(bytes32 => bytes32[]) internal _matcherSet;
    /// @dev keccakId → (position in its matcher set + 1); 0 = not in any set.
    mapping(bytes32 => uint256) internal _setPos;

    mapping(address => uint256) public balances;
    mapping(address => PublisherStats) internal _publishers;

    uint256 public treasuryBalance;
    /// @notice Aggregate accounting for the economic invariant
    ///         (USDC held == Σ balances + treasury + bonds + escrow).
    uint256 public totalBondsLocked;
    uint256 public totalEscrowed;

    uint32 public nextImmSeq;

    // ------------------------------------------------------------------
    //  Constructor
    // ------------------------------------------------------------------

    /// @param _usdc            USDC token (or MockUSDC on testnet).
    /// @param _registrar       publisher gate; may be address(0) and set later.
    /// @param _reputation      reputation contract; may be address(0) and set later.
    /// @param _protectedSet    protected set; may be address(0) and set later.
    /// @param _challengeManager challenge hooks caller; may be address(0) and set later.
    constructor(
        address _usdc,
        address _registrar,
        address _reputation,
        address _protectedSet,
        address _challengeManager
    ) Ownable(msg.sender) {
        if (_usdc == address(0)) revert ZeroAddress();
        usdc = IERC20(_usdc);
        registrar = IPublisherRegistrar(_registrar);
        reputation = IReputation(_reputation);
        protectedSet = IProtectedSet(_protectedSet);
        challengeManager = _challengeManager;
    }

    modifier onlyChallengeManager() {
        if (msg.sender != challengeManager) revert NotChallengeManager();
        _;
    }

    // ------------------------------------------------------------------
    //  Operator balance — deposit / withdraw
    // ------------------------------------------------------------------

    /// @inheritdoc IImmunityRegistry
    function deposit(uint256 amount) external override whenNotPaused nonReentrant {
        if (amount == 0) revert ZeroAmount();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        balances[msg.sender] += amount;
        emit Deposited(msg.sender, amount);
    }

    /// @inheritdoc IImmunityRegistry
    /// @dev Intentionally NOT pausable — users can always exit their free balance.
    function withdraw(uint256 amount) external override nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 bal = balances[msg.sender];
        if (bal < amount) revert InsufficientBalance();
        unchecked { balances[msg.sender] = bal - amount; }
        usdc.safeTransfer(msg.sender, amount);
        emit Withdrew(msg.sender, amount);
    }

    // ------------------------------------------------------------------
    //  Publish
    // ------------------------------------------------------------------

    /// @inheritdoc IImmunityRegistry
    function publish(PublishParams calldata params)
        external
        override
        whenNotPaused
        nonReentrant
        returns (bytes32 keccakId, uint32 immSeq)
    {
        // Publisher gate (replaces "trust msg.sender"). No registrar wired → nobody
        // is registered → publishing is closed until one is set.
        if (address(registrar) == address(0) || !registrar.isRegistered(msg.sender)) {
            revert NotRegistered();
        }
        return _publish(params, msg.sender, false);
    }

    /// @dev Shared worker for `publish` and `seedAntibody`. Seeded antibodies post
    ///      no bond, escrow nothing, and start ACTIVE+matured (the disclosed bootstrap).
    function _publish(PublishParams calldata p, address publisher, bool isSeeded)
        internal
        returns (bytes32 keccakId, uint32 immSeq)
    {
        if (p.abType > uint8(AntibodyType.SEMANTIC)) revert InvalidAntibodyType();
        if (p.verdict > uint8(Verdict.SUSPICIOUS)) revert InvalidVerdict();
        if (p.confidence > 100) revert InvalidConfidence();
        if (p.severity > 100) revert InvalidSeverity();
        // TTL: `expiresAt == 0` = permanent (removable only by slash/retire); a
        // finite expiry must be in the future.
        if (p.expiresAt != 0 && p.expiresAt <= block.timestamp) revert ExpiryRequired();

        // Content-addressed identity. Same publisher republishing the same
        // (type, flavor, matcher) collides — the duplicate guard.
        keccakId = _hash(p.abType, p.flavor, p.primaryMatcherHash, publisher);
        if (_antibodies[keccakId].publisher != address(0)) revert AntibodyExists();

        // Resolve the target address for ADDRESS-type antibodies (for bond scaling).
        address target = p.abType == uint8(AntibodyType.ADDRESS)
            ? address(uint160(uint256(p.auxiliaryKey)))
            : address(0);
        bool prot = !isSeeded
            && target != address(0)
            && address(protectedSet) != address(0)
            && protectedSet.isProtected(target);

        uint256 bond = isSeeded ? 0 : _bondFor(p.severity, prot);
        if (bond != 0) {
            uint256 bal = balances[publisher];
            if (bal < bond) revert InsufficientBalance();
            unchecked { balances[publisher] = bal - bond; }
            totalBondsLocked += bond;
        }

        immSeq = ++nextImmSeq;
        address reviewer = p.reviewer == address(0) ? publisher : p.reviewer;
        uint64 createdAt = uint64(block.timestamp);

        _antibodies[keccakId] = Antibody({
            primaryMatcherHash: p.primaryMatcherHash,
            evidenceCid:        p.evidenceCid,
            contextHash:        p.contextHash,
            embeddingHash:      p.embeddingHash,
            attestation:        p.attestation,
            publisher:          publisher,
            immSeq:             immSeq,
            createdAt:          createdAt,
            reviewer:           reviewer,
            expiresAt:          p.expiresAt,
            abType:             p.abType,
            flavor:             p.flavor,
            verdict:            p.verdict,
            confidence:         p.confidence,
            bondAmount:         uint96(bond),
            escrowedFees:       0,
            maturedAt:          isSeeded ? createdAt : 0,
            severity:           p.severity,
            status:             isSeeded ? uint8(Status.ACTIVE) : uint8(Status.PROBATION),
            isSeeded:           isSeeded ? 1 : 0,
            prominenceTier:     prot ? 1 : 0
        });
        immSeqToKeccakId[immSeq] = keccakId;

        // Corroboration: append to the matcher set (many antibodies per target).
        _appendToMatcher(p.primaryMatcherHash, keccakId);

        PublisherStats storage stats = _publishers[publisher];
        unchecked {
            stats.totalBonded += uint128(bond);
            stats.publishedCount += 1;
        }

        emit Published(
            keccakId, immSeq, publisher, p.abType, p.flavor, p.verdict, p.severity,
            p.confidence, reviewer, p.primaryMatcherHash, p.evidenceCid, p.contextHash,
            p.embeddingHash, p.attestation, bond, p.expiresAt, createdAt, isSeeded
        );
        if (bond != 0) emit BondLocked(keccakId, publisher, bond);
        _emitAuxiliary(p.abType, p.flavor, keccakId, p.auxiliaryKey, publisher);
    }

    /// @dev Type-specific auxiliary event so consumers can filter by an indexed
    ///      primitive instead of scanning every `Published`.
    function _emitAuxiliary(
        uint8 abType,
        uint8 flavor,
        bytes32 keccakId,
        bytes32 auxKey,
        address publisher
    ) internal {
        if (abType == uint8(AntibodyType.ADDRESS)) {
            emit AddressBlocked(address(uint160(uint256(auxKey))), keccakId, publisher);
        } else if (abType == uint8(AntibodyType.CALL_PATTERN)) {
            emit CallPatternBlocked(bytes4(auxKey), keccakId, publisher);
        } else if (abType == uint8(AntibodyType.BYTECODE)) {
            emit BytecodeBlocked(auxKey, keccakId, publisher);
        } else if (abType == uint8(AntibodyType.GRAPH)) {
            emit GraphTaintAdded(auxKey, keccakId, publisher);
        } else {
            emit SemanticPatternAdded(flavor, keccakId, publisher);
        }
    }

    /// @dev Canonical content-addressed antibody identifier.
    function _hash(uint8 abType, uint8 flavor, bytes32 primaryMatcherHash, address publisher)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(abType, flavor, primaryMatcherHash, publisher));
    }

    // ------------------------------------------------------------------
    //  Check (hot path)
    // ------------------------------------------------------------------

    /// @inheritdoc IImmunityRegistry
    /// @dev Pass `bytes32(0)` for a no-match check (caller still pays fee → treasury).
    ///      The telemetry params are SDK-derived observable facts; the contract
    ///      stores them in the log but NEVER treats them as truth (A-6). No keeper
    ///      sweep runs here anymore — the hot path stays lean.
    function check(
        bytes32 antibodyId,
        address tokenAddress,
        uint256 tokenAmount,
        uint256 originChainId
    )
        external
        override
        whenNotPaused
        nonReentrant
        returns (bool settled)
    {
        uint256 bal = balances[msg.sender];
        if (bal < CHECK_FEE) revert InsufficientBalance();
        unchecked { balances[msg.sender] = bal - CHECK_FEE; }

        bool wasMatch;
        if (antibodyId != bytes32(0)) {
            Antibody storage ab = _antibodies[antibodyId];
            address pub = ab.publisher;
            uint8 st = ab.status;
            // Settle on a live, in-window antibody. SLASHED/EXPIRED (or past TTL)
            // never settle to the publisher — the fee falls through to treasury.
            if (
                pub != address(0) &&
                st != uint8(Status.SLASHED) &&
                st != uint8(Status.EXPIRED) &&
                (ab.expiresAt == 0 || ab.expiresAt > block.timestamp)
            ) {
                uint256 publisherShare = (CHECK_FEE * PUBLISHER_REWARD_BPS) / BPS_DENOMINATOR;
                uint256 treasuryShare = CHECK_FEE - publisherShare;
                treasuryBalance += treasuryShare;

                // Direct-pay ONLY when matured (ACTIVE). PROBATION and CHALLENGED
                // escrow so the share is clawable if later slashed.
                bool escrowed;
                if (st == uint8(Status.ACTIVE)) {
                    balances[pub] += publisherShare;
                    unchecked { _publishers[pub].totalEarned += uint128(publisherShare); }
                } else {
                    ab.escrowedFees += uint96(publisherShare);
                    totalEscrowed += publisherShare;
                    escrowed = true;
                    emit FeesEscrowed(antibodyId, pub, publisherShare);
                }

                wasMatch = true;
                settled = true;
                emit Matched(
                    antibodyId, msg.sender, pub, tokenAddress, tokenAmount,
                    originChainId, publisherShare, treasuryShare, escrowed
                );
            }
        }

        if (!wasMatch) {
            treasuryBalance += CHECK_FEE;
        }

        emit Checked(
            msg.sender, antibodyId, tokenAddress, wasMatch,
            CHECK_FEE, originChainId, tokenAmount, uint64(block.timestamp)
        );
    }

    // ------------------------------------------------------------------
    //  Maturation (poke-only, permissionless)
    // ------------------------------------------------------------------

    /// @inheritdoc IImmunityRegistry
    /// @dev Settlement only — NOT the protection switch. Protection is read-derived
    ///      from `getEnforcementInputs` and does not wait on this poke.
    function mature(bytes32 antibodyId) external override whenNotPaused nonReentrant {
        Antibody storage ab = _antibodies[antibodyId];
        address pub = ab.publisher;
        if (pub == address(0)) revert AntibodyNotFound();
        // Only PROBATION → ACTIVE; guarantees onMatured fires exactly once.
        if (ab.status != uint8(Status.PROBATION)) revert InvalidStatusTransition();
        // A permanent antibody (expiresAt == 0) is still maturable; only a finite,
        // already-passed expiry blocks maturation (it should be expired instead).
        if (ab.expiresAt != 0 && ab.expiresAt <= block.timestamp) revert NotYet();
        if (!_isMature(ab.primaryMatcherHash)) revert NotYet();

        ab.status = uint8(Status.ACTIVE);
        ab.maturedAt = uint64(block.timestamp);

        uint256 fees = ab.escrowedFees;
        if (fees != 0) {
            ab.escrowedFees = 0;
            totalEscrowed -= fees;
            balances[pub] += fees;
            unchecked { _publishers[pub].totalEarned += uint128(fees); }
            emit FeesReleased(antibodyId, pub, fees);
        }
        _reputationOnMatured(pub);
        emit Matured(antibodyId, pub, fees, uint64(block.timestamp));
    }

    /// @dev Pass-1 maturation condition: corroboration-K only. The volume path is
    ///      gated behind `maturationVolumeThreshold` (default 0 = disabled) and is
    ///      a pass-2 must-do before a real launch.
    function _isMature(bytes32 matcherHash) internal view returns (bool) {
        if (_corroborationOf(matcherHash) >= corroborationK) return true;
        // volume path: intentionally disabled in pass 1 (threshold == 0).
        // if (maturationVolumeThreshold != 0 && matchedVolume >= maturationVolumeThreshold) return true;
        return false;
    }

    // ------------------------------------------------------------------
    //  TTL lifecycle — expire / sweep / retire
    // ------------------------------------------------------------------

    /// @inheritdoc IImmunityRegistry
    function expire(bytes32 antibodyId) external override nonReentrant {
        Antibody storage ab = _antibodies[antibodyId];
        address pub = ab.publisher;
        if (pub == address(0)) revert AntibodyNotFound();
        if (ab.status == uint8(Status.CHALLENGED)) revert Challenged();
        if (ab.status == uint8(Status.SLASHED) || ab.status == uint8(Status.EXPIRED)) {
            revert InvalidStatusTransition();
        }
        // Permanent antibodies (expiresAt == 0) are never expirable — only slash or
        // retire removes them. A finite expiry must have passed.
        if (ab.expiresAt == 0 || ab.expiresAt > block.timestamp) revert NotYet();
        _settleExpiry(antibodyId, ab, pub);
    }

    /// @inheritdoc IImmunityRegistry
    function sweepExpired(bytes32[] calldata antibodyIds)
        external
        override
        nonReentrant
        returns (uint256 numExpired)
    {
        for (uint256 i; i < antibodyIds.length; ++i) {
            bytes32 id = antibodyIds[i];
            Antibody storage ab = _antibodies[id];
            address pub = ab.publisher;
            if (pub == address(0)) continue;
            uint8 st = ab.status;
            if (
                st == uint8(Status.CHALLENGED) ||
                st == uint8(Status.SLASHED) ||
                st == uint8(Status.EXPIRED)
            ) continue;
            // Skip permanent antibodies and any whose finite expiry hasn't passed.
            if (ab.expiresAt == 0 || ab.expiresAt > block.timestamp) continue;
            _settleExpiry(id, ab, pub);
            unchecked { ++numExpired; }
        }
    }

    /// @inheritdoc IImmunityRegistry
    function retire(bytes32 antibodyId) external override nonReentrant {
        Antibody storage ab = _antibodies[antibodyId];
        address pub = ab.publisher;
        if (pub == address(0)) revert AntibodyNotFound();
        if (msg.sender != pub) revert NotPublisher();
        if (ab.status == uint8(Status.CHALLENGED)) revert Challenged();
        if (ab.status == uint8(Status.SLASHED) || ab.status == uint8(Status.EXPIRED)) {
            revert InvalidStatusTransition();
        }

        uint256 bond = ab.bondAmount;
        uint256 escrow = ab.escrowedFees;
        ab.status = uint8(Status.EXPIRED);
        ab.bondAmount = 0;
        ab.escrowedFees = 0;

        if (bond != 0) {
            totalBondsLocked -= bond;
            balances[pub] += bond;
            emit BondReleased(antibodyId, pub, bond);
        }
        // A never-matured antibody must not pay out on the way out — claw escrow.
        if (escrow != 0) {
            totalEscrowed -= escrow;
            treasuryBalance += escrow;
            emit FeesClawedBack(antibodyId, pub, escrow);
        }
        _removeFromMatcher(ab.primaryMatcherHash, antibodyId);
        emit Retired(antibodyId, pub, bond);
    }

    /// @dev TTL settlement: release bond; claw any (never-matured) escrow to
    ///      treasury; mark EXPIRED; clear the matcher set (C-1). A matured antibody
    ///      already released its escrow at `mature()`, so escrow is 0 here.
    function _settleExpiry(bytes32 id, Antibody storage ab, address pub) internal {
        uint256 bond = ab.bondAmount;
        uint256 escrow = ab.escrowedFees;
        ab.status = uint8(Status.EXPIRED);
        ab.bondAmount = 0;
        ab.escrowedFees = 0;

        if (bond != 0) {
            totalBondsLocked -= bond;
            balances[pub] += bond;
            emit BondReleased(id, pub, bond);
        }
        uint256 clawed;
        if (escrow != 0) {
            totalEscrowed -= escrow;
            treasuryBalance += escrow;
            clawed = escrow;
            emit FeesClawedBack(id, pub, escrow);
        }
        _removeFromMatcher(ab.primaryMatcherHash, id);
        emit Expired(id, pub, bond, clawed);
    }

    // ------------------------------------------------------------------
    //  ChallengeManager hooks
    // ------------------------------------------------------------------

    /// @inheritdoc IImmunityRegistry
    /// @dev Probationary suspends to advisory; matured keeps enforcing (read-side).
    ///      Prior tier is recovered on resolve via `maturedAt != 0`.
    function onChallengeOpened(bytes32 antibodyId)
        external
        override
        onlyChallengeManager
        nonReentrant
    {
        Antibody storage ab = _antibodies[antibodyId];
        if (ab.publisher == address(0)) revert AntibodyNotFound();
        uint8 st = ab.status;
        if (st != uint8(Status.PROBATION) && st != uint8(Status.ACTIVE)) {
            revert InvalidStatusTransition();
        }
        ab.status = uint8(Status.CHALLENGED);
        emit ChallengeOpened(antibodyId);
    }

    /// @inheritdoc IImmunityRegistry
    /// @dev invalid → SLASH: forfeit bond + escrow to the ChallengeManager balance
    ///      (it routes the challenger/treasury split downstream), clear the matcher
    ///      set, signal reputation. valid → restore prior tier; if it was matured,
    ///      release escrow accrued during the challenge.
    function onChallengeResolved(bytes32 antibodyId, bool invalid, address challenger)
        external
        override
        onlyChallengeManager
        nonReentrant
    {
        Antibody storage ab = _antibodies[antibodyId];
        address pub = ab.publisher;
        if (pub == address(0)) revert AntibodyNotFound();
        if (ab.status != uint8(Status.CHALLENGED)) revert InvalidStatusTransition();

        if (invalid) {
            uint256 bond = ab.bondAmount;
            uint256 escrow = ab.escrowedFees;
            ab.status = uint8(Status.SLASHED);
            ab.bondAmount = 0;
            ab.escrowedFees = 0;
            if (bond != 0) totalBondsLocked -= bond;
            if (escrow != 0) totalEscrowed -= escrow;

            uint256 forfeited = bond + escrow;
            if (forfeited != 0) {
                // Routed to the ChallengeManager, which splits challenger/treasury.
                balances[challengeManager] += forfeited;
            }
            unchecked { _publishers[pub].slashedCount += 1; }
            _removeFromMatcher(ab.primaryMatcherHash, antibodyId);
            _reputationOnSlash(pub);
            emit Slashed(antibodyId, pub, challenger, bond, escrow);
        } else {
            bool wasMatured = ab.maturedAt != 0;
            ab.status = wasMatured ? uint8(Status.ACTIVE) : uint8(Status.PROBATION);
            if (wasMatured) {
                uint256 escrow = ab.escrowedFees;
                if (escrow != 0) {
                    ab.escrowedFees = 0;
                    totalEscrowed -= escrow;
                    balances[pub] += escrow;
                    unchecked { _publishers[pub].totalEarned += uint128(escrow); }
                    emit FeesReleased(antibodyId, pub, escrow);
                }
            }
            _reputationOnChallengeWon(pub);
            emit ChallengeUpheld(antibodyId, pub);
        }
    }

    // ------------------------------------------------------------------
    //  Admin — seed, treasury, params, pause
    // ------------------------------------------------------------------

    /// @inheritdoc IImmunityRegistry
    function seedAntibody(PublishParams calldata params)
        external
        override
        onlyOwner
        whenNotPaused
        nonReentrant
        returns (bytes32 keccakId, uint32 immSeq)
    {
        (keccakId, immSeq) = _publish(params, msg.sender, true);
        emit Seeded(keccakId, immSeq);
    }

    /// @inheritdoc IImmunityRegistry
    function withdrawTreasury(uint256 amount, address to) external override onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (amount > treasuryBalance) revert InsufficientBalance();
        unchecked { treasuryBalance -= amount; }
        usdc.safeTransfer(to, amount);
        emit TreasuryWithdrawn(to, amount);
    }

    /// @inheritdoc IImmunityRegistry
    function pause() external override onlyOwner { _pause(); }

    /// @inheritdoc IImmunityRegistry
    function unpause() external override onlyOwner { _unpause(); }

    /// @inheritdoc IImmunityRegistry
    function setDependencies(
        address _registrar,
        address _reputation,
        address _protectedSet,
        address _challengeManager
    ) external override onlyOwner {
        registrar = IPublisherRegistrar(_registrar);
        reputation = IReputation(_reputation);
        protectedSet = IProtectedSet(_protectedSet);
        challengeManager = _challengeManager;
        emit DependenciesUpdated(_registrar, _reputation, _protectedSet, _challengeManager);
    }

    /// @inheritdoc IImmunityRegistry
    function setBondParams(uint256 _bondBase, uint256 _bondFloor, uint256 _protectedMultiplier)
        external
        override
        onlyOwner
    {
        if (_bondFloor == 0 || _protectedMultiplier == 0) revert ZeroAmount();
        bondBase = _bondBase;
        bondFloor = _bondFloor;
        protectedMultiplier = _protectedMultiplier;
        emit BondParamsUpdated(_bondBase, _bondFloor, _protectedMultiplier);
    }

    /// @inheritdoc IImmunityRegistry
    function setMaturationParams(
        uint16 _corroborationK,
        uint256 _minCorroborationRep,
        uint256 _volumeThreshold
    ) external override onlyOwner {
        if (_corroborationK == 0) revert ZeroAmount();
        corroborationK = _corroborationK;
        minCorroborationRep = _minCorroborationRep;
        maturationVolumeThreshold = _volumeThreshold;
        emit MaturationParamsUpdated(_corroborationK, _minCorroborationRep, _volumeThreshold);
    }

    // ------------------------------------------------------------------
    //  Bond curve
    // ------------------------------------------------------------------

    /// @inheritdoc IImmunityRegistry
    function computeBond(uint8 severity, address target) public view override returns (uint256) {
        if (severity > 100) revert InvalidSeverity();
        bool prot = target != address(0)
            && address(protectedSet) != address(0)
            && protectedSet.isProtected(target);
        return _bondFor(severity, prot);
    }

    /// @dev bond = max(BOND_FLOOR, BOND_BASE × (1 + severity/100)) × (protected ? MULT : 1).
    ///      Economic deterrent only — the protected-set's advisory-max cap and the
    ///      auto-open-challenge live in other contracts, not in this math.
    function _bondFor(uint8 severity, bool protected_) internal view returns (uint256 bond) {
        uint256 scaled = bondBase + (bondBase * severity) / 100;
        bond = scaled < bondFloor ? bondFloor : scaled;
        if (protected_) bond = bond * protectedMultiplier;
    }

    // ------------------------------------------------------------------
    //  Reputation signal helpers (no-op if reputation unset)
    // ------------------------------------------------------------------

    function _reputationOnMatured(address pub) internal {
        if (address(reputation) != address(0)) reputation.onMatured(pub);
    }

    function _reputationOnSlash(address pub) internal {
        if (address(reputation) != address(0)) reputation.onSlash(pub);
    }

    function _reputationOnChallengeWon(address pub) internal {
        if (address(reputation) != address(0)) reputation.onChallengeWon(pub);
    }

    // ------------------------------------------------------------------
    //  Corroboration set helpers
    // ------------------------------------------------------------------

    function _appendToMatcher(bytes32 matcherHash, bytes32 id) internal {
        bytes32[] storage set = _matcherSet[matcherHash];
        _setPos[id] = set.length + 1;
        set.push(id);
    }

    function _removeFromMatcher(bytes32 matcherHash, bytes32 id) internal {
        uint256 posPlus = _setPos[id];
        if (posPlus == 0) return; // already removed / never added
        bytes32[] storage set = _matcherSet[matcherHash];
        uint256 pos = posPlus - 1;
        uint256 last = set.length - 1;
        if (pos != last) {
            bytes32 lastId = set[last];
            set[pos] = lastId;
            _setPos[lastId] = pos + 1;
        }
        set.pop();
        delete _setPos[id];
    }

    /// @dev Live count of distinct registered publishers flagging `matcherHash`
    ///      whose current reputation ≥ `minCorroborationRep`. Bounded scan; counts
    ///      distinct addresses + rep-floor only (see corroborationOf docstring).
    function _corroborationOf(bytes32 matcherHash) internal view returns (uint16) {
        bytes32[] storage set = _matcherSet[matcherHash];
        uint256 n = set.length;
        if (n > MAX_CORROBORATION_SCAN) n = MAX_CORROBORATION_SCAN;

        bool hasRep = address(reputation) != address(0);
        uint256 floor = minCorroborationRep;
        address[] memory counted = new address[](n);
        uint256 m;

        for (uint256 i; i < n; ++i) {
            address pub = _antibodies[set[i]].publisher;
            uint256 rep = hasRep ? reputation.scoreOf(pub) : 0;
            if (rep < floor) continue;
            bool seen;
            for (uint256 j; j < m; ++j) {
                if (counted[j] == pub) { seen = true; break; }
            }
            if (seen) continue;
            counted[m++] = pub;
        }
        return uint16(m);
    }

    // ------------------------------------------------------------------
    //  Views
    // ------------------------------------------------------------------

    /// @inheritdoc IImmunityRegistry
    function getAntibody(bytes32 keccakId) external view override returns (Antibody memory) {
        return _antibodies[keccakId];
    }

    /// @inheritdoc IImmunityRegistry
    function getAntibodyByImmSeq(uint32 immSeq) external view override returns (Antibody memory) {
        return _antibodies[immSeqToKeccakId[immSeq]];
    }

    /// @inheritdoc IImmunityRegistry
    function getAntibodiesByMatcher(bytes32 matcherHash)
        external
        view
        override
        returns (bytes32[] memory)
    {
        return _matcherSet[matcherHash];
    }

    /// @inheritdoc IImmunityRegistry
    function corroborationOf(bytes32 matcherHash) external view override returns (uint16) {
        return _corroborationOf(matcherHash);
    }

    /// @inheritdoc IImmunityRegistry
    function getEnforcementInputs(bytes32 antibodyId)
        external
        view
        override
        returns (
            uint8   status,
            uint16  corroboration,
            uint256 publisherRep,
            uint8   prominenceTier,
            uint64  maturedAt,
            uint64  expiresAt
        )
    {
        Antibody storage ab = _antibodies[antibodyId];
        status = ab.status;
        corroboration = _corroborationOf(ab.primaryMatcherHash);
        publisherRep = address(reputation) != address(0) ? reputation.scoreOf(ab.publisher) : 0;
        prominenceTier = ab.prominenceTier;
        maturedAt = ab.maturedAt;
        expiresAt = ab.expiresAt;
    }

    /// @inheritdoc IImmunityRegistry
    function getPublisherStats(address publisher)
        external
        view
        override
        returns (PublisherStats memory)
    {
        return _publishers[publisher];
    }

    /// @inheritdoc IImmunityRegistry
    function computeKeccakId(
        uint8 abType,
        uint8 flavor,
        bytes32 primaryMatcherHash,
        address publisher
    ) external pure override returns (bytes32) {
        return _hash(abType, flavor, primaryMatcherHash, publisher);
    }
}
