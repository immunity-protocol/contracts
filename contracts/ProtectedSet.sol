// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";

import {IProtectedSet} from "./interfaces/IProtectedSet.sol";
import {ZeroAddress} from "./libraries/Errors.sol";

/// @title ProtectedSet — Immunity's curated blue-chip safety rail.
/// @notice A governance-controlled allowlist of objectively-legit addresses (USDC,
///         WETH, canonical routers, major Base protocols). The ImmunityRegistry
///         reads `isProtected` for **bond scaling only** — flagging a protected
///         target costs the large bond multiplier and is cached as
///         `prominenceTier = 1`. The other "protected" effects live elsewhere by
///         design: the advisory-max enforcement cap is a read-side SDK rule, and
///         auto-open-challenge is a ChallengeManager behavior (pass-2). This
///         contract is just the list.
///
///         Governance: the list is itself a capture/censorship target (an attacker
///         who could add their own scam address, remove a real protection, or
///         freeze a blue-chip would break the protocol), so writes use
///         `Ownable2Step`. On mainnet ownership is transferred to a
///         TimelockController / Safe multisig; on testnet the deployer may hold it.
///         A single hot-key owner is explicitly NOT the production posture. Holds
///         no funds → minimal attack surface.
contract ProtectedSet is IProtectedSet, Ownable2Step {
    mapping(address => bool) internal _protected;

    // Enumeration for the explorer (the curated list is small).
    address[] internal _list;
    mapping(address => uint256) internal _idx; // index+1; 0 = absent

    event ProtectedUpdated(address indexed target, bool protected);

    constructor() Ownable(msg.sender) {}

    /// @inheritdoc IProtectedSet
    function isProtected(address target) external view returns (bool) {
        return _protected[target];
    }

    /// @notice Add or remove a single target. Owner = timelock/multisig in production.
    function setProtected(address target, bool ok) external onlyOwner {
        _set(target, ok);
    }

    /// @notice Batch add/remove — used to seed the list at deploy (#9).
    function setProtectedBatch(address[] calldata targets, bool ok) external onlyOwner {
        for (uint256 i; i < targets.length; ++i) {
            _set(targets[i], ok);
        }
    }

    /// @dev Mutates the set + maintains the enumeration only when state changes.
    function _set(address target, bool ok) internal {
        if (target == address(0)) revert ZeroAddress();
        if (_protected[target] == ok) return; // no-op; keep list/idx consistent

        _protected[target] = ok;
        if (ok) {
            _list.push(target);
            _idx[target] = _list.length; // index+1
        } else {
            uint256 pos = _idx[target] - 1;
            uint256 last = _list.length - 1;
            if (pos != last) {
                address moved = _list[last];
                _list[pos] = moved;
                _idx[moved] = pos + 1;
            }
            _list.pop();
            delete _idx[target];
        }
        emit ProtectedUpdated(target, ok);
    }

    // ------------------------------------------------------------------
    //  Views (explorer)
    // ------------------------------------------------------------------

    function getProtectedCount() external view returns (uint256) {
        return _list.length;
    }

    function protectedAt(uint256 index) external view returns (address) {
        return _list[index];
    }

    function getAll() external view returns (address[] memory) {
        return _list;
    }
}
