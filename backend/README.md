# CC Secure Express Backend

This server replaces the WordPress backend and keeps Constant Contact credentials, tokens, and list IDs off the frontend.

## 1. Install

```bash
cd backend
npm install
```

## 2. Configure

Copy `.env.example` to `.env` and set values:

- `CC_CLIENT_ID`
- `CC_CLIENT_SECRET`
- `CC_INITIAL_REFRESH_TOKEN`
- `ADMIN_API_KEY` (required for admin list lookup endpoint)
- `FRONTEND_ORIGIN` (for local testing: `http://localhost:5500`)

Update `newsletter-map.json` with your key/label/list_id mapping.

## 3. Run

```bash
npm run dev
```

Server starts at `http://localhost:3001`.

## Endpoints

- `GET /cc/v1/newsletters`
- `POST /cc/v1/subscribe`
- `GET /cc/v1/admin/contact-lists` (requires `x-admin-key` header)

### Get live Constant Contact list IDs

```bash
curl -H "x-admin-key: YOUR_ADMIN_API_KEY" http://localhost:3001/cc/v1/admin/contact-lists
```

### Subscribe payload

```json
{
  "email": "user@example.com",
  "first_name": "Jane",
  "last_name": "Doe",
  "company_name": "Acme Co",
  "consent": true,
  "newsletter_keys": ["franchising", "sba"]
}
```

## Token persistence

Refreshed tokens are stored in `token-store.json` (created automatically).
