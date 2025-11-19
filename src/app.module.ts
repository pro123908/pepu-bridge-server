import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ContractListenerModule } from './contract-listener/contract-listener.module';
import { CacheModule } from './cache/cache.module';

@Module({
  imports: [
    CacheModule,
    ContractListenerModule,
    ConfigModule.forRoot({
      isGlobal: true,
    }),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
