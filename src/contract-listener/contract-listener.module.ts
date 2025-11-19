import { Module } from '@nestjs/common';
import { ContractListenerService } from './contract-listener.service';
import { CacheModule } from '../cache/cache.module';

@Module({
  imports: [CacheModule],
  providers: [ContractListenerService],
  exports: [ContractListenerService],
})
export class ContractListenerModule {}
