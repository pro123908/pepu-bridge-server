import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { ethers } from 'ethers';
import { ConfigService } from '@nestjs/config';

import L1_ABI from '../abi/L1SwapBridge.json';
import L2_ABI from '../abi/L2SwapBridge.json';
import {
  TransactionCacheService,
  PendingTransaction,
} from '../cache/transaction-cache.service';
import {
  getTokenDecimals,
  signEIP712Bridge,
  signEIP712BridgeWithdraw,
} from 'src/utils/indes';

@Injectable()
export class ContractListenerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ContractListenerService.name);

  private l1Provider: ethers.JsonRpcProvider | ethers.WebSocketProvider;
  private l2Provider: ethers.JsonRpcProvider | ethers.WebSocketProvider;
  private l1Contract: ethers.Contract;
  private l2Contract: ethers.Contract;

  // Health check properties
  private l1HealthCheckInterval: NodeJS.Timeout;
  private l2HealthCheckInterval: NodeJS.Timeout;
  private l1ConnectionRetries = 0;
  private l2ConnectionRetries = 0;
  private readonly MAX_RETRIES = 10;
  private readonly HEALTH_CHECK_INTERVAL = 30000; // 30 seconds
  private readonly BACKOFF_BASE = 2000; // 2 seconds base

  // Event deduplication tracker - loaded from database on startup
  private processedEventHashes = new Set<string>();
  private readonly HISTORICAL_BLOCK_RANGE = 1000; // Look back 1000 blocks
  private readonly EVENT_RECHECK_INTERVAL = 300000; // Re-check historical events every 5 minutes
  private eventRecheckL1Interval: NodeJS.Timeout;
  private eventRecheckL2Interval: NodeJS.Timeout;

  private getEventTxHash(event: any): string | undefined {
    if (!event) return undefined;
    // direct property on event
    if (typeof event.transactionHash === 'string' && event.transactionHash) {
      return event.transactionHash;
    }
    // some logged shapes include a nested `log` with transactionHash
    if (event.log && typeof event.log.transactionHash === 'string') {
      return event.log.transactionHash;
    }
    // receipt or transaction objects
    if (event.receipt && typeof event.receipt.transactionHash === 'string') {
      return event.receipt.transactionHash;
    }
    if (event.transaction && typeof event.transaction.hash === 'string') {
      return event.transaction.hash;
    }
    return undefined;
  }

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
    return this.txCache.getAll();
  }

  private readonly L1_RPC_URL =
    process.env.L1_RPC_URL ||
    'https://rpc.ankr.com/eth_sepolia/1155b4860ca369808cfec3bfac2784fccb1fb6346b5687de114a48a0d8fd4c17';
  private readonly L2_RPC_URL =
    process.env.L2_RPC_URL || 'https://base-sepolia-rpc.publicnode.com';

  private readonly L1_CONTRACT_ADDRESS =
    '0x6D14e0bAe3dE162B88168Ba720347F88470F793F';
  private readonly L2_CONTRACT_ADDRESS =
    '0xCdA1e65611250455f785b54215659EBCE6827a5D';

  onModuleInit() {
    this.startListeners();
    // Load existing processed hashes from database
    void this.loadProcessedHashesFromDatabase();
  }

  private async loadProcessedHashesFromDatabase(): Promise<void> {
    try {
      const allTxs = await this.txCache.getAll();
      for (const tx of allTxs) {
        if (tx.eventHash) this.processedEventHashes.add(tx.eventHash);
        if (tx.txHash) this.processedEventHashes.add(tx.txHash);
      }
      this.logger.log(
        `✅ Loaded ${this.processedEventHashes.size} processed hashes from database`,
      );
    } catch (err) {
      this.logger.error(
        '❌ Failed to load processed hashes from database:',
        err,
      );
    }
  }

  startListeners() {
    this.logger.log('🚀 Starting contract listeners...');
    this.setupL1Listener();
    this.setupL2Listener();
    this.startHealthChecks();
  }

  private setupL1Listener() {
    try {
      this.l1Provider = new ethers.WebSocketProvider(
        this.L1_RPC_URL.replace('https://', 'wss://').replace('/v3', '/ws/v3'),
      );

      // Add error handlers for provider
      this.l1Provider.on('error', (err) => {
        this.logger.error('❌ L1 Provider error:', err);
        this.reconnectL1();
      });

      this.l1Provider.on('network', (newNetwork, oldNetwork) => {
        if (oldNetwork) {
          this.logger.log(
            `🔄 L1 Network changed from ${oldNetwork.chainId} to ${newNetwork.chainId}`,
          );
          this.l1ConnectionRetries = 0; // Reset retries on successful reconnection
        }
      });

      this.l1Contract = new ethers.Contract(
        this.L1_CONTRACT_ADDRESS,
        L1_ABI,
        this.l1Provider,
      );

      this.listenToL1Events();
      this.l1ConnectionRetries = 0;
      this.logger.log('✅ L1 Listener setup successfully');
    } catch (err) {
      this.logger.error('❌ Failed to setup L1 listener:', err);
      this.reconnectL1();
    }
  }

  private setupL2Listener() {
    try {
      this.l2Provider = new ethers.WebSocketProvider(
        this.L2_RPC_URL.replace('https://', 'wss://').replace('/v3', '/ws/v3'),
      );

      // Add error handlers for provider
      this.l2Provider.on('error', (err) => {
        this.logger.error('❌ L2 Provider error:', err);
        this.reconnectL2();
      });

      this.l2Provider.on('network', (newNetwork, oldNetwork) => {
        if (oldNetwork) {
          this.logger.log(
            `🔄 L2 Network changed from ${oldNetwork.chainId} to ${newNetwork.chainId}`,
          );
          this.l2ConnectionRetries = 0; // Reset retries on successful reconnection
        }
      });

      this.l2Contract = new ethers.Contract(
        this.L2_CONTRACT_ADDRESS,
        L2_ABI,
        this.l2Provider,
      );

      this.listenToL2Events();
      this.l2ConnectionRetries = 0;
      this.logger.log('✅ L2 Listener setup successfully');
    } catch (err) {
      this.logger.error('❌ Failed to setup L2 listener:', err);
      this.reconnectL2();
    }
  }

  private reconnectL1() {
    if (this.l1ConnectionRetries >= this.MAX_RETRIES) {
      this.logger.error(
        `❌ L1 Max retries (${this.MAX_RETRIES}) reached. Stopping reconnection attempts.`,
      );
      return;
    }

    const delay = this.BACKOFF_BASE * Math.pow(2, this.l1ConnectionRetries);
    this.l1ConnectionRetries++;

    this.logger.warn(
      `⚠️ Attempting L1 reconnection ${this.l1ConnectionRetries}/${this.MAX_RETRIES} in ${delay}ms...`,
    );

    setTimeout(() => {
      this.setupL1Listener();
    }, delay);
  }

  private reconnectL2() {
    if (this.l2ConnectionRetries >= this.MAX_RETRIES) {
      this.logger.error(
        `❌ L2 Max retries (${this.MAX_RETRIES}) reached. Stopping reconnection attempts.`,
      );
      return;
    }

    const delay = this.BACKOFF_BASE * Math.pow(2, this.l2ConnectionRetries);
    this.l2ConnectionRetries++;

    this.logger.warn(
      `⚠️ Attempting L2 reconnection ${this.l2ConnectionRetries}/${this.MAX_RETRIES} in ${delay}ms...`,
    );

    setTimeout(() => {
      this.setupL2Listener();
    }, delay);
  }

  private startHealthChecks() {
    // L1 Health check
    this.l1HealthCheckInterval = setInterval(() => {
      void this.checkL1Health();
    }, this.HEALTH_CHECK_INTERVAL);

    // L2 Health check
    this.l2HealthCheckInterval = setInterval(() => {
      void this.checkL2Health();
    }, this.HEALTH_CHECK_INTERVAL);

    // Periodic re-check of historical L1 events (catch any missed events)
    this.eventRecheckL1Interval = setInterval(() => {
      void this.catchHistoricalL1Events();
    }, this.EVENT_RECHECK_INTERVAL);

    // Periodic re-check of historical L2 events (catch any missed events)
    this.eventRecheckL2Interval = setInterval(() => {
      void this.catchHistoricalL2Events();
    }, this.EVENT_RECHECK_INTERVAL);

    this.logger.log('✅ Health checks and event re-checking started');
  }

  private async checkL1Health() {
    try {
      if (!this.l1Provider) {
        this.logger.warn('⚠️ L1 Provider not initialized');
        this.reconnectL1();
        return;
      }

      await this.l1Provider.getBlockNumber();
      // Reset retry counter on successful health check
      if (this.l1ConnectionRetries > 0) {
        this.l1ConnectionRetries = 0;
        this.logger.log('✅ L1 connection restored');
      }
    } catch (err) {
      this.logger.error('❌ L1 health check failed:', err);
      this.reconnectL1();
    }
  }

  private async checkL2Health() {
    try {
      if (!this.l2Provider) {
        this.logger.warn('⚠️ L2 Provider not initialized');
        this.reconnectL2();
        return;
      }

      await this.l2Provider.getBlockNumber();
      // Reset retry counter on successful health check
      if (this.l2ConnectionRetries > 0) {
        this.l2ConnectionRetries = 0;
        this.logger.log('✅ L2 connection restored');
      }
    } catch (err) {
      this.logger.error('❌ L2 health check failed:', err);
      this.reconnectL2();
    }
  }

  private listenToL1Events() {
    void this.l1Contract.on(
      'AssetsBuy',
      (
        user: string,
        assetIn: string,
        amountIn: ethers.BigNumberish,
        l2TargetToken: string,
        deadline: ethers.BigNumberish,
        nonce: ethers.BigNumberish,
        event: any,
      ) => {
        // Extract tx hash robustly and check for duplicates
        const eventHash = this.getEventTxHash(event);
        if (!eventHash) {
          this.logger.warn('⚠️ L1 event missing transaction hash, skipping');
          return;
        }

        if (this.processedEventHashes.has(eventHash)) {
          this.logger.debug(`⏭️  Skipping duplicate L1 event1: ${eventHash}`);
          return;
        }

        this.processedEventHashes.add(eventHash);

        // Check database before executing
        this.txCache
          .txHashExists(eventHash)
          .then((exists) => {
            if (exists) {
              this.logger.debug(
                `📊 Transaction already in database: ${eventHash}`,
              );
              return;
            }

            this.logger.log(
              ':satellite_antenna: [L1] AssetsBuy event detected!',
            );
            this.logger.log(`User: ${user}`);
            this.logger.log(`L2 Target Token: ${l2TargetToken}`);
            this.logger.log(`Asset In: ${assetIn}`);
            this.logger.log(`Amount In: ${amountIn.toString()}`);
            this.logger.log(`Nonce: ${nonce.toString()}`);
            this.logger.log(`Deadline: ${deadline.toString()}`);

            this.executeBuyOnL2(
              user,
              assetIn,
              amountIn,
              l2TargetToken,
              deadline,
              eventHash,
            ).catch((err) => {
              this.logger.error('Error executing buy on L2:', err);
            });
          })
          .catch((err) => {
            this.logger.error('Error checking database for L1 event:', err);
          });
      },
    );
    this.logger.log('Listening for L1 AssetsBuy events...');

    // Catch historical events from last 1000 blocks
    void this.catchHistoricalL1Events();
  }

  private listenToL2Events() {
    void this.l2Contract.on(
      'ASSETS_SOLD',
      (
        user: string,
        tokenToSell: string,
        amountIn: ethers.BigNumberish,
        targetL1Asset: string,
        deadline: ethers.BigNumberish,
        nonce: ethers.BigNumberish,
        event: any,
      ) => {
        // Extract tx hash robustly and check for duplicates
        const eventHash = this.getEventTxHash(event);
        if (!eventHash) {
          this.logger.warn('⚠️ L2 event missing transaction hash, skipping');
          return;
        }

        if (this.processedEventHashes.has(eventHash)) {
          this.logger.debug(`⏭️  Skipping duplicate L2 event: ${eventHash}`);
          return;
        }

        this.processedEventHashes.add(eventHash);

        // Check database before executing
        this.txCache
          .txHashExists(eventHash)
          .then((exists) => {
            if (exists) {
              this.logger.debug(
                `📊 Transaction already in database: ${eventHash}`,
              );
              return;
            }

            this.logger.log('[L2] ASSETS_SOLD event detected!');
            this.logger.log(`User: ${user}`);
            this.logger.log(`Target L1 Asset: ${targetL1Asset}`);
            this.logger.log(`Nonce: ${nonce.toString()}`);
            this.logger.log(`Deadline: ${deadline.toString()}`);
            this.logger.log(`Token To Sell: ${tokenToSell}`);
            this.logger.log(`Amount In: ${amountIn.toString()}`);

            this.withdrawOnL1(
              user,
              tokenToSell,
              amountIn,
              targetL1Asset,
              deadline,
              eventHash,
            ).catch((err) => {
              this.logger.error('Error executing withdraw on L1:', err);
            });
          })
          .catch((err) => {
            this.logger.error('Error checking database for L2 event:', err);
          });
      },
    );
    this.logger.log('Listening for L2 ASSETS_SOLD events...');

    // Catch historical events from last 1000 blocks
    void this.catchHistoricalL2Events();
  }

  private async catchHistoricalL1Events(): Promise<void> {
    try {
      const currentBlock = await this.l1Provider.getBlockNumber();
      const fromBlock = Math.max(0, currentBlock - this.HISTORICAL_BLOCK_RANGE);

      this.logger.log(
        `📜 Checking L1 historical events from block ${fromBlock} to ${currentBlock}`,
      );

      const events = await (this.l1Contract as any).queryFilter(
        this.l1Contract.filters.AssetsBuy(),
        fromBlock,
        currentBlock,
      );

      if (events.length > 0) {
        this.logger.log(
          `ℹ️ Found ${events.length} L1 historical AssetsBuy events`,
        );

        let processedCount = 0;
        let duplicateCount = 0;

        for (const event of events) {
          const eventHash = this.getEventTxHash(event);

          if (!eventHash) {
            this.logger.debug(
              '⚠️ Historical L1 event missing tx hash, skipping',
            );
            continue;
          }

          // Skip if already processed
          if (this.processedEventHashes.has(eventHash)) {
            duplicateCount++;
            this.logger.debug(`⏭️  Skipping duplicate L1 event2: ${eventHash}`);
            continue;
          }

          // Mark as processed
          this.processedEventHashes.add(eventHash);
          processedCount++;
          this.logger.log(
            `✅ Processing new historical L1 event: ${eventHash}`,
          );
        }

        this.logger.log(
          `📊 L1 Historical: ${processedCount} new, ${duplicateCount} duplicates skipped`,
        );
      } else {
        this.logger.log('✅ No missed L1 events found');
      }
    } catch (err) {
      this.logger.error('❌ Error catching historical L1 events:', err);
    }
  }

  private async catchHistoricalL2Events(): Promise<void> {
    try {
      const currentBlock = await this.l2Provider.getBlockNumber();
      const fromBlock = Math.max(0, currentBlock - this.HISTORICAL_BLOCK_RANGE);

      this.logger.log(
        `📜 Checking L2 historical events from block ${fromBlock} to ${currentBlock}`,
      );

      const events = await (this.l2Contract as any).queryFilter(
        this.l2Contract.filters.ASSETS_SOLD(),
        fromBlock,
        currentBlock,
      );

      if (events.length > 0) {
        this.logger.log(
          `ℹ️ Found ${events.length} L2 historical ASSETS_SOLD events`,
        );

        let processedCount = 0;
        let duplicateCount = 0;

        for (const event of events) {
          const eventHash = this.getEventTxHash(event);

          if (!eventHash) {
            this.logger.debug(
              '⚠️ Historical L2 event missing tx hash, skipping',
            );
            continue;
          }

          // Skip if already processed
          if (this.processedEventHashes.has(eventHash)) {
            duplicateCount++;
            this.logger.debug(`⏭️  Skipping duplicate L2 event: ${eventHash}`);
            continue;
          }

          // Mark as processed
          this.processedEventHashes.add(eventHash);
          processedCount++;
          this.logger.log(
            `✅ Processing new historical L2 event: ${eventHash}`,
          );
        }

        this.logger.log(
          `📊 L2 Historical: ${processedCount} new, ${duplicateCount} duplicates skipped`,
        );
      } else {
        this.logger.log('✅ No missed L2 events found');
      }
    } catch (err) {
      this.logger.error('❌ Error catching historical L2 events:', err);
    }
  }

  onModuleDestroy() {
    this.logger.log('🛑 Cleaning up listeners and health checks...');

    // Clear all intervals
    if (this.l1HealthCheckInterval) clearInterval(this.l1HealthCheckInterval);
    if (this.l2HealthCheckInterval) clearInterval(this.l2HealthCheckInterval);
    if (this.eventRecheckL1Interval) clearInterval(this.eventRecheckL1Interval);
    if (this.eventRecheckL2Interval) clearInterval(this.eventRecheckL2Interval);

    // Remove all event listeners
    if (this.l1Contract) {
      void this.l1Contract.removeAllListeners();
      this.logger.log('✅ L1 listeners removed');
    }
    if (this.l2Contract) {
      void this.l2Contract.removeAllListeners();
      this.logger.log('✅ L2 listeners removed');
    }

    // Close WebSocket connections
    if (this.l1Provider && 'destroy' in this.l1Provider) {
      void (this.l1Provider as any).destroy();
      this.logger.log('✅ L1 Provider connection closed');
    }
    if (this.l2Provider && 'destroy' in this.l2Provider) {
      void (this.l2Provider as any).destroy();
      this.logger.log('✅ L2 Provider connection closed');
    }

    this.logger.log('🛑 Cleanup completed');
  }

  async executeBuyOnL2(
    user: string,
    assetIn: string,
    amountIn: ethers.BigNumberish,
    l2TargetToken: string,
    deadline: ethers.BigNumberish,
    eventHash: string,
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

      const contract2 = new ethers.Contract(
        this.L2_CONTRACT_ADDRESS,
        L2_ABI,
        owner,
      );

      this.logger.log(`Owner Address: ${owner.address}`);
      this.logger.log(`User Address: ${user}`);

      // Read nonce from contract - cast to any to avoid TS typing issues with dynamic ABI methods
      const nonceExeBuyRaw = await (contract2 as any).usedNonces(user);
      let nonceExeBuy = Number(nonceExeBuyRaw) + 1;
      this.logger.log(`Nonce for Execute Buy: ${nonceExeBuy}`);
      // const deadline = Math.floor(Date.now() / 1000) + 3600; // +1 hour

      const assetInDecimals = await getTokenDecimals(assetIn, this.L1_RPC_URL);

      // Convert to human-readable: amount / (10^tokenDecimals)
      const humanReadable = Number(amountIn) / 10 ** assetInDecimals;

      // Convert to 18 decimals (wei)
      const etherValue = ethers.parseUnits(humanReadable.toString(), 18);

      const l2SignatureBuy = await signEIP712Bridge(
        contract2,
        user,
        l2TargetToken,
        ethers.ZeroAddress, //TODO: Audit Fix needed here
        etherValue,
        nonceExeBuy,
        deadline,
        owner,
      );
      this.logger.log(`L2 Signature Buy: ${l2SignatureBuy}`);
      // console.log('L2 Signature Buy:', l2SignatureBuy);

      // Execute Buy on L2
      const buy = await (contract2 as any)
        .connect(owner)
        .executeBuy(
          user,
          l2TargetToken,
          etherValue,
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
        type: 'BUY',
        user: user,
        amount: humanReadable.toString(),
        l1Token: assetIn, // Token from L1 AssetsBuy event
        l2Token: l2TargetToken, // Target token on L2
        eventHash: eventHash, // L1 AssetsBuy event hash
        txHash: buy.hash as string, // L2 executeBuy transaction hash
        status: 'PENDING',
        timestamp: Date.now(),
      });
      this.logger.log(`L2 Buy Tx: ${buy.hash}`);
      await buy.wait();
      await this.updateTxStatus(buy.hash as string, 'CONFIRMED');
    } catch (err: any) {
      if (err?.error?.message?.includes('already known')) {
        this.logger.warn(
          '⚠️ Transaction already known, waiting for confirmation...',
        );
      } else {
        this.logger.error(
          '⚠️ Transaction failed:',
          err?.error?.message || err.message || err,
        );
      }
    }
  }

  async withdrawOnL1(
    user: string,
    tokenToSell: string,
    amountIn: ethers.BigNumberish,
    targetL1Asset: string,
    deadline: ethers.BigNumberish,
    eventHash: string,
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

      const contract1 = new ethers.Contract(
        this.L1_CONTRACT_ADDRESS,
        L1_ABI,
        provider,
      );

      this.logger.log(`Owner Address: ${owner.address}`);
      this.logger.log(`User Address: ${user}`);

      const userLpShareonL1 = (await contract1.getUserLpShare(
        user,
        targetL1Asset,
      )) as ethers.BigNumberish;
      this.logger.log(
        'User LP Share on L1 for',
        targetL1Asset,
        ':',
        userLpShareonL1.toString(),
      );

      let nonce = await contract1.usedNonces(user);
      nonce = Number(nonce) + 1;
      this.logger.log(`Nonce for Withdraw: ${nonce}`);

      const tokenToSellInDecimals = await getTokenDecimals(
        tokenToSell,
        this.L2_RPC_URL,
      );

      // Convert to human-readable: amount / (10^tokenDecimals)
      const humanReadable = Number(amountIn) / 10 ** tokenToSellInDecimals;

      // Convert to 18 decimals (wei)
      const etherValue = ethers.parseUnits(humanReadable.toString(), 18);

      const withdrawSignature = signEIP712BridgeWithdraw(
        contract1,
        user,
        targetL1Asset,
        userLpShareonL1,
        nonce,
        deadline,
        owner,
      );
      this.logger.log(`L1 Withdraw Signature: ${withdrawSignature}`);

      const withdrawTx = await (contract1 as any)
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
        type: 'SELL',
        user,
        amount: humanReadable.toString(),
        l1Token: targetL1Asset, // L1 withdrawal token
        l2Token: tokenToSell, // Asset token from L2 event
        eventHash: eventHash, // L2 ASSETS_SOLD event hash
        txHash: withdrawTx.hash as string, // L1 withdraw transaction hash
        status: 'PENDING',
        timestamp: Date.now(),
      });

      await withdrawTx.wait();
      this.logger.log(`L1 Withdraw Tx: ${withdrawTx.hash}`);
      await this.updateTxStatus(withdrawTx.hash as string, 'CONFIRMED');
    } catch (err: any) {
      if (err?.error?.message?.includes('already known')) {
        this.logger.warn(
          '⚠️ Transaction already known, waiting for confirmation...',
        );
      } else {
        this.logger.error(
          '⚠️ Transaction failed:',
          err?.error?.message || err.message || err,
        );
      }
    }
  }
}
