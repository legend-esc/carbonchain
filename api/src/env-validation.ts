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
  /**
   * Issue #945 — Explicit reverse-proxy trust policy for the throttler.
   *
   * TRUST_PROXY: boolean (0 or 1).
   *   0 (default) — no reverse proxy is trusted; the throttler always uses the
   *                 direct socket IP. x-forwarded-for is completely ignored.
   *                 Use in dev / direct-internet deployments.
   *   1           — the API sits behind a trusted reverse proxy (e.g. the nginx
   *                 container in docker-compose). XFF is honoured when the direct
   *                 connection comes from an address in TRUSTED_PROXY_CIDRS.
   *
   * TRUSTED_PROXY_CIDRS: comma-separated IPv4 CIDR list.
   *   Only meaningful when TRUST_PROXY=1. Overrides the default RFC1918 list.
   *   Example: "10.0.0.0/8,172.16.0.0/12"
   *   Set to empty string to trust nothing even when TRUST_PROXY=1.
   */
  TRUST_PROXY: Joi.number().integer().valid(0, 1).default(0),
  TRUSTED_PROXY_CIDRS: Joi.string().optional().allow(''),
});
