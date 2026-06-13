// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IChallengeManager} from "../interfaces/IChallengeManager.sol";

/// @title MockChallengeManager
/// @notice Records verdict forwards so CREVerdictReceiver unit tests can assert
///         the decoded tally without standing up the full challenge stack.
contract MockChallengeManager is IChallengeManager {
    bytes32 public lastAntibodyId;
    uint16 public lastInvalidVotes;
    uint16 public lastValidVotes;
    uint256 public layer1Calls;

    function submitLayer1Verdict(bytes32 antibodyId, uint16 invalidVotes, uint16 validVotes) external {
        lastAntibodyId = antibodyId;
        lastInvalidVotes = invalidVotes;
        lastValidVotes = validVotes;
        layer1Calls += 1;
    }

    function submitLayer2Verdict(bytes32, bool) external {}
}
