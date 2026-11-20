# DEX Routing Strategy

CarbonChain integrates with the Stellar DEX to provide liquid secondary-market trading for carbon credits. The marketplace contract manages on-chain offers; the API handles DEX path-finding and order routing.

## Offer Lifecycle

1. Seller calls `POST /api/v1/marketplace/offer` with `credit_id`, `price_xlm`, and `tonnes`.
2. The API invokes `create_offer` on the marketplace contract, which escrows the credit.
3. Buyers browse listings via `GET /api/v1/marketplace/listings`.
4. Buyer calls `POST /api/v1/marketplace/buy/:offerId`, triggering `fill_offer` on-chain.
5. The contract atomically transfers XLM to the seller and the credit to the buyer.

## Price Routing

For large trades the API queries Stellar's path-payment endpoints to find the best multi-hop route between the buyer's asset and XLM before submitting the fill. This minimises slippage on low-liquidity pairs.

## Fee Model

The marketplace contract charges a configurable fee (default **30 bps**, i.e. 0.3 %) on each fill, transferred to the `FeeRecipient` address set by the admin.

| Parameter | Default | Contract key |
|-----------|---------|--------------|
| Fee | 30 bps | `FeeBps` |
| Minimum price | 1 stroop | `MinPrice` |
| Offer expiry | no limit | per-offer `expires_at` |

## Expired Offers

`cleanup_expired_offers` removes offers past their `expires_at` timestamp. It is bounded to process at most **50 offers per call** to stay within the Soroban instruction budget.

## Configuration

```env
MARKETPLACE_CONTRACT_ID=C...
```
