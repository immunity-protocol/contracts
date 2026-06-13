// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

import {IReputation} from "./interfaces/IReputation.sol";
import {ZeroAddress, NotAuthorizedWriter} from "./libraries/Errors.sol";

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

    // Owner-tunable point scale. slashPenalty MUST stay ≫ maturePoints
    // (slow to build, fast to lose).
    uint256 public maturePoints       = 10;
    uint256 public challengeWonPoints = 20;
    uint256 public slashPenalty       = 1000;

    event Matured(address indexed publisher, uint256 newScore);
    event ChallengeWon(address indexed publisher, uint256 newScore);
    event Slashed(address indexed publisher, uint256 newScore);
    event GenesisGranted(address indexed publisher, uint256 amount, uint256 newScore);
    event AuthorizedWriterSet(address indexed writer, bool ok);
    event PointsUpdated(uint256 maturePoints, uint256 challengeWonPoints, uint256 slashPenalty);

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
    function onMatured(address publisher) external onlyWriter {
        Publisher storage p = _pub[publisher];
        uint256 newScore = p.score + maturePoints;
        p.score = newScore;
        unchecked { p.maturedCount += 1; }
        emit Matured(publisher, newScore);
    }

    /// @inheritdoc IReputation
    function onChallengeWon(address publisher) external onlyWriter {
        Publisher storage p = _pub[publisher];
        uint256 newScore = p.score + challengeWonPoints;
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

    /// @notice Tune the point scale. Should keep `slashPenalty ≫ maturePoints`.
    function setPoints(
        uint256 maturePoints_,
        uint256 challengeWonPoints_,
        uint256 slashPenalty_
    ) external onlyOwner {
        maturePoints = maturePoints_;
        challengeWonPoints = challengeWonPoints_;
        slashPenalty = slashPenalty_;
        emit PointsUpdated(maturePoints_, challengeWonPoints_, slashPenalty_);
    }
}
