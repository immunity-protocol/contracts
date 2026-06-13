import hre from "hardhat";

export const ZERO_BYTES32 = "0x" + "00".repeat(32);

export const ABTYPE = {
  ADDRESS: 0,
  CALL_PATTERN: 1,
  BYTECODE: 2,
  GRAPH: 3,
  SEMANTIC: 4,
} as const;

export const VERDICT = { MALICIOUS: 0, SUSPICIOUS: 1 } as const;

// New lifecycle ordering: PROBATION → ACTIVE → CHALLENGED → {SLASHED | EXPIRED}.
export const STATUS = {
  PROBATION: 0,
  ACTIVE: 1,
  CHALLENGED: 2,
  SLASHED: 3,
  EXPIRED: 4,
} as const;

// Defaults that mirror the contract's initial params.
export const CHECK_FEE = 2_000n;
export const PUBLISHER_SHARE = 1_600n; // 80%
export const TREASURY_SHARE = 400n; // 20%
export const BOND_BASE = 1_000_000n; // 1.0 USDC
export const BOND_FLOOR = 1_000_000n;
export const PROTECTED_MULT = 10n;

// Far-future TTL so default publishes satisfy the mandatory `expiresAt > now`.
export const FAR_FUTURE = 4_000_000_000; // ~year 2096

export async function getEthers() {
  const connection = await hre.network.connect();
  return (connection as any).ethers;
}

export async function setupRegistryFixture() {
  const ethers = await getEthers();
  const [owner, alice, bob, carol, dave, challengeManager, challenger] =
    await ethers.getSigners();

  const MockUSDC = await ethers.getContractFactory("MockUSDC");
  const usdc = await MockUSDC.deploy();
  await usdc.waitForDeployment();

  const registrar = await (await ethers.getContractFactory("StubPublisherRegistrar")).deploy();
  await registrar.waitForDeployment();
  const reputation = await (await ethers.getContractFactory("StubReputation")).deploy();
  await reputation.waitForDeployment();
  const protectedSet = await (await ethers.getContractFactory("StubProtectedSet")).deploy();
  await protectedSet.waitForDeployment();

  const Registry = await ethers.getContractFactory("ImmunityRegistry");
  const registry = await Registry.deploy(
    await usdc.getAddress(),
    await registrar.getAddress(),
    await reputation.getAddress(),
    await protectedSet.getAddress(),
    challengeManager.address,
  );
  await registry.waitForDeployment();

  return {
    ethers,
    owner,
    alice,
    bob,
    carol,
    dave,
    challengeManager,
    challenger,
    usdc,
    registrar,
    reputation,
    protectedSet,
    registry,
  };
}

/// Mint USDC, approve, and deposit into the operator's prepaid balance.
export async function fund(registry: any, usdc: any, operator: any, amount: bigint) {
  await usdc.mint(operator.address, amount);
  await usdc.connect(operator).approve(await registry.getAddress(), amount);
  await registry.connect(operator).deposit(amount);
}

/// Register a publisher and give them a reputation score (default above the floor).
export async function registerPublisher(
  registrar: any,
  reputation: any,
  account: any,
  score: bigint = 100n,
) {
  await registrar.setRegistered(account.address, true);
  await reputation.setScore(account.address, score);
}

export function makeParams(ethers: any, overrides: Partial<any> = {}) {
  return {
    abType: ABTYPE.ADDRESS,
    flavor: 0,
    verdict: VERDICT.MALICIOUS,
    confidence: 80,
    severity: 60,
    primaryMatcherHash: ethers.id("primary"),
    evidenceCid: ethers.id("evidence"),
    contextHash: ethers.id("context"),
    embeddingHash: ZERO_BYTES32,
    attestation: ethers.id("attestation"),
    expiresAt: FAR_FUTURE,
    reviewer: ethers.ZeroAddress,
    auxiliaryKey: ZERO_BYTES32,
    ...overrides,
  };
}

/// Advance EVM time by `seconds` and mine a block.
export async function increaseTime(ethers: any, seconds: number) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}
