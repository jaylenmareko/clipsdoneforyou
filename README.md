# ClipsDoneForYou

ClipsDoneForYou is a self-serve clipping service for creators, live at clipsdoneforyou.com. A user signs up, connects a channel, and picks a source. The service finds the moments worth clipping, cuts them, and posts the finished clips for the user.

## What is in this repo

- `index.html` is the web app the user sees: sign up and log in, connect a channel, choose a source, review clips, and manage posting.
- `api/` holds the serverless endpoints behind the app:
  - Accounts and access: `signup.js`, `login.js`, `logout.js`, `me.js`
  - Product: `chat.js`, `clips.js`, `settings.js`, `status.js`
  - Billing and payouts: `checkout.js`, `connect.js`, `disconnect.js`, `webhook.js`
  - Files starting with an underscore are shared helpers used by the endpoints, not endpoints themselves.
- `package.json` defines the API package and its dependencies.

## Notes

This is the live product repo. The page and the `api/` endpoints work together, so changes here can affect clipsdoneforyou.com directly.
