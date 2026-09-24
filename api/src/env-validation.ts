import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  ADMIN_SECRET_KEY: Joi.string().required(),
  DATABASE_URL: Joi.string().required(),
  // #559 — comma-separated read replica connection strings; optional.
  DATABASE_REPLICA_URLS: Joi.string().optional().allow(''),
  JWT_SECRET: Joi.string().required().min(32),
  ORACLE_WEBHOOK_SECRET: Joi.string().required().min(16),
  STELLAR_NETWORK: Joi.string().valid('testnet', 'mainnet').default('testnet'),
  STELLAR_HORIZON_URL: Joi.string().uri().required(),
  STELLAR_SOROBAN_RPC: Joi.string().uri().required(),
  IPFS_API_KEY: Joi.string().required(),
  IPFS_SECRET_KEY: Joi.string().required(),
  PORT: Joi.number().default(3000),
  FRONTEND_URL: Joi.string().uri().optional(),
  REDIS_URL: Joi.string().uri().optional(),
  LOG_LEVEL: Joi.string()
    .valid('fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent')
    .default('info'),
  WEBHOOK_ALLOWED_IPS: Joi.string().optional(),
});
