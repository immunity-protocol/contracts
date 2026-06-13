// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

import {IReputation} from "./interfaces/IReputation.sol";
import {ZeroAddress, ZeroAmount, NotAuthorizedWriter} from "./libraries/Errors.sol";

/// @title Reputation — the protocol's on-chain memory of who has been right.
/// @notice The career-long skin-in-the-game that complements the per-antibody bond:
///         the bond makes a single lie cost money; reputation makes lying cost your
///         standing across everything you've ever done. The score builds slowly on
///         correct antibodies (matured / challenge-won) and craters on a proven lie
///         (slash), an asymmetry that makes a high-rep identity genuinely expensive
///         to burn — a patient grind-then-abuse attacker loses it all on first slash.
///
///         It is also the sybil-resistance of corroboration: the ImmunityRegistry
///         counts a publisher toward a hard-block only if `scoreOf` clears its
///         `minCorroborationRep` floor, so a fresh/sybil identity (score 0) can't
///         contribute. The Registry reads `scoreOf` LIVE each time it counts, so a
///         slashed publisher automatically stops counting toward corroboration on
///         every target they endorsed — slashing a liar retroactively weakens
///         everything they vouched for (intended).
///
///         Written ONLY by authorized protocol writers (the Registry now, the
///         ChallengeManager later) — never the publisher, never CRE. A
///         publisher-settable score would be worthless (finding B-5).
contract Reputation is IReputation, Ownable {
    struct Publisher {
        uint256 score;
        uint64  maturedCount;
        uint64  challengesWon;
        uint64  slashedCount;
        uint256 genesisGranted;
    }

    /// @dev Read via `getPublisher`; `score` read via `scoreOf` (single SLOAD).
    mapping(address => Publisher) internal _pub;

    /// @notice Protocol contracts allowed to write reputation (Registry, ChallengeManager).
    mapping(address => bool) public authorizedWriter;

    // Owner-tunable scale. Reputation is now STAKE-WEIGHTED: a matured/won antibody
    // credits points proportional to the USDC bond it locked (capped), not a flat
    // amount — so a publisher can't cheaply farm standing by self-corroborating a
    // swarm of zero-stakes flags (finding G2).
    //
    // Chosen defaults (USDC 6dp; Registry bondFloor = bondBase = 1.0 USDC = 1_000_000):
    //   repBondUnit      = 100_000  → 0.1 USDC of bond == 1 reputation point.
    //   maturePointsCap  = 50       → one mature credits at most 50 pts.
    //   challengeWonCap  = 100      → one challenge-win credits at most 100 pts.
    //   slashPenalty     = 1000     → catastrophic, flat, ≫ any single earned credit.
    //
    // Property check against the Registry's minCorroborationRep floor (default 25):
    //   • smallest bond (1.0 USDC, severity 0) matured  → 1_000_000/100_000 = 10 pts.
    //     ONE small self-mature (10) < 25 → does NOT clear the floor. ✓
    //     TWO small self-matures (20)    < 25 → still does NOT clear the floor. ✓
    //     THREE+ real matures (30)       ≥ 25 → an organic grinder clears it. ✓
    //   • a challenge-win on any non-minimal bond clears it in one shot, e.g. a
    //     protected target (×10 ⇒ ≥10 USDC bond) ⇒ (2·10_000_000)/100_000 = 200,
    //     capped at 100 ≫ 25 — challenge survival is the premium signal. (Only the
    //     rock-bottom 1.0-USDC severity-0 win lands at 20, by design the weakest case.)
    //   • a genesis publisher is granted score 100 at deploy ⇒ clears 25 comfortably. ✓
    // slashPenalty MUST stay ≫ a single credit (slow to build, fast to lose).
    uint256 public repBondUnit        = 100_000;
    uint256 public maturePointsCap    = 50;
    uint256 public challengeWonCap    = 100;
    uint256 public slashPenalty       = 1000;

    event Matured(address indexed publisher, uint256 newScore);
    event ChallengeWon(address indexed publisher, uint256 newScore);
    event Slashed(address indexed publisher, uint256 newScore);
    event GenesisGranted(address indexed publisher, uint256 amount, uint256 newScore);
    event AuthorizedWriterSet(address indexed writer, bool ok);
    event PointsUpdated(uint256 repBondUnit, uint256 maturePointsCap, uint256 challengeWonCap, uint256 slashPenalty);

    constructor() Ownable(msg.sender) {}

    /// @dev Reputation writes are restricted to authorized protocol contracts.
    ///      Publishers/EOAs revert — an actor must never grade themselves.
    modifier onlyWriter() {
        if (!authorizedWriter[msg.sender]) revert NotAuthorizedWriter();
        _;
    }

    // ------------------------------------------------------------------
    //  Reads
    // ------------------------------------------------------------------

    /// @inheritdoc IReputation
    function scoreOf(address publisher) external view returns (uint256) {
        return _pub[publisher].score;
    }

    /// @notice Raw lifecycle counters for the explorer.
    function getPublisher(address publisher) external view returns (Publisher memory) {
        return _pub[publisher];
    }

    // ------------------------------------------------------------------
    //  Protocol-written lifecycle signals
    // ------------------------------------------------------------------
    // No idempotency tracking: the Registry guarantees call-once semantics
    // (matured fires once per antibody; slash/won once per resolution), so this
    // contract just accumulates.

    /// @inheritdoc IReputation
    /// @dev Stake-weighted: credit = min(maturePointsCap, weight / repBondUnit), where
    ///      `weight` is the antibody's locked bond. A unit (or smaller) bond credits
    ///      few points; impact scales with skin-in-the-game and is capped.
    function onMatured(address publisher, uint256 weight) external onlyWriter {
        Publisher storage p = _pub[publisher];
        uint256 credit = weight / repBondUnit;
        if (credit > maturePointsCap) credit = maturePointsCap;
        uint256 newScore = p.score + credit;
        p.score = newScore;
        unchecked { p.maturedCount += 1; }
        emit Matured(publisher, newScore);
    }

    /// @inheritdoc IReputation
    /// @dev Stake-weighted at a 2× premium: credit = min(challengeWonCap, 2·weight / repBondUnit).
    ///      Surviving an adjudicated challenge is the strongest correctness signal, so
    ///      it pays more per unit of bond than a quiet maturation.
    function onChallengeWon(address publisher, uint256 weight) external onlyWriter {
        Publisher storage p = _pub[publisher];
        uint256 credit = (2 * weight) / repBondUnit;
        if (credit > challengeWonCap) credit = challengeWonCap;
        uint256 newScore = p.score + credit;
        p.score = newScore;
        unchecked { p.challengesWon += 1; }
        emit ChallengeWon(publisher, newScore);
    }

    /// @inheritdoc IReputation
    /// @dev Floored at 0: a slash never underflows, and `slashPenalty ≫ maturePoints`
    ///      means one proven lie wipes many earned points.
    function onSlash(address publisher) external onlyWriter {
        Publisher storage p = _pub[publisher];
        uint256 score = p.score;
        uint256 newScore = score > slashPenalty ? score - slashPenalty : 0;
        p.score = newScore;
        unchecked { p.slashedCount += 1; }
        emit Slashed(publisher, newScore);
    }

    // ------------------------------------------------------------------
    //  Admin
    // ------------------------------------------------------------------

    /// @notice The disclosed genesis bootstrap — the ONLY way score rises without an
    ///         earned event — so named genesis publishers can corroborate at launch.
    ///         Owner-only, event-emitting, and tracked per publisher for audit.
    function grantGenesisReputation(address publisher, uint256 amount) external onlyOwner {
        if (publisher == address(0)) revert ZeroAddress();
        Publisher storage p = _pub[publisher];
        uint256 newScore = p.score + amount;
        p.score = newScore;
        p.genesisGranted += amount;
        emit GenesisGranted(publisher, amount, newScore);
    }

    /// @notice Authorize/deauthorize a protocol writer (the Registry; later the ChallengeManager).
    function setAuthorizedWriter(address writer, bool ok) external onlyOwner {
        if (writer == address(0)) revert ZeroAddress();
        authorizedWriter[writer] = ok;
        emit AuthorizedWriterSet(writer, ok);
    }

    /// @notice Tune the stake-weight scale. `repBondUnit` must be non-zero (it is a
    ///         divisor). Should keep `slashPenalty ≫` any single capped credit so
    ///         standing stays slow to build and fast to lose.
    function setPoints(
        uint256 repBondUnit_,
        uint256 maturePointsCap_,
        uint256 challengeWonCap_,
        uint256 slashPenalty_
    ) external onlyOwner {
        if (repBondUnit_ == 0) revert ZeroAmount();
        repBondUnit = repBondUnit_;
        maturePointsCap = maturePointsCap_;
        challengeWonCap = challengeWonCap_;
        slashPenalty = slashPenalty_;
        emit PointsUpdated(repBondUnit_, maturePointsCap_, challengeWonCap_, slashPenalty_);
    }
}
