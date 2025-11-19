import { Injectable } from '@nestjs/common';
import { ContractListenerService } from './contract-listener/contract-listener.service';

@Injectable()
export class AppService {
  constructor(private readonly contractService: ContractListenerService) {}

  getHello(): string {
    return 'Hello World!';
  }

  async getPending() {
    return this.contractService.getPendingTxs();
  }
}
