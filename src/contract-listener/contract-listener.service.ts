import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { ethers, Wallet, Contract } from 'ethers';
import assert from 'assert';
import { ConfigService } from '@nestjs/config';

import L1_ABI from '../abi/L1_ABI.json';
import L2_ABI from '../abi/L2_ABI.json';
import {
  TransactionCacheService,
  PendingTransaction,
} from '../cache/transaction-cache.service';

@Injectable()
export class ContractListenerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ContractListenerService.name);

  private l1Provider: ethers.JsonRpcProvider | ethers.WebSocketProvider;
  private l2Provider: ethers.JsonRpcProvider | ethers.WebSocketProvider;
  private l1Contract: ethers.Contract;
  private l2Contract: ethers.Contract;

  constructor(
    private readonly config: ConfigService,
    private readonly txCache: TransactionCacheService,
  ) {}

  /* --------------------------
      PENDING TRANSACTION LIST
  ---------------------------*/

  async addPendingTx(tx: PendingTransaction): Promise<void> {
    await this.txCache.addPendingTx(tx);
    this.logger.log(`🟡 Pending TX Added: ${tx.type}`);
  }

  async updateTxStatus(
    hash: string,
    status: 'CONFIRMED' | 'FAILED',
  ): Promise<void> {
    await this.txCache.updateTxStatusByHash(hash, status);
    this.logger.log(`🟢 TX Updated: ${hash} → ${status}`);
  }

  async getPendingTxs(): Promise<PendingTransaction[]> {
    return this.txCache.getAllPendingTxs();
  }

  private readonly L1_RPC_URL =
    process.env.L1_RPC_URL ||
    'https://rpc.ankr.com/eth_sepolia/1155b4860ca369808cfec3bfac2784fccb1fb6346b5687de114a48a0d8fd4c17';
  private readonly L2_RPC_URL =
    process.env.L2_RPC_URL || 'https://base-sepolia-rpc.publicnode.com';

  private readonly L1_CONTRACT_ADDRESS =
    '0x18F1a5F4d9EAFf3C69080CD1105145e464a9640B';
  private readonly L2_CONTRACT_ADDRESS =
    '0x9b2B02820B0f5837898c24d5885E1Bc74b55F89B';

  onModuleInit() {
    this.startListeners();
  }

  startListeners() {
    // :brain: Use WebSocketProvider if available for faster event streaming
    this.l1Provider = new ethers.WebSocketProvider(
      this.L1_RPC_URL.replace('https://', 'wss://').replace('/v3', '/ws/v3'),
    );
    this.l2Provider = new ethers.WebSocketProvider(
      this.L2_RPC_URL.replace('https://', 'wss://').replace('/v3', '/ws/v3'),
    );
    this.l1Contract = new ethers.Contract(
      this.L1_CONTRACT_ADDRESS,
      L1_ABI,
      this.l1Provider,
    );
    this.l2Contract = new ethers.Contract(
      this.L2_CONTRACT_ADDRESS,
      L2_ABI,
      this.l2Provider,
    );
    this.listenToL1Events();
    this.listenToL2Events();
  }

  private listenToL1Events() {
    void this.l1Contract.on(
      'AssetsBuy',
      (
        user: string,
        l2TargetToken: string,
        assetIn: string,
        amountIn: ethers.BigNumberish,
        nonce: ethers.BigNumberish,
        deadline: ethers.BigNumberish,
      ) => {
        this.logger.log(':satellite_antenna: [L1] AssetsBuy event detected!');
        this.logger.log(`User: ${user}`);
        this.logger.log(`L2 Target Token: ${l2TargetToken}`);
        this.logger.log(`Asset In: ${assetIn}`);
        this.logger.log(`Amount In: ${amountIn.toString()}`);
        this.logger.log(`Nonce: ${nonce.toString()}`);
        this.logger.log(`Deadline: ${deadline.toString()}`);

        this.executeBuyOnL2(user, l2TargetToken, amountIn, deadline).catch(
          (err) => {
            this.logger.error('Error executing buy on L2:', err);
          },
        );
      },
    );
    this.logger.log('Listening for L1 AssetsBuy events...');
  }

  private listenToL2Events() {
    void this.l2Contract.on(
      'ASSETS_SOLD',
      (
        user: string,
        targetL1Asset: string,
        nonce: ethers.BigNumberish,
        deadline: ethers.BigNumberish,
      ) => {
        this.logger.log('[L2] ASSETS_SOLD event detected!');
        this.logger.log(`User: ${user}`);
        this.logger.log(`Target L1 Asset: ${targetL1Asset}`);
        this.logger.log(`Nonce: ${nonce.toString()}`);
        this.logger.log(`Deadline: ${deadline.toString()}`);

        this.withdrawOnL1(user, targetL1Asset, deadline).catch((err) => {
          this.logger.error('Error executing withdraw on L1:', err);
        });
      },
    );
    this.logger.log('Listening for L2 ASSETS_SOLD events...');
  }

  onModuleDestroy() {
    this.logger.log('Cleaning up listeners...');
    if (this.l1Contract) void this.l1Contract.removeAllListeners();
    if (this.l2Contract) void this.l2Contract.removeAllListeners();
  }

  async signEIP712Bridge(
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

  async executeBuyOnL2(
    user: string,
    l2TargetToken: string,
    amount: ethers.BigNumberish,
    deadline: ethers.BigNumberish,
  ) {
    try {
      const OWNER_PRIVATE_KEY = this.config.get<string>('OWNER_PRIVATE_KEY');
      if (!OWNER_PRIVATE_KEY) {
        throw new Error(
          'OWNER_PRIVATE_KEY is not defined in environment variables',
        );
      }

      // Implementation for executing buy on L2 goes here
      const provider = new ethers.JsonRpcProvider(this.L2_RPC_URL);
      const owner = new ethers.Wallet(OWNER_PRIVATE_KEY, provider);

      this.logger.log(`Owner Address: ${owner.address}`);
      this.logger.log(`User Address: ${user}`);

      let nonceExeBuy = await this.l2Contract.usedNonces(user);
      nonceExeBuy = Number(nonceExeBuy) + 1;
      // const deadline = Math.floor(Date.now() / 1000) + 3600; // +1 hour

      const l2SignatureBuy = await this.signEIP712Bridge(
        this.l2Contract,
        user,
        l2TargetToken,
        ethers.ZeroAddress, //TODO: Audit Fix needed here
        amount,
        nonceExeBuy,
        deadline,
        owner,
      );
      // console.log('L2 Signature Buy:', l2SignatureBuy);

      // Execute Buy on L2
      const buy = await (this.l2Contract as any)
        .connect(owner)
        .executeBuy(
          user,
          l2TargetToken,
          amount,
          0,
          nonceExeBuy,
          deadline,
          l2SignatureBuy,
          { gasLimit: 500000 },
        );

      // Add pending tx for frontend
      await this.addPendingTx({
        id: Date.now().toString(),
        chain: 'L2',
        type: 'L2_executeBuy',
        user,
        txHash: buy.hash as string,
        status: 'PENDING',
        timestamp: Date.now(),
        amount: amount.toString(),
        token: l2TargetToken,
      });
      console.log('L2 Buy Tx:', buy.hash);
      this.logger.log(`L2 Buy Tx: ${buy.hash}`);
      await buy.wait();
      await this.updateTxStatus(buy.hash as string, 'CONFIRMED');
    } catch (err: any) {
      if (err?.error?.message?.includes('already known')) {
        console.warn(
          '⚠️ Transaction already known, waiting for confirmation...',
        );
      } else {
        console.warn(
          '⚠️ Transaction failed:',
          err?.error?.message || err.message || err,
        );
      }
    }
  }

  async signEIP712BridgeWithdraw(
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

  async withdrawOnL1(
    user: string,
    targetL1Asset: string,
    deadline: ethers.BigNumberish,
  ) {
    try {
      const OWNER_PRIVATE_KEY = this.config.get<string>('OWNER_PRIVATE_KEY');
      if (!OWNER_PRIVATE_KEY) {
        throw new Error(
          'OWNER_PRIVATE_KEY is not defined in environment variables',
        );
      }

      // Implementation for withdrawing on L1 goes here
      const provider = new ethers.JsonRpcProvider(this.L1_RPC_URL);
      const owner = new ethers.Wallet(OWNER_PRIVATE_KEY, provider);

      this.logger.log(`Owner Address: ${owner.address}`);
      this.logger.log(`User Address: ${user}`);

      const userLpShareonL1 = (await this.l1Contract.getUserLpShare(
        user,
        targetL1Asset,
      )) as ethers.BigNumberish;
      console.log(
        'User LP Share on L1 for',
        targetL1Asset,
        ':',
        userLpShareonL1.toString(),
      );

      let nonce = await this.l1Contract.usedNonces(user);
      nonce = Number(nonce) + 1;
      // const deadline = Math.floor(Date.now() / 1000) + 3600; // +1 hour

      const withdrawSignature = this.signEIP712BridgeWithdraw(
        this.l1Contract,
        user,
        targetL1Asset,
        userLpShareonL1,
        nonce,
        deadline,
        owner,
      );

      const withdrawTx = await (this.l1Contract as any)
        .connect(owner)
        .withdraw(
          user,
          targetL1Asset,
          userLpShareonL1,
          nonce,
          deadline,
          withdrawSignature,
          { gasLimit: 500000 },
        );

      // Add pending tx
      await this.addPendingTx({
        id: Date.now().toString(),
        chain: 'L1',
        type: 'L1_WITHDRAW',
        user,
        txHash: withdrawTx.hash as string,
        status: 'PENDING',
        timestamp: Date.now(),
      });

      await withdrawTx.wait();
      console.log('L1 Withdraw Tx:', withdrawTx.hash);
      this.logger.log(`L1 Withdraw Tx: ${withdrawTx.hash}`);
      await this.updateTxStatus(withdrawTx.hash as string, 'CONFIRMED');
    } catch (err: any) {
      if (err?.error?.message?.includes('already known')) {
        console.warn(
          '⚠️ Transaction already known, waiting for confirmation...',
        );
        // Optionally wait for the known tx hash to confirm
      } else {
        console.warn(
          '⚠️ Transaction failed:',
          err?.error?.message || err.message || err,
        );
      }
    }
  }
}
