// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IProtectedSet} from "../interfaces/IProtectedSet.sol";

/// @title StubProtectedSet
/// @notice Test/pass-1 stand-in for the curated ProtectedSet. Lets tests flip a
///         target's protected status to exercise bond scaling. Replaced by the
///         real timelock/multisig-curated contract by address later.
contract StubProtectedSet is IProtectedSet {
    mapping(address => bool) private _protected;

    function setProtected(address target, bool ok) external {
        _protected[target] = ok;
    }

    function isProtected(address target) external view returns (bool) {
        return _protected[target];
    }
}
