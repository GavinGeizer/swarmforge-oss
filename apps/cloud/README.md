# @swarmforge/cloud-identity

Cloud account and tenant foundation for SwarmForge Phase2A.

## Features

- GitHub OAuth with PKCE (S256)
- Session management with CSRF protection
- Tenant/organization membership
- D1 database with atomic migrations
- Cloudflare Workers deployment

## Requirements

- Node 20+
- Wrangler CLI

## Local Development

### Environment Variables

Required environment variables for development:

| Variable | Description |
|----------|-------------|
| `DB` | D1 database binding |
| `APP_ORIGIN` | API origin URL |
| `WEBSITE_ORIGIN` | Trusted website origin |
| `GITHUB_CLIENT_ID` | GitHub OAuth client ID |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth client secret |
| `AUTH_SECRET` | Random 32+ char secret for HMAC |
| `ENVIRONMENT` | `local` or `preview` |

### Setup

```bash
# Install dependencies
bun install

# Run migrations
wrangler d1 migrations apply local-db --local

# Start development server
wrangler dev
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/ready` | Readiness check |
| POST | `/v1/auth/github` | Start GitHub OAuth |
| GET | `/v1/auth/github/callback` | OAuth callback |
| GET | `/v1/me` | Current user identity |
| GET | `/v1/me/personal-organization` | Personal org |
| GET | `/v1/session` | Current session info |
| GET | `/v1/sessions` | List user sessions |
| DELETE | `/v1/sessions/{id}` | Revoke session |
| POST | `/v1/auth/logout` | Logout |
| GET | `/v1/tenants/{id}` | Get tenant |
| PATCH | `/v1/tenants/{id}` | Update tenant |
| GET | `/v1/tenants/{id}/memberships` | List memberships |

## Security

### Authentication
- Session cookies: `__Host-swarmforge` (HttpOnly, Secure, SameSite=Lax)
- OAuth state: browser-bound, short-lived (10 min)
- GitHub PKCE: S256 code challenge

### Authorization
- Session rechecked on every request
- CSRF protection via HMAC tokens
- Origin validation on mutations
- Role-based: owner, admin, member

### Security Headers
- `Cache-Control: no-store`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: no-referrer`

## Testing

```bash
# Run tests
bun test
```

## Migrations

Run migrations:
```bash
wrangler d1 migrations apply local-db --local
```

## License

PolyForm Small Business 1.0.0
