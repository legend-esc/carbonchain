# Webhook Monitor (MRV Oracle)

CarbonChain exposes a webhook endpoint that receives MRV (Monitoring, Reporting, Verification) data from IoT devices and satellite feeds and forwards it to the `mrv_oracle` Soroban contract.

## Endpoint

```
POST /api/v1/oracle/webhook
```

Requests must include a shared secret header for authentication:

```http
X-Webhook-Secret: <ORACLE_WEBHOOK_SECRET>
```

## Payload

```json
{
  "oracle": "GABC...XYZ",
  "project_id": "PROJ-001",
  "tonnes": 1500000,
  "recorded_at": 1735689600
}
```

| Field | Type | Description |
|-------|------|-------------|
| `oracle` | string | Stellar address of the registered oracle |
| `project_id` | string | Project identifier (must match a registered project) |
| `tonnes` | number | Carbon sequestration in scaled units (1 tonne = 1,000,000) |
| `recorded_at` | number | Unix timestamp of the measurement |

## Anomaly Detection

The `mrv_oracle` contract flags a reading as anomalous when it deviates more than **20 %** from the previous reading for the same project. Anomalous readings are stored but trigger a re-verification workflow.

## Error Responses

| Status | Meaning |
|--------|---------|
| `401 Unauthorized` | Missing or invalid `X-Webhook-Secret` |
| `400 Bad Request` | Payload validation failed |
| `503 Service Unavailable` | Oracle contract is paused |

## Configuration

```env
ORACLE_WEBHOOK_SECRET=your-webhook-secret
MRV_ORACLE_CONTRACT_ID=C...
```
