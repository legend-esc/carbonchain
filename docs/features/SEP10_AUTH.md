# SEP-10 Authentication

CarbonChain uses [SEP-10](https://stellar.org/protocol/sep-10) (Stellar Web Authentication) to authenticate users via their Stellar wallet (Freighter) without ever exposing private keys to the server.

## Flow

```
Client                          API                         Stellar Network
  │                               │                               │
  │  POST /auth/challenge          │                               │
  │  { account: "G..." }          │                               │
  │ ─────────────────────────────>│                               │
  │                               │  build challenge transaction  │
  │                               │  (manage_data op, 15 min TTL)│
  │  { transaction: "base64..." } │                               │
  │ <─────────────────────────────│                               │
  │                               │                               │
  │  sign via Freighter           │                               │
  │                               │                               │
  │  POST /auth/verify            │                               │
  │  { transaction: "signed..." } │                               │
  │ ─────────────────────────────>│                               │
  │                               │  verify signature             │
  │                               │  verify sequence == 0         │
  │                               │  verify time bounds           │
  │  { token: "jwt..." }          │                               │
  │ <─────────────────────────────│                               │
```

## Endpoints

### `POST /api/v1/auth/challenge`

Request a SEP-10 challenge transaction.

**Body**
```json
{ "account": "GABC...XYZ" }
```

**Response**
```json
{ "transaction": "<base64-encoded XDR>" }
```

### `POST /api/v1/auth/verify`

Submit the signed challenge to receive a JWT.

**Body**
```json
{ "transaction": "<base64-encoded signed XDR>" }
```

**Response**
```json
{ "token": "<JWT>", "expiresIn": "7d" }
```

## Using the JWT

Include the token in subsequent API calls:

```http
Authorization: Bearer <JWT>
```

Protected endpoints (retire, create offer, admin ops) require a valid JWT.

## Security Properties

- Challenge transactions use sequence number `0` — they are never submitted on-chain.
- Time bounds enforce a 15-minute expiry on the challenge.
- The server verifies the account signature without receiving the private key.
- JWTs expire after `JWT_EXPIRES_IN` (default: 7 days).

## Configuration

```env
JWT_SECRET=your-jwt-secret-here
JWT_EXPIRES_IN=7d
```
