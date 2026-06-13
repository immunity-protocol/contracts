// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MaliciousUSDC
/// @notice Test-only ERC20 that re-enters its `victim` (the Registry) during
///         transfer. Used to verify that the Registry's `nonReentrant` guard
///         blocks classic reentrancy attacks via the token transfer path.
contract MaliciousUSDC is ERC20 {
    address public victim;
    bool public attacking;

    constructor() ERC20("Malicious", "MAL") {}

    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function setVictim(address v) external { victim = v; }
    function setAttacking(bool a) external { attacking = a; }

    /// @dev OpenZeppelin v5's central transfer hook. We attempt a recursive
    ///      `withdraw(1)` call back into the victim. If the guard does its job,
    ///      that call reverts and we report `REENTRY_BLOCKED`. If the guard
    ///      somehow passes, we report `REENTRY_SUCCEEDED` so the test fails loudly.
    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (attacking && victim != address(0) && from == victim) {
            (bool ok, ) = victim.call(
                abi.encodeWithSignature("withdraw(uint256)", uint256(1))
            );
            if (ok) revert("REENTRY_SUCCEEDED");
            revert("REENTRY_BLOCKED");
        }
    }
}
