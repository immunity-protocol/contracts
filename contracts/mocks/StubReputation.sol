// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IReputation} from "../interfaces/IReputation.sol";

/// @title StubReputation
/// @notice Test/pass-1 stand-in for the real Reputation contract. Stores a
///         settable score per publisher and records lifecycle callbacks so tests
///         can assert the Registry signals maturation/slash/challenge-won exactly
///         once and on the right address. Replaced by the real contract later.
contract StubReputation is IReputation {
    mapping(address => uint256) private _score;

    mapping(address => uint256) public maturedCalls;
    mapping(address => uint256) public slashCalls;
    mapping(address => uint256) public challengeWonCalls;

    function setScore(address publisher, uint256 score) external {
        _score[publisher] = score;
    }

    function scoreOf(address publisher) external view returns (uint256) {
        return _score[publisher];
    }

    function onMatured(address publisher) external {
        maturedCalls[publisher] += 1;
    }

    function onSlash(address publisher) external {
        slashCalls[publisher] += 1;
    }

    function onChallengeWon(address publisher) external {
        challengeWonCalls[publisher] += 1;
    }
}
