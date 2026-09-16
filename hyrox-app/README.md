# HYROX Tracker

Personal HYROX training tracker. Plain HTML plus one Vercel function, no build step.

- `index.html`: the app
- `api/data.js`: saves your log as one private JSON file in Vercel Blob (syncs across devices)
- `apple-touch-icon.png`: home screen icon

## Setup after deploying

1. **Storage > Create > Blob**, access **Private**, connect it to this project.
2. **Settings > Environment Variables**:
   - `APP_PASSCODE`: required. Protects your log.
3. **Deployments > latest > Redeploy** so the new variables load.
4. Open the site, enter your passcode once, then Safari > Share > Add to Home Screen.
updated.
update 9.50pm
