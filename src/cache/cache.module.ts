import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TransactionCacheService } from './transaction-cache.service';
import { Transaction, TransactionSchema } from './transaction.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Transaction.name, schema: TransactionSchema },
    ]),
  ],
  providers: [TransactionCacheService],
  exports: [TransactionCacheService],
})
export class CacheModule {}
