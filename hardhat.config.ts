import { defineConfig } from "hardhat/config";
import hardhatToolboxMochaEthersPlugin from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import { configVariable } from "hardhat/config";

// Base pins:
//   - Base Sepolia chainId 84532, Base mainnet chainId 8453
//   - evmVersion "cancun" — Base supports the full Cancun opcode set
//     (unlike 0G Galileo, which forced "shanghai")
//   - default Sepolia RPC: https://sepolia.base.org

export default defineConfig({
  plugins: [hardhatToolboxMochaEthersPlugin],
  solidity: {
    // Both profiles need viaIR — `default` is used for `hardhat compile`/`test`,
    // `production` is what `hardhat ignition deploy` switches to. Without viaIR
    // the large `AntibodyPublished` event makes `publish()` hit "Stack too deep".
    profiles: {
      default: {
        version: "0.8.24",
        settings: {
          evmVersion: "cancun",
          optimizer: { enabled: true, runs: 200 },
          viaIR: true,
        },
      },
      production: {
        version: "0.8.24",
        settings: {
          evmVersion: "cancun",
          optimizer: { enabled: true, runs: 200 },
          viaIR: true,
        },
      },
    },
  },
  // Testnet deploys only need 1 confirmation; combined with the serialized
  // ImmunityCore module this keeps the sequential deploy reasonably fast.
  ignition: {
    requiredConfirmations: 1,
  },
  networks: {
    baseSepolia: {
      type: "http",
      chainType: "l1",
      chainId: 84532,
      url: configVariable("IMMUNITY_BASE_SEPOLIA_RPC"),
      accounts: [configVariable("IMMUNITY_DEPLOYER_PK")],
    },
    base: {
      type: "http",
      chainType: "l1",
      chainId: 8453,
      url: configVariable("IMMUNITY_BASE_RPC"),
      accounts: [configVariable("IMMUNITY_DEPLOYER_PK")],
    },
  },
});
