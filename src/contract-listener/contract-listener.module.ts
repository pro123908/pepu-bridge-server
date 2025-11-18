import { Module } from '@nestjs/common';
import { ContractListenerService } from './contract-listener.service';

@Module({
  providers: [ContractListenerService],
})
export class ContractListenerModule {}
