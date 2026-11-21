# CarbonChain Interactive API Playground (#1380)

In non-production environments (`NODE_ENV !== 'production'`), the CarbonChain API exposes an interactive OpenAPI / Swagger UI playground at **`http://localhost:3000/api/docs`** with one-click test account authentication.

This eliminates the need to manually construct and sign a SEP-10 challenge transaction just to explore or test authenticated endpoints during local development.

---

## Quick Start

1. **Start the API in development mode**:
   ```bash
   cd api
   npm run start:dev
   ```
2. **Open the Swagger UI**:
   Navigate to [http://localhost:3000/api/docs](http://localhost:3000/api/docs).
3. **Authenticate with the Test Account**:
   - Click the **"Authorize with Test Account"** button injected into the Swagger UI top bar.
   - Swagger UI automatically sets the `Authorization: Bearer <token>` header for all subsequent **"Try it out"** requests and persists it across page reloads (`persistAuthorization: true`).

---

## Test Account Details

When no custom token is provided, the playground signs a short-lived HS256 JWT using `JWT_SECRET` (or the local dev fallback) with the following claims:

| Claim | Default Value |
| --- | --- |
| `sub` | `GDEVTESTNETACCOUNT7777777777777777777777777777777777777` |
| `role` | `buyer` |
| `network` | `TESTNET` |

### Environment Overrides

| Variable | Description |
| --- | --- |
| `SWAGGER_DEV_JWT` | Optional pre-signed JWT to use instead of the auto-generated dev token. |
| `SWAGGER_TEST_PUBLIC_KEY` | Override the `sub` Stellar public key embedded in the generated dev token. |
| `SWAGGER_TEST_ROLE` | Override the `role` claim (e.g. `admin`, `verifier`, `buyer`). |
| `JWT_SECRET` | Secret used to sign the dev JWT (must match `JwtModule` configuration). |

---

## Switching to a Real SEP-10 Token

If you want to test with a real Stellar wallet signature:

1. Call `GET /api/auth/challenge?account=<PUBLIC_KEY>` to retrieve a SEP-10 challenge XDR.
2. Sign the XDR with your testnet keypair (e.g. Freighter or Stellar Laboratory).
3. Submit the signed XDR to `POST /api/auth/token` to receive an `access_token`.
4. Click **Authorize** in Swagger UI and paste your `access_token`.

---

## Security Note

The **"Authorize with Test Account"** button and pre-generated dev token are **automatically disabled** when `NODE_ENV=production`.
