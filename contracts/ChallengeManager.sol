// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IImmunityRegistry} from "./interfaces/IImmunityRegistry.sol";
import {IChallengeManager} from "./interfaces/IChallengeManager.sol";
import {IVerifierPool} from "./interfaces/IVerifierPool.sol";
import {
    ZeroAddress,
    ZeroAmount,
    InsufficientBalance,
    AntibodyNotFound,
    InvalidStatusTransition,
    NotYet,
    NotCreReceiver,
    NotVerifierPool,
    ChallengeAlreadyOpen,
    NoActiveChallenge,
    InvalidBps
} from "./libraries/Errors.sol";

/// @title ChallengeManager — Immunity's consensus hub (the challenge game).
/// @notice Lets anyone challenge an antibody, runs the two-layer jury, drives the
///         Registry's slash/uphold, and routes the money so **the loser funds the
///         dispute and the jurors get paid**. It is the address wired as the
///         Registry's `challengeManager`.
///
///         Why the loser funds it: if the only payout were "loser → challenger",
///         then in the common case (a unanimous correct verdict) there are no wrong
///         voters to slash and jurors work for free → nobody shows up → challenges
///         never resolve. So the forfeited pool splits winner + jurors + treasury,
///         and jurors are paid in BOTH outcomes (whoever lost pays).
///
///         A *matured/corroborated* antibody KEEPS enforcing while CHALLENGED
///         (read-side, emergent from the Registry's corroboration count), so
///         challenging can't switch off real protection; the challenge bond also
///         scales with the challenged antibody's bond, so attacking a strong one
///         is expensive.
contract ChallengeManager is IChallengeManager, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum CStatus { NONE, LAYER1_PENDING, LAYER2_ESCALATED, RESOLVED }

    struct Challenge {
        address challenger;
        uint256 bond;
        uint64  openedAt;
        uint64  escalatedAt;
        CStatus status;
        bytes32 evidenceCid;
    }

    mapping(bytes32 => Challenge) public challengeOf; // antibodyId → active challenge (one at a time)

    IImmunityRegistry public registry;
    IERC20 public immutable usdc;
    address public creReceiver;   // only caller of submitLayer1Verdict
    address public verifierPool;  // escalate target + only caller of submitLayer2Verdict

    uint256 public treasuryBalance; // manager-local; owner withdraws

    // Owner-tunable economics. Invariant: bounty + juror + layer1 ≤ 10_000 (treasury = remainder).
    uint16  public challengeBondBps     = 10_000;   // 1× the antibody bond
    uint256 public minChallengeBond     = 5_000_000; // 5 USDC floor (covers 0-bond genesis)
    uint16  public challengerBountyBps  = 4_000;    // winner bounty (challenger if invalid, publisher if valid)
    uint16  public jurorFeeBps          = 3_000;    // → VerifierPool when resolved via Layer-2; else treasury
    uint16  public layer1FeeBps         = 1_000;    // CRE cost recovery → treasury in pass-1
    uint16  public supermajorityBps     = 6_700;    // Layer-1 strong-consensus threshold
    uint64  public layer1Timeout        = 1 hours;
    uint64  public layer2Timeout        = 1 hours;

    event VerdictRequested(bytes32 indexed antibodyId, bytes32 evidenceCid);
    event Escalated(bytes32 indexed antibodyId);
    event Resolved(
        bytes32 indexed antibodyId,
        bool    invalid,
        address indexed challenger,
        uint256 winnerPayout,
        uint256 jurorFee,
        uint256 treasuryAmount
    );
    event RegistrySet(address registry);
    event CreReceiverSet(address creReceiver);
    event VerifierPoolSet(address verifierPool);
    event EconomicsSet(
        uint16 challengeBondBps,
        uint256 minChallengeBond,
        uint16 challengerBountyBps,
        uint16 jurorFeeBps,
        uint16 layer1FeeBps,
        uint16 supermajorityBps,
        uint64 layer1Timeout,
        uint64 layer2Timeout
    );
    event TreasuryWithdrawn(address indexed to, uint256 amount);

    constructor(address _usdc) Ownable(msg.sender) {
        if (_usdc == address(0)) revert ZeroAddress();
        usdc = IERC20(_usdc);
    }

    // ------------------------------------------------------------------
    //  Challenge
    // ------------------------------------------------------------------

    /// @notice Open a challenge against `antibodyId`, locking a scaled bond and
    ///         flipping the antibody to CHALLENGED. Emits the CRE log-trigger.
    function challenge(bytes32 antibodyId) external nonReentrant {
        Challenge storage existing = challengeOf[antibodyId];
        if (existing.status == CStatus.LAYER1_PENDING || existing.status == CStatus.LAYER2_ESCALATED) {
            revert ChallengeAlreadyOpen();
        }

        IImmunityRegistry.Antibody memory ab = registry.getAntibody(antibodyId);
        if (ab.publisher == address(0)) revert AntibodyNotFound();
        uint8 st = ab.status;
        if (
            st != uint8(IImmunityRegistry.Status.PROBATION) &&
            st != uint8(IImmunityRegistry.Status.ACTIVE)
        ) revert InvalidStatusTransition();

        uint256 bond = _challengeBond(ab.bondAmount);
        usdc.safeTransferFrom(msg.sender, address(this), bond);

        // Flip the antibody to CHALLENGED (reverts if not PROBATION/ACTIVE — one challenge at a time).
        registry.onChallengeOpened(antibodyId);

        challengeOf[antibodyId] = Challenge({
            challenger: msg.sender,
            bond: bond,
            openedAt: uint64(block.timestamp),
            escalatedAt: 0,
            status: CStatus.LAYER1_PENDING,
            evidenceCid: ab.evidenceCid
        });

        emit VerdictRequested(antibodyId, ab.evidenceCid);
    }

    /// @dev challengeBond = max(minChallengeBond, antibodyBond × challengeBondBps).
    function _challengeBond(uint256 antibodyBond) internal view returns (uint256) {
        uint256 scaled = (antibodyBond * challengeBondBps) / 10_000;
        return scaled < minChallengeBond ? minChallengeBond : scaled;
    }

    // ------------------------------------------------------------------
    //  Verdict intake
    // ------------------------------------------------------------------

    /// @inheritdoc IChallengeManager
    function submitLayer1Verdict(bytes32 antibodyId, uint16 invalidVotes, uint16 validVotes)
        external
        override
        nonReentrant
    {
        if (msg.sender != creReceiver) revert NotCreReceiver();
        Challenge storage c = challengeOf[antibodyId];
        if (c.status != CStatus.LAYER1_PENDING) revert NoActiveChallenge();

        uint256 total = uint256(invalidVotes) + validVotes;
        if (total != 0) {
            uint256 top = invalidVotes >= validVotes ? invalidVotes : validVotes;
            if ((top * 10_000) / total >= supermajorityBps) {
                _resolve(antibodyId, invalidVotes > validVotes, false);
                return;
            }
        }

        // No strong consensus (or no votes) → escalate to Layer-2.
        c.status = CStatus.LAYER2_ESCALATED;
        c.escalatedAt = uint64(block.timestamp);
        IVerifierPool(verifierPool).escalate(antibodyId);
        emit Escalated(antibodyId);
    }

    /// @inheritdoc IChallengeManager
    function submitLayer2Verdict(bytes32 antibodyId, bool invalid) external override nonReentrant {
        if (msg.sender != verifierPool) revert NotVerifierPool();
        Challenge storage c = challengeOf[antibodyId];
        if (c.status != CStatus.LAYER2_ESCALATED) revert NoActiveChallenge();
        _resolve(antibodyId, invalid, true);
    }

    /// @notice Liveness: if no verdict arrives within the window, resolve
    ///         conservatively — restore the antibody (no slash) and return the
    ///         challenger bond.
    /// @dev Routes through the Registry's `onChallengeTimedOut`, which restores the
    ///      antibody WITHOUT any reputation credit — an un-adjudicated timeout is
    ///      not a "win", so it can't be used to farm reputation.
    function resolveTimeout(bytes32 antibodyId) external nonReentrant {
        Challenge storage c = challengeOf[antibodyId];
        if (c.status == CStatus.LAYER1_PENDING) {
            if (block.timestamp < c.openedAt + layer1Timeout) revert NotYet();
        } else if (c.status == CStatus.LAYER2_ESCALATED) {
            if (block.timestamp < c.escalatedAt + layer2Timeout) revert NotYet();
        } else {
            revert NoActiveChallenge();
        }

        address challenger = c.challenger;
        uint256 bond = c.bond;
        c.status = CStatus.RESOLVED;

        registry.onChallengeTimedOut(antibodyId);          // restore, NO reputation credit
        if (bond != 0) usdc.safeTransfer(challenger, bond); // full refund (challenger did nothing wrong)

        emit Resolved(antibodyId, false, challenger, 0, 0, 0);
    }

    // ------------------------------------------------------------------
    //  Resolution + economics router (the loser funds the dispute)
    // ------------------------------------------------------------------

    function _resolve(bytes32 antibodyId, bool invalid, bool viaLayer2) internal {
        Challenge storage c = challengeOf[antibodyId];
        address challenger = c.challenger;
        uint256 cbond = c.bond;
        c.status = CStatus.RESOLVED;

        if (invalid) {
            // Read the forfeited amount BEFORE the Registry zeroes it on resolve.
            IImmunityRegistry.Antibody memory ab = registry.getAntibody(antibodyId);
            uint256 forfeited = uint256(ab.bondAmount) + ab.escrowedFees;

            // Slash: Registry credits balances[this] += forfeited and fires onSlash.
            registry.onChallengeResolved(antibodyId, true, challenger);
            if (forfeited != 0) registry.withdraw(forfeited); // pull the pool into this contract

            uint256 bounty = (forfeited * challengerBountyBps) / 10_000;
            (uint256 jurorFee, uint256 toTreasury) = _splitTail(forfeited, bounty, viaLayer2);
            treasuryBalance += toTreasury;

            uint256 toChallenger = cbond + bounty; // bond back + bounty
            if (toChallenger != 0) usdc.safeTransfer(challenger, toChallenger);

            emit Resolved(antibodyId, true, challenger, bounty, jurorFee, toTreasury);
        } else {
            // Uphold: the challenger's bond is the pool; loser = challenger.
            registry.onChallengeResolved(antibodyId, false, challenger); // restores tier, fires onChallengeWon
            address publisher = registry.getAntibody(antibodyId).publisher;

            uint256 publisherComp = (cbond * challengerBountyBps) / 10_000; // winner (publisher) bounty
            (uint256 jurorFee, uint256 toTreasury) = _splitTail(cbond, publisherComp, viaLayer2);
            treasuryBalance += toTreasury;

            if (publisherComp != 0) usdc.safeTransfer(publisher, publisherComp);

            emit Resolved(antibodyId, false, challenger, publisherComp, jurorFee, toTreasury);
        }
    }

    /// @dev Splits the non-winner remainder of `pool` into the juror fee and the
    ///      treasury amount. Juror fee goes to the VerifierPool only when resolved
    ///      via Layer-2; otherwise it folds into treasury (no jurors did work). The
    ///      Layer-1 cost-recovery slice also folds into treasury in pass-1.
    function _splitTail(uint256 pool, uint256 winnerShare, bool viaLayer2)
        internal
        returns (uint256 jurorFee, uint256 toTreasury)
    {
        jurorFee = (pool * jurorFeeBps) / 10_000;
        uint256 layer1Fee = (pool * layer1FeeBps) / 10_000;
        toTreasury = pool - winnerShare - jurorFee - layer1Fee; // remainder
        toTreasury += layer1Fee;                                // layer1 cost recovery → treasury (pass-1)

        if (viaLayer2 && verifierPool != address(0) && jurorFee != 0) {
            usdc.safeTransfer(verifierPool, jurorFee);
        } else {
            toTreasury += jurorFee;                             // no Layer-2 jurors → treasury
            jurorFee = 0;
        }
    }

    // ------------------------------------------------------------------
    //  Admin
    // ------------------------------------------------------------------

    function setRegistry(address _registry) external onlyOwner {
        if (_registry == address(0)) revert ZeroAddress();
        registry = IImmunityRegistry(_registry);
        emit RegistrySet(_registry);
    }

    function setCreReceiver(address _creReceiver) external onlyOwner {
        if (_creReceiver == address(0)) revert ZeroAddress();
        creReceiver = _creReceiver;
        emit CreReceiverSet(_creReceiver);
    }

    function setVerifierPool(address _verifierPool) external onlyOwner {
        if (_verifierPool == address(0)) revert ZeroAddress();
        verifierPool = _verifierPool;
        emit VerifierPoolSet(_verifierPool);
    }

    function setEconomics(
        uint16 _challengeBondBps,
        uint256 _minChallengeBond,
        uint16 _challengerBountyBps,
        uint16 _jurorFeeBps,
        uint16 _layer1FeeBps,
        uint16 _supermajorityBps,
        uint64 _layer1Timeout,
        uint64 _layer2Timeout
    ) external onlyOwner {
        // No payout path may exceed the loser's pool; treasury takes the remainder.
        if (uint256(_challengerBountyBps) + _jurorFeeBps + _layer1FeeBps > 10_000) revert InvalidBps();
        if (_supermajorityBps > 10_000) revert InvalidBps();
        challengeBondBps = _challengeBondBps;
        minChallengeBond = _minChallengeBond;
        challengerBountyBps = _challengerBountyBps;
        jurorFeeBps = _jurorFeeBps;
        layer1FeeBps = _layer1FeeBps;
        supermajorityBps = _supermajorityBps;
        layer1Timeout = _layer1Timeout;
        layer2Timeout = _layer2Timeout;
        emit EconomicsSet(
            _challengeBondBps, _minChallengeBond, _challengerBountyBps, _jurorFeeBps,
            _layer1FeeBps, _supermajorityBps, _layer1Timeout, _layer2Timeout
        );
    }

    function withdrawTreasury(uint256 amount, address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (amount > treasuryBalance) revert InsufficientBalance();
        unchecked { treasuryBalance -= amount; }
        usdc.safeTransfer(to, amount);
        emit TreasuryWithdrawn(to, amount);
    }

    // ------------------------------------------------------------------
    //  Views
    // ------------------------------------------------------------------

    function getChallenge(bytes32 antibodyId) external view returns (Challenge memory) {
        return challengeOf[antibodyId];
    }
}
