// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockUSDC
/// @notice 6-decimal ERC20 mimicking USDC for testnet and local development.
///         Public `mint` lets demo wallets self-fund; never deploy this on mainnet.
///         The Registry takes the USDC token address as a constructor parameter,
///         so production deploys just pass the canonical USDC address instead of
///         deploying this contract.
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
