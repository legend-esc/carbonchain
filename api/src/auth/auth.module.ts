import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { StellarAuthStrategy } from './stellar-auth.strategy';
import { StellarModule } from '../stellar/stellar.module';
import { JwtAuthGuard } from './jwt-auth.guard';

@Module({
  imports: [
    PassportModule,
    StellarModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        // #923 — Refuse to start when JWT_SECRET is absent.
        // env-validation.ts enforces this at boot; the guard here prevents
        // the JwtModule from signing tokens with an empty/default key if the
        // validation is somehow bypassed.
        const jwtSecret = config.get<string>('JWT_SECRET');
        if (!jwtSecret) {
          throw new Error(
            'JWT_SECRET is not set. ' +
              'Set a strong random value (≥ 32 characters) in api/.env before starting the server.',
          );
        }
        return {
          secret: jwtSecret,
          signOptions: { expiresIn: '1h' },
        };
      },
    }),
  ],
  providers: [
    AuthService,
    StellarAuthStrategy,
    // JwtAuthGuard depends on AuthService (for blocklist check) — provide it
    // explicitly so NestJS can inject AuthService via its constructor.
    JwtAuthGuard,
  ],
  controllers: [AuthController],
  exports: [AuthService, JwtAuthGuard],
})
export class AuthModule {}
