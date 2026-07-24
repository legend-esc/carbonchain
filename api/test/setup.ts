process.env.ADMIN_SECRET_KEY ||=
  'SCI7YTM2J5ZQOQ4SI5L5ZCXZDTXSMONGDFFHGQCPWAP6CCRBPYRCIATS';
process.env.DATABASE_URL ||=
  'postgresql://postgres:postgres@localhost:5432/carbonchain';
process.env.JWT_SECRET ||= 'test-jwt-secret';
process.env.STELLAR_HORIZON_URL ||= 'https://horizon-testnet.stellar.org';
process.env.STELLAR_SOROBAN_RPC ||= 'https://soroban-testnet.stellar.org';
