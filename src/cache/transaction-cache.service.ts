import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Transaction, TransactionDocument } from './transaction.schema';

export interface PendingTransaction {
  id: string;
  chain: string; // 'L1' | 'L2'
  type: string; // 'BUY' | 'SELL'
  user: string;
  amount?: string;
  l1Token?: string; // Token address on L1
  l2Token?: string; // Token address on L2
  eventHash?: string; // Original event transaction hash
  txHash?: string; // Relayer execution transaction hash
  status: 'PENDING' | 'CONFIRMED' | 'FAILED';
  timestamp: number;
}

@Injectable()
export class TransactionCacheService {
  constructor(
    @InjectModel(Transaction.name)
    private transactionModel: Model<TransactionDocument>,
  ) {}

  /**
   * Add a pending transaction to the database
   */
  async addPendingTx(tx: PendingTransaction): Promise<void> {
    await this.transactionModel.findOneAndUpdate({ id: tx.id }, tx, {
      upsert: true,
      new: true,
    });
  }

  /**
   * Get all transactions
   */
  async getAll(): Promise<PendingTransaction[]> {
    try {
      const txs = await this.transactionModel
        .find()
        .lean()
        .sort({ createdAt: -1 })
        .limit(1000); // Limit to recent 1000 to avoid memory issues
      return txs as PendingTransaction[];
    } catch (err) {
      console.error('Error fetching transactions:', err);
      return [];
    }
  }

  /**
   * Get a pending transaction by hash (searches both eventHash and txHash)
   */
  async getPendingTxByHash(hash: string): Promise<PendingTransaction | null> {
    try {
      const result = await this.transactionModel
        .findOne({
          $or: [{ eventHash: hash }, { txHash: hash }],
        })
        .lean();
      return result as PendingTransaction | null;
    } catch (err) {
      console.error('Error fetching transaction by hash:', err);
      return null;
    }
  }

  /**
   * Check if a transaction hash already exists in database (eventHash or txHash)
   */
  async txHashExists(hash: string): Promise<boolean> {
    try {
      const result = await this.transactionModel.countDocuments({
        $or: [{ eventHash: hash }, { txHash: hash }],
      });
      return result > 0;
    } catch (err) {
      console.error('Error checking if tx hash exists:', err);
      return false;
    }
  }

  /**
   * Update transaction status by hash (searches both eventHash and txHash)
   */
  async updateTxStatusByHash(
    hash: string,
    status: 'PENDING' | 'CONFIRMED' | 'FAILED',
  ): Promise<boolean> {
    try {
      const result = await this.transactionModel.updateOne(
        {
          $or: [{ eventHash: hash }, { txHash: hash }],
        },
        { $set: { status } },
      );
      return result.modifiedCount > 0;
    } catch (err) {
      console.error(`Error updating transaction status for hash ${hash}:`, err);
      return false;
    }
  }

  /**
   * Get pending transactions for a specific user (query-based, not in-memory filtering)
   */
  async getUserPendingTxs(userAddress: string): Promise<PendingTransaction[]> {
    try {
      const txs = await this.transactionModel
        .find({
          user: userAddress.toLowerCase(),
          status: 'PENDING',
        })
        .lean()
        .sort({ createdAt: -1 });
      return txs as PendingTransaction[];
    } catch (err) {
      console.error(`Error fetching pending txs for user ${userAddress}:`, err);
      return [];
    }
  }

  /**
   * Get pending transactions for a specific chain (query-based, not in-memory filtering)
   */
  async getChainPendingTxs(chain: string): Promise<PendingTransaction[]> {
    try {
      const txs = await this.transactionModel
        .find({
          chain,
          status: 'PENDING',
        })
        .lean()
        .sort({ createdAt: -1 });
      return txs as PendingTransaction[];
    } catch (err) {
      console.error(`Error fetching pending txs for chain ${chain}:`, err);
      return [];
    }
  }

  /**
   * Clear all pending transactions
   */
  async clearAllPendingTxs(): Promise<void> {
    await this.transactionModel.deleteMany({});
  }
}
