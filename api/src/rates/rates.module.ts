import { Module } from '@nestjs/common';
import { RatesController } from './rates.controller';
import { CommonModule } from '../common/common.module';

@Module({
  imports: [CommonModule],
  controllers: [RatesController],
})
export class RatesModule {}
