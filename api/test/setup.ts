process.env.ADMIN_SECRET_KEY ||=
  'SCI7YTM2J5ZQOQ4SI5L5ZCXZDTXSMONGDFFHGQCPWAP6CCRBPYRCIATS';
process.env.DATABASE_URL ||=
  'postgresql://postgres:postgres@localhost:5432/carbonchain';
process.env.JWT_SECRET ||= 'test-jwt-secret-with-enough-length-for-validation';
process.env.CREDIT_REGISTRY_CONTRACT_ID ||=
  'GCRZUKNU2J5GLSYTZR4OLO7OBJJVHSMVBGG7IVUZU5FXMFHUDCLDGQJX';
process.env.RETIREMENT_CONTRACT_ID ||=
  'GCRZUKNU2J5GLSYTZR4OLO7OBJJVHSMVBGG7IVUZU5FXMFHUDCLDGQJX';
process.env.IPFS_API_KEY ||= 'test-ipfs-api-key';
process.env.IPFS_SECRET_KEY ||= 'test-ipfs-secret-key';
process.env.STELLAR_HORIZON_URL ||= 'https://horizon-testnet.stellar.org';
process.env.STELLAR_SOROBAN_RPC ||= 'https://soroban-testnet.stellar.org';
