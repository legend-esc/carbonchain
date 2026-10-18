# Secrets Management

CarbonChain separates non-secret configuration from sensitive credentials. This document explains how secrets are stored, injected, and kept out of version control.

---

## File layout

```
carbonchain/
├── api/
│   └── .env.example          # Non-secret config template (tracked in git)
├── secrets/
│   ├── .gitignore            # Ignores .env.secrets; tracks .env.secrets.example
│   ├── .env.secrets.example  # Secret vars template (tracked in git)
│   └── .env.secrets          # Real secrets (NOT tracked — gitignored)
```

---

## What goes where

| Variable | File | Reason |
|---|---|---|
| `STELLAR_NETWORK`, `HORIZON_URL`, `SOROBAN_RPC_URL` | `api/.env` | Non-sensitive network config |
| `ADMIN_PUBLIC_KEY` | `api/.env` | Public key — safe to commit |
| `JWT_EXPIRES_IN`, `CORS_ORIGINS`, `HOME_DOMAIN` | `api/.env` | Non-sensitive runtime config |
| `WEBHOOK_ALLOWED_IPS`, `LOG_LEVEL`, `CACHE_TTL_SECONDS` | `api/.env` | Non-sensitive runtime config |
| `CREDIT_REGISTRY_CONTRACT_ID` (and other contract IDs) | `api/.env` | Non-sensitive post-deploy values |
| `ADMIN_SECRET_KEY` | `secrets/.env.secrets` | Stellar signing key — never expose |
| `JWT_SECRET` | `secrets/.env.secrets` | Cryptographic signing secret |
| `ORACLE_WEBHOOK_SECRET` | `secrets/.env.secrets` | HMAC secret for webhook verification |
| `DATABASE_URL` | `secrets/.env.secrets` | Contains database password |
| `DATABASE_REPLICA_URLS` | `secrets/.env.secrets` | Contains database password |
| `POSTGRES_PASSWORD` | `secrets/.env.secrets` | PostgreSQL superuser password |
| `REPLICATION_PASSWORD` | `secrets/.env.secrets` | PostgreSQL replication role password |

---

## First-time setup

```bash
# 1. Copy the non-secret config template
cp api/.env.example api/.env

# 2. Copy the secrets template
cp secrets/.env.secrets.example secrets/.env.secrets

# 3. Generate secrets and fill in secrets/.env.secrets
#    Stellar admin keypair:
stellar keys generate admin
#    JWT and webhook secrets:
openssl rand -hex 32   # JWT_SECRET
openssl rand -hex 32   # ORACLE_WEBHOOK_SECRET

# 4. Edit secrets/.env.secrets with the generated values
#    Also update POSTGRES_PASSWORD and REPLICATION_PASSWORD with strong passwords.
#    Make sure DATABASE_URL and DATABASE_REPLICA_URLS use those same passwords.
```

---

## How secrets are injected at runtime

### Docker Compose (local / staging)

`docker-compose.override.yml` adds `env_file: ./secrets/.env.secrets` to the `api` service. Docker Compose merges the two env files: `api/.env` (non-secret) and `secrets/.env.secrets` (secret). Variables from `secrets/.env.secrets` take precedence when there is a conflict (e.g., `DATABASE_URL` pointing at the real host instead of localhost).

```yaml
# docker-compose.override.yml (excerpt)
services:
  api:
    env_file:
      - ./secrets/.env.secrets
```

### Production

In production, inject secrets via your platform's native secret management:

- **AWS ECS / Fargate**: use AWS Secrets Manager or SSM Parameter Store — reference secrets in the task definition's `secrets:` field, not `environment:`.
- **Kubernetes**: use Kubernetes Secrets (or an external secrets operator like External Secrets Operator) mounted as environment variables or volume files.
- **Heroku / Railway / Render**: set secrets through the platform dashboard or CLI — never in committed config files.

Do **not** copy `secrets/.env.secrets` into a Docker image or push it to a container registry.

---

## Resource limits

All Docker Compose services declare resource limits under `deploy.resources.limits` to prevent runaway processes from exhausting host resources:

| Service | CPU limit | Memory limit |
|---|---|---|
| `postgres` | 1.0 | 512 MB |
| `postgres-replica` | 0.5 | 384 MB |
| `redis` | 0.5 | 128 MB |
| `redis-replica-1` / `redis-replica-2` | 0.25 | 64 MB each |
| `redis-sentinel-1/2/3` | 0.1 | 32 MB each |
| `api` | 1.0 | 512 MB |
| `frontend` | 0.25 | 64 MB |

These limits apply to `docker compose` (Compose v2) and Swarm mode. They are **not** enforced by `docker-compose` v1 without Swarm; upgrade to Compose v2 (`docker compose`) if limits are not taking effect.

---

## Security checklist

- [ ] `secrets/.env.secrets` is listed in `secrets/.gitignore` — verify with `git status`
- [ ] `ADMIN_SECRET_KEY` is never placed in `api/.env` or committed anywhere
- [ ] `JWT_SECRET` is at least 256 bits of entropy (`openssl rand -hex 32`)
- [ ] `POSTGRES_PASSWORD` and `REPLICATION_PASSWORD` use strong, unique passwords in production
- [ ] Secrets are rotated on any suspected exposure
- [ ] CI/CD pipelines inject secrets via environment variable secrets (e.g., GitHub Actions Secrets), not hardcoded values
