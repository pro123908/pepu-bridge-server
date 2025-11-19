import { Injectable, Inject } from '@nestjs/common';
import { CACHE_MANAGER, Cache } from '@nestjs/cache-manager';

export interface PendingTransaction {
  id: string;
  chain: string;
  type: string;
  user: string;
  amount?: string;
  token?: string;
  txHash?: string;
  status: 'PENDING' | 'CONFIRMED' | 'FAILED';
  timestamp: number;
}

@Injectable()
export class TransactionCacheService {
  private readonly PENDING_TXS_KEY = 'pending-transactions';
  private readonly TX_PREFIX = 'tx:';

  constructor(@Inject(CACHE_MANAGER) private cacheManager: Cache) {}

  /**
   * Add a pending transaction to the cache
   */
  async addPendingTx(tx: PendingTransaction): Promise<void> {
    const allTxs = await this.getAllPendingTxs();
    allTxs.push(tx);
    // Store with 24 hour TTL
    await this.cacheManager.set(this.PENDING_TXS_KEY, allTxs, 86400000);
  }

  /**
   * Get all pending transactions
   */
  async getAllPendingTxs(): Promise<PendingTransaction[]> {
    const txs = await this.cacheManager.get<PendingTransaction[]>(
      this.PENDING_TXS_KEY,
    );
    return txs || [];
  }

  /**
   * Get a pending transaction by hash
   */
  async getPendingTxByHash(hash: string): Promise<PendingTransaction | null> {
    const allTxs = await this.getAllPendingTxs();
    return allTxs.find((tx) => tx.txHash === hash) || null;
  }

  /**
   * Update transaction status by hash
   */
  async updateTxStatusByHash(
    hash: string,
    status: 'CONFIRMED' | 'FAILED',
  ): Promise<boolean> {
    const allTxs = await this.getAllPendingTxs();
    const tx = allTxs.find((t) => t.txHash === hash);

    if (tx) {
      tx.status = status;
      await this.cacheManager.set(this.PENDING_TXS_KEY, allTxs, 86400000);
      return true;
    }
    return false;
  }

  /**
   * Get all pending transactions for a specific user
   */
  async getUserPendingTxs(userAddress: string): Promise<PendingTransaction[]> {
    const allTxs = await this.getAllPendingTxs();
    return allTxs.filter(
      (tx) => tx.user.toLowerCase() === userAddress.toLowerCase(),
    );
  }

  /**
   * Get all pending transactions for a specific chain
   */
  async getChainPendingTxs(chain: string): Promise<PendingTransaction[]> {
    const allTxs = await this.getAllPendingTxs();
    return allTxs.filter((tx) => tx.chain === chain);
  }

  /**
   * Clear all pending transactions
   */
  async clearAllPendingTxs(): Promise<void> {
    await this.cacheManager.del(this.PENDING_TXS_KEY);
  }
}
