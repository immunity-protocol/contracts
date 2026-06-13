// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IChallengeManager — verdict intake seams the jury layers call.
/// @notice The CREVerdictReceiver (Layer-1) forwards the diverse-model tally; the
///         VerifierPool (Layer-2) forwards its finalized verdict. The manager owns
///         the challenge state machine and the economics router.
interface IChallengeManager {
    /// @notice Layer-1 (CRE) tally intake. Caller must be the CREVerdictReceiver.
    function submitLayer1Verdict(bytes32 antibodyId, uint16 invalidVotes, uint16 validVotes) external;

    /// @notice Layer-2 (VerifierPool) finalized verdict. Caller must be the VerifierPool.
    function submitLayer2Verdict(bytes32 antibodyId, bool invalid) external;
}
