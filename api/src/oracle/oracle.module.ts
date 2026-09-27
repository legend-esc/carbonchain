import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { OracleService } from './oracle.service';
import { OracleController } from './oracle.controller';
import { StellarModule } from '../stellar/stellar.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [ConfigModule, StellarModule, AuthModule],
  controllers: [OracleController],
  providers: [OracleService],
})
export class OracleModule {}
