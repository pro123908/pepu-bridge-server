import { Contract } from 'ethers';
import { Wallet } from 'ethers';
import { ethers } from 'ethers';
import assert from 'assert';

export async function signEIP712Bridge(
  bridgeContract: Contract,
  user: string,
  l2Token: string,
  assetIn: string,
  amount: ethers.BigNumberish,
  nonce: ethers.BigNumberish,
  deadline: ethers.BigNumberish,
  signer: Wallet,
): Promise<string> {
  // Compute type hash for EIP-712 struct
  const TYPEHASH = ethers.keccak256(
    ethers.toUtf8Bytes(
      'ASSETS_BUY(address user,address l2Token,address assetIn,uint256 amount,uint256 nonce,uint256 deadline)',
    ),
  );

  // Encode struct hash
  const structHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      [
        'bytes32',
        'address',
        'address',
        'address',
        'uint256',
        'uint256',
        'uint256',
      ],
      [TYPEHASH, user, l2Token, assetIn, amount, nonce, deadline],
    ),
  );

  // Get domain separator from contract
  const domainSeparator: string = await bridgeContract.DOMAIN_SEPARATOR();

  // Compute EIP-712 digest
  const digest = ethers.keccak256(
    ethers.concat([
      ethers.toUtf8Bytes('\x19\x01'),
      ethers.getBytes(domainSeparator),
      ethers.getBytes(structHash),
    ]),
  );

  // Sign digest
  const sigObj = signer.signingKey.sign(digest);

  const signature = ethers.Signature.from(sigObj).serialized;

  // Verify recovered address
  const recovered = ethers.recoverAddress(digest, signature);

  assert(
    recovered.toLowerCase() === signer.address.toLowerCase(),
    'Signature mismatch',
  );

  return signature;
}

export async function signEIP712BridgeWithdraw(
  bridgeContract: Contract,
  user: string,
  asset: string,
  userLpShare: ethers.BigNumberish,
  nonce: ethers.BigNumberish,
  deadline: ethers.BigNumberish,
  signer: Wallet,
): Promise<string> {
  // Compute type hash for EIP-712 struct
  const TYPEHASH = ethers.keccak256(
    ethers.toUtf8Bytes(
      'ASSETS_SOLD(address user,address assetToWithdraw,uint256 nonce,uint256 deadline)',
    ),
  );

  // Encode struct hash
  const structHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'address', 'address', 'uint256', 'uint256'],
      [TYPEHASH, user, asset, nonce, deadline],
    ),
  );

  // Get domain separator from the contract
  const domainSeparator: string = await bridgeContract.DOMAIN_SEPARATOR();

  // Compute EIP-712 digest
  const digest = ethers.keccak256(
    ethers.concat([
      ethers.toUtf8Bytes('\x19\x01'),
      ethers.getBytes(domainSeparator),
      ethers.getBytes(structHash),
    ]),
  );

  // Sign digest
  const sigObj = signer.signingKey.sign(digest);
  const signature = ethers.Signature.from(sigObj).serialized;

  // Verify recovered address
  const recovered = ethers.recoverAddress(digest, signature);
  assert(
    recovered.toLowerCase() === signer.address.toLowerCase(),
    'Signature mismatch',
  );

  return signature;
}
