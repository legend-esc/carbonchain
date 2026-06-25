import { envValidationSchema } from './env-validation';

/**
 * Issue #46 — Verify that the Joi validation schema rejects missing required env vars.
 * Issue #255 — Verify that JWT_SECRET has minimum length 32 to prevent token forgery.
 */

describe('Environment Variable Validation (#46, #255)', () => {
  const validEnv = {
    ADMIN_SECRET_KEY:
      'SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/carbonchain',
    JWT_SECRET: 'supersecret1234567890123456789012',
    STELLAR_NETWORK: 'testnet',
    STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org',
    STELLAR_SOROBAN_RPC: 'https://soroban-testnet.stellar.org',
  };

  it('passes with all required vars present', () => {
    const { error } = envValidationSchema.validate(validEnv);
    expect(error).toBeUndefined();
  });

  it('fails when ADMIN_SECRET_KEY is missing', () => {
    const { ADMIN_SECRET_KEY: _, ...rest } = validEnv;
    const { error } = envValidationSchema.validate(rest);
    expect(error).toBeDefined();
    expect(error!.message).toContain('ADMIN_SECRET_KEY');
  });

  it('fails when DATABASE_URL is missing', () => {
    const { DATABASE_URL: _, ...rest } = validEnv;
    const { error } = envValidationSchema.validate(rest);
    expect(error).toBeDefined();
    expect(error!.message).toContain('DATABASE_URL');
  });

  it('fails when JWT_SECRET is missing', () => {
    const { JWT_SECRET: _, ...rest } = validEnv;
    const { error } = envValidationSchema.validate(rest);
    expect(error).toBeDefined();
    expect(error!.message).toContain('JWT_SECRET');
  });

  it('fails when JWT_SECRET is shorter than 32 characters', () => {
    const invalidEnv = { ...validEnv, JWT_SECRET: 'short' };
    const { error } = envValidationSchema.validate(invalidEnv);
    expect(error).toBeDefined();
    expect(error!.message).toContain('JWT_SECRET');
  });

  it('applies default PORT of 3000 when not set', () => {
    const { value } = envValidationSchema.validate(validEnv);
    expect(value.PORT).toBe(3000);
  });

  it('applies default STELLAR_NETWORK of testnet when not set', () => {
    const { STELLAR_NETWORK: _, ...rest } = validEnv;
    const { value } = envValidationSchema.validate(rest);
    expect(value.STELLAR_NETWORK).toBe('testnet');
  });
});
