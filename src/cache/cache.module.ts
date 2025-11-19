import { Module } from '@nestjs/common';
import { CacheModule as NestCacheModule } from '@nestjs/cache-manager';
import { TransactionCacheService } from './transaction-cache.service';

@Module({
  imports: [NestCacheModule.register()],
  providers: [TransactionCacheService],
  exports: [TransactionCacheService],
})
export class CacheModule {}
