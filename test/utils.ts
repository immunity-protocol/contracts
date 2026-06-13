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

/// Full challenge-game stack: real Registry + Reputation + ChallengeManager +
/// CREVerdictReceiver + VerifierPool, plus stub registrar/protectedSet. The CRE
/// receiver is deployed with the workflow pins DISABLED (zero) so integration
/// tests can drive `onReport` from the `forwarder` signer. `alice` is registered
/// and funded; `challenger` holds USDC approved to the manager.
export async function setupChallengeFixture() {
  const ethers = await getEthers();
  const [owner, alice, bob, carol, challenger, forwarder] = await ethers.getSigners();

  const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
  await usdc.waitForDeployment();
  const registrar = await (await ethers.getContractFactory("StubPublisherRegistrar")).deploy();
  await registrar.waitForDeployment();
  const reputation = await (await ethers.getContractFactory("Reputation")).deploy();
  await reputation.waitForDeployment();
  const protectedSet = await (await ethers.getContractFactory("StubProtectedSet")).deploy();
  await protectedSet.waitForDeployment();

  // Manager has no constructor dep on the registry, so deploy it first and pass
  // its address into the Registry constructor as the wired challengeManager.
  const manager = await (await ethers.getContractFactory("ChallengeManager")).deploy(
    await usdc.getAddress(),
  );
  await manager.waitForDeployment();

  const registry = await (await ethers.getContractFactory("ImmunityRegistry")).deploy(
    await usdc.getAddress(),
    await registrar.getAddress(),
    await reputation.getAddress(),
    await protectedSet.getAddress(),
    await manager.getAddress(),
  );
  await registry.waitForDeployment();

  const receiver = await (await ethers.getContractFactory("CREVerdictReceiver")).deploy(
    forwarder.address,
    ZERO_BYTES32, // workflow id pin disabled
    ethers.ZeroAddress, // workflow owner pin disabled
  );
  await receiver.waitForDeployment();
  const pool = await (await ethers.getContractFactory("VerifierPool")).deploy();
  await pool.waitForDeployment();

  // Wire everything.
  await reputation.setAuthorizedWriter(await registry.getAddress(), true);
  await manager.setRegistry(await registry.getAddress());
  await manager.setCreReceiver(await receiver.getAddress());
  await manager.setVerifierPool(await pool.getAddress());
  await receiver.setChallengeManager(await manager.getAddress());
  await pool.setChallengeManager(await manager.getAddress());

  // alice: registered publisher with Registry balance for antibody bonds.
  await registrar.setRegistered(alice.address, true);
  await reputation.grantGenesisReputation(alice.address, 100n);
  await fund(registry, usdc, alice, 100_000_000n);

  // challenger: USDC approved to the manager for challenge bonds.
  await usdc.mint(challenger.address, 100_000_000n);
  await usdc.connect(challenger).approve(await manager.getAddress(), 100_000_000n);

  return {
    ethers, owner, alice, bob, carol, challenger, forwarder,
    usdc, registrar, reputation, protectedSet, registry, manager, receiver, pool,
  };
}
