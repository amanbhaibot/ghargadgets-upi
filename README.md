# GharGadgets UPI bridge
Shopify manual payment "Pay by UPI" -> PayZapi (FamPay) pay link -> order auto-marked paid.

Env vars: SHOP, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET (or SHOPIFY_ADMIN_TOKEN), PAYZAPI_API_KEY, PAYZAPI_WEBHOOK_SECRET, PUBLIC_URL.

Endpoints: GET /pay/:shopifyOrderId?n=<order number>, GET /return/:orderId/:pzId, POST /webhooks/payzapi, GET /health.
