# Blockplan Live Backend — Render deployment copy

This folder is adjusted for deployment as a Render Web Service. No secrets are included.

## Render setup

1. Put the contents of this folder at the root of a **private GitHub repository** (or connect a repo containing these files).
2. In Render, choose **New > Web Service** and connect that repository.
3. Use:
   - Runtime: Node
   - Build command: `npm install`
   - Start command: `npm start`
   - Health check path: `/health`
   - Instance type: Free for initial testing only (not suitable for reliable production use; free services may sleep/restart).
4. Add environment variables in Render (do not commit them into GitHub):
   - `HOST` = `0.0.0.0`
   - `NODE_ENV` = `production`
   - `DASHBOARD_PASSWORD` = a new unique password at least 16 chars long
   - `SESSION_SECRET` = 64 hex characters generated locally
   - `SERVER_TOKENS_JSON` = `{"my-server":"PASTE_A_SEPARATE_64_HEX_TOKEN_HERE"}`
5. Deploy. Open `https://YOUR-SERVICE.onrender.com/health`. Expected result: `{"ok":true}`.
6. Dashboard is at `https://YOUR-SERVICE.onrender.com/` and uses `DASHBOARD_PASSWORD`.

Render sets `PORT` itself; do not hard-code it. Binding to `0.0.0.0` is required by Render. Render provides HTTPS in front of the Node service.

## Generate independent secrets in PowerShell

Run this command twice; copy the first output to `SESSION_SECRET`, and the second output as the token value inside `SERVER_TOKENS_JSON`:

```powershell
([guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N'))
```

Use a separate long password for `DASHBOARD_PASSWORD`. Never share these values in chat or screenshots. If any token is exposed, replace it in both Render environment variables and the Minecraft config.

## Minecraft configuration

After the Render deploy succeeds, copy your service HTTPS URL and set the Fabric mod config in `config/blockplan-live.json` to:

```json
{
  "enabled": false,
  "endpoint": "https://YOUR-SERVICE.onrender.com/api/v1/snapshot",
  "serverId": "my-server",
  "token": "THE_SAME_TOKEN_USED_IN_SERVER_TOKENS_JSON",
  "intervalTicks": 10,
  "allowedPlayers": []
}
```

Keep `enabled` false and `allowedPlayers` empty until you have verified the backend health endpoint and stored the same token in both places. Then stop the Minecraft server and configure an explicit player opt-in before setting `enabled` to true. Only share player positions with their consent.

## Notes

- This backend stores snapshots only in memory. Restarting/sleeping clears current player positions.
- Render Free services may sleep when they receive no inbound traffic and can restart; use only for testing.
- The Fabric mod JAR must be built separately and already depends on Minecraft/Fabric runtime APIs.
