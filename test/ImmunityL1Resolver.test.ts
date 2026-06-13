import { expect } from "chai";
import { getEthers } from "./utils.js";

// Unit tests for the signed off-chain resolver. These prove the EIP-3668 +
// ENSIP-10 surface and that the signing scheme matches the ENS reference, so
// the off-chain gateway is verifiably compatible.
describe("ImmunityL1Resolver", function () {
  let ethers: any;
  let owner: any, stranger: any;
  let signerWallet: any, strangerWallet: any;
  let resolver: any;
  const URLS = ["http://localhost:8787/{sender}/{data}.json"];
  // Deterministic keys so we can sign raw digests directly.
  const SIGNER_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
  const STRANGER_PK = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba";

  // text(genesis-1.immunity.eth, "immunity.reputation") style inner call.
  const NAME = "0x0a67656e657369732d3107696d6d756e69747903657468 00".replace(/\s/g, "");
  const DATA = "0xdeadbeef";

  beforeEach(async function () {
    ethers = await getEthers();
    [owner, stranger] = await ethers.getSigners();
    signerWallet = new ethers.Wallet(SIGNER_PK);
    strangerWallet = new ethers.Wallet(STRANGER_PK);
    resolver = await (await ethers.getContractFactory("ImmunityL1Resolver")).deploy(
      URLS,
      signerWallet.address,
    );
    await resolver.waitForDeployment();
  });

  it("constructs with gateway urls + trusted signer", async function () {
    expect(await resolver.gatewayUrls(0)).to.equal(URLS[0]);
    expect(await resolver.trustedSigner()).to.equal(signerWallet.address);
    expect(await resolver.owner()).to.equal(owner.address);
  });

  it("supportsInterface: IExtendedResolver (0x9061b923) + ERC165 (0x01ffc9a7)", async function () {
    expect(await resolver.supportsInterface("0x9061b923")).to.equal(true);
    expect(await resolver.supportsInterface("0x01ffc9a7")).to.equal(true);
    expect(await resolver.supportsInterface("0xffffffff")).to.equal(false);
  });

  it("resolve reverts OffchainLookup with our gateway url + resolveWithProof callback", async function () {
    const callData = resolver.interface.encodeFunctionData("resolve", [NAME, DATA]);
    let reverted = false;
    try {
      await ethers.provider.call({ to: await resolver.getAddress(), data: callData });
    } catch (e: any) {
      reverted = true;
      const parsed = resolver.interface.parseError(e.data ?? e.error?.data ?? e.info?.error?.data);
      expect(parsed.name).to.equal("OffchainLookup");
      expect(parsed.args.sender).to.equal(await resolver.getAddress());
      expect(parsed.args.urls[0]).to.equal(URLS[0]);
      // callbackFunction == resolveWithProof.selector
      expect(parsed.args.callbackFunction).to.equal(
        resolver.interface.getFunction("resolveWithProof").selector,
      );
    }
    expect(reverted).to.equal(true);
  });

  // The headline: a response signed by the trusted signer with the ENS-reference
  // scheme verifies and returns the result.
  async function signResponse(account: any, target: string, expires: bigint, callData: string, result: string) {
    const hash = await resolver.makeSignatureHash(target, expires, callData, result);
    // Sign the raw digest (no eth-message prefix), matching the reference's
    // signer.signDigest + ECDSA.recover(hash, sig).
    const sig = account.signingKey.sign(hash).serialized;
    return sig;
  }

  it("resolveWithProof accepts a correctly signed response and returns result", async function () {
    const result = ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["100"]);
    const callData = resolver.interface.encodeFunctionData("resolve", [NAME, DATA]);
    const expires = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const sig = await signResponse(signerWallet, await resolver.getAddress(), expires, callData, result);

    const response = ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes", "uint64", "bytes"],
      [result, expires, sig],
    );
    const extraData = ethers.AbiCoder.defaultAbiCoder().encode(["bytes"], [callData]);

    const returned = await resolver.resolveWithProof(response, extraData);
    expect(returned).to.equal(result);
  });

  it("resolveWithProof rejects a response signed by the wrong key", async function () {
    const result = ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["100"]);
    const callData = resolver.interface.encodeFunctionData("resolve", [NAME, DATA]);
    const expires = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const sig = await signResponse(strangerWallet, await resolver.getAddress(), expires, callData, result);

    const response = ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes", "uint64", "bytes"],
      [result, expires, sig],
    );
    const extraData = ethers.AbiCoder.defaultAbiCoder().encode(["bytes"], [callData]);

    await expect(resolver.resolveWithProof(response, extraData)).to.be.revertedWithCustomError(
      resolver,
      "InvalidSigner",
    );
  });

  it("resolveWithProof rejects an expired signature", async function () {
    const result = ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["100"]);
    const callData = resolver.interface.encodeFunctionData("resolve", [NAME, DATA]);
    const expires = 1n; // long past
    const sig = await signResponse(signerWallet, await resolver.getAddress(), expires, callData, result);

    const response = ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes", "uint64", "bytes"],
      [result, expires, sig],
    );
    const extraData = ethers.AbiCoder.defaultAbiCoder().encode(["bytes"], [callData]);

    await expect(resolver.resolveWithProof(response, extraData)).to.be.revertedWithCustomError(
      resolver,
      "SignatureExpired",
    );
  });

  it("owner can rotate the trusted signer; stranger cannot", async function () {
    await resolver.setTrustedSigner(stranger.address);
    expect(await resolver.trustedSigner()).to.equal(stranger.address);
    await expect(
      resolver.connect(stranger).setTrustedSigner(owner.address),
    ).to.be.revertedWithCustomError(resolver, "OwnableUnauthorizedAccount");
  });
});
