import * as Joi from 'joi';

/**
 * Issue #46 — Verify that the Joi validation schema rejects missing required env vars.
 */
const envSchema = Joi.object({
  ADMIN_SECRET_KEY: Joi.string().required(),
  DATABASE_URL: Joi.string().required(),
  JWT_SECRET: Joi.string().required(),
  STELLAR_NETWORK: Joi.string().valid('testnet', 'mainnet').default('testnet'),
  STELLAR_HORIZON_URL: Joi.string().uri().required(),
  STELLAR_SOROBAN_RPC: Joi.string().uri().required(),
  PORT: Joi.number().default(3000),
});

describe('Environment Variable Validation (#46)', () => {
  const validEnv = {
    ADMIN_SECRET_KEY:
      'SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/carbonchain',
    JWT_SECRET: 'supersecret',
    STELLAR_NETWORK: 'testnet',
    STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org',
    STELLAR_SOROBAN_RPC: 'https://soroban-testnet.stellar.org',
  };

  it('passes with all required vars present', () => {
    const { error } = envSchema.validate(validEnv);
    expect(error).toBeUndefined();
  });

  it('fails when ADMIN_SECRET_KEY is missing', () => {
    const { ADMIN_SECRET_KEY: _, ...rest } = validEnv;
    const { error } = envSchema.validate(rest);
    expect(error).toBeDefined();
    expect(error!.message).toContain('ADMIN_SECRET_KEY');
  });

  it('fails when DATABASE_URL is missing', () => {
    const { DATABASE_URL: _, ...rest } = validEnv;
    const { error } = envSchema.validate(rest);
    expect(error).toBeDefined();
    expect(error!.message).toContain('DATABASE_URL');
  });

  it('fails when JWT_SECRET is missing', () => {
    const { JWT_SECRET: _, ...rest } = validEnv;
    const { error } = envSchema.validate(rest);
    expect(error).toBeDefined();
    expect(error!.message).toContain('JWT_SECRET');
  });

  it('applies default PORT of 3000 when not set', () => {
    const { value } = envSchema.validate(validEnv);
    expect(value.PORT).toBe(3000);
  });

  it('applies default STELLAR_NETWORK of testnet when not set', () => {
    const { STELLAR_NETWORK: _, ...rest } = validEnv;
    const { value } = envSchema.validate(rest);
    expect(value.STELLAR_NETWORK).toBe('testnet');
  });
});
