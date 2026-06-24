import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { OracleService } from './oracle.service';
import { OracleController } from './oracle.controller';
import { StellarModule } from '../stellar/stellar.module';

@Module({
  imports: [ConfigModule, StellarModule],
  controllers: [OracleController],
  providers: [OracleService],
})
export class OracleModule {}
