# Spend Tracker

A weekly spending tracker: one HTML page, one Netlify Function, and Netlify Blobs for storage.

## Deploy
1. Push this folder to a Git repo and connect it in Netlify, or run `netlify deploy --prod` from this folder.
2. In Site settings → Environment variables, add:
   - `ADMIN_TOKEN`: a long random string (e.g. run `openssl rand -hex 24`). This is your password.
   - `ADMIN_NAME`: `Kyle`
3. Redeploy, then open `https://YOUR-SITE.netlify.app/?t=YOUR_ADMIN_TOKEN`.

## First-time setup (in the app → Settings)
1. Under **People**, add your wife and daughter.
2. Under **Budgets**, create the budgets (e.g. "Household $400/wk, week starts Sun") and check who can use each one.
3. Tap **Share link** next to each person and text it to them. To save it to the home screen: Share → Add to Home Screen.

## How it works
- Each person's link holds a private token, and the token decides which budgets they can see. You (admin) see everything.
- The weekly budget starts fresh on each budget's start day. Nothing rolls over.
- Rounding up is on by default. The budget subtracts the rounded amount, and the exact amount is kept as well.
- Everyone has their own quick picks. Tags added by the admin are shared; tags anyone else adds are private to them.
- Data is stored as `config` (people, budgets, tags, quick picks) plus one `entries/YYYY-MM` blob per month.
