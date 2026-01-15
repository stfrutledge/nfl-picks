# Odds API Proxy - Cloudflare Worker

This worker proxies requests to The Odds API, keeping your API key secret on the server side.

## Deployment Steps

### 1. Create a Cloudflare Account (if needed)
Go to https://dash.cloudflare.com and sign up (free tier is sufficient).

### 2. Create the Worker
1. In the dashboard, go to **Workers & Pages**
2. Click **Create Application**
3. Click **Create Worker**
4. Name it `odds-proxy` (or any name you prefer)
5. Click **Deploy** (we'll update the code next)

### 3. Add the Code
1. Click **Edit Code**
2. Delete all the default code
3. Copy and paste the contents of `odds-proxy.js`
4. Click **Deploy**

### 4. Add Your API Key
1. Go back to the Worker's page
2. Click **Settings** → **Variables**
3. Under **Environment Variables**, click **Add Variable**
4. Set:
   - **Variable name**: `ODDS_API_KEY`
   - **Value**: your API key from https://the-odds-api.com
5. Check **Encrypt** to keep it secret
6. Click **Save and Deploy**

### 5. Get Your Worker URL
Your worker URL will be:
```
https://odds-proxy.<your-subdomain>.workers.dev
```

For example: `https://odds-proxy.stfru.workers.dev`

### 6. Update the App
Update the `ODDS_PROXY_URL` in `app.js` with your worker URL.

## Testing

You can test the worker by visiting the URL directly in your browser. It should return JSON with NFL odds data.

## Rate Limits

Cloudflare Workers free tier: 100,000 requests/day
Your actual usage: ~5-10 requests/week

You'll never come close to the limit.

## Troubleshooting

**"API key not configured" error:**
- Make sure the environment variable is named exactly `ODDS_API_KEY`
- Check that you clicked "Save and Deploy" after adding the variable

**CORS errors:**
- The worker already includes CORS headers, so this shouldn't happen
- If it does, check the browser console for details

**Empty response:**
- Check if The Odds API has games available (off-season may return empty)
- Verify your API key is valid at https://the-odds-api.com
