import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ContractListenerModule } from './contract-listener/contract-listener.module';
import { ContractListenerService } from './contract-listener/contract-listener.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    ContractListenerModule,
  ],
  controllers: [AppController],
  providers: [AppService, ContractListenerService],
})
export class AppModule {}
