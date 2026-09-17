# HYROX Tracker

Personal HYROX training tracker. Plain HTML plus one Vercel function, no build step.

- `index.html`: the app (Train, Race, Calendar and Badges tabs)
- `api/data.js`: saves your log as one private JSON file in Vercel Blob (syncs across devices)
- `apple-touch-icon.png`: home screen icon

## Setup after deploying

1. **Storage > Create > Blob**, access **Private**, connect it to this project.
2. **Settings > Environment Variables**:
   - `APP_PASSCODE`: required. Axel's passcode. Can add, edit and delete every entry.
   - `NOE_PASSCODE`: Noé's passcode. Can add, edit and delete only Noé's entries, plus the doubles plan.
   - Anyone can view the log. Passcodes: letters, numbers and symbols only (no accents).
3. **Deployments > latest > Redeploy** so the new variables load.
4. Open the site, tap **Sign in**, enter your passcode, then Safari > Share > Add to Home Screen.
updated.
update 9.50pm
