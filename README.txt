══════════════════════════════════════════════
  mybot — Your Own Real Sports Automation Bot
══════════════════════════════════════════════

REQUIREMENTS
  • Node.js installed (https://nodejs.org — download the LTS version)

HOW TO RUN LOCALLY
  1. Open Terminal (Mac) or Command Prompt (Windows)
  2. cd into this folder:
       cd /path/to/mybot
  3. Install packages (first time only):
       npm install
  4. Start the server:
       node server.js
  5. Open your browser and go to:
       http://localhost:3000

HOW TO CONNECT YOUR ACCOUNT
  Real Sports uses custom auth headers. You need 3 values from your browser's Network tab:

  1. Sign in at realapp.com
  2. Press F12 → Network tab
  3. Refresh the page
  4. Click any request going to web.realapp.com
  5. Open the "Request Headers" section and copy these 3 values:
       real-auth-info     (looks like: userId!deviceId!token)
       real-request-token (looks like: vznbpK043MZ90Qa9)
       real-device-uuid   (looks like: 0c94132c-25e2-4732-bab1-...)

  6. On the mybot page, click "Connect Account"
  7. Paste real-auth-info in the top field — the userId, deviceId,
     and token fields will fill automatically
  8. Paste real-request-token and real-device-uuid
  9. Click Connect

HOW TO DEPLOY TO RAILWAY (so it runs 24/7)
  Prerequisites: git + GitHub account + Railway account (railway.app)

  First time setup:
    1. cd into this folder
    2. git init && git checkout -b main
    3. echo "node_modules" > .gitignore
    4. git add . && git commit -m "initial mybot deploy"
    5. Create a new GitHub repo at github.com/new (name it mybot)
    6. git remote add origin https://github.com/YOURUSERNAME/mybot.git
    7. git push -u origin main
    8. At railway.app: New Project → Deploy from GitHub repo → pick mybot
    9. Railway auto-detects Node.js and deploys — copy the generated URL

  To redeploy after changes:
    1. git add server.js public/index.html
    2. git commit -m "update auth"
    3. git push
    (Railway auto-deploys on every push)

FEATURES
  • Prestige All   — auto-prestige all eligible cards
  • Global Offers  — mass-send offers on marketplace listings
  • Bulk Quicksell — quicksell cards by sport/rarity
  • Pack Feed      — live stream of pack openings
  • Marketplace    — auto-list your cards for sale
  • API Explorer   — test any RS API endpoint directly
  • Live Log       — real-time server activity log

ADDING YOUR OWN FEATURES
  server.js is organized so you can easily add new job types:

  1. Add a new job type in runJob() switch statement:
       case 'myjob': return runMyJob(session, config);

  2. Write the job function:
       async function runMyJob(session, config) {
         updateJob(session, 'myjob', { status: 'running', stats: {} });
         // Use rsCall() to hit any RS API:
         const cards = await rsCall(session, 'GET', '/collecting/cards?limit=100');
         // ... your logic here ...
         finishJob(session, 'myjob', stats, 'done');
       }

  3. Add a UI panel in public/index.html for your job

  Use the API Explorer tab to discover working endpoints
  before writing your job code.

FILE STRUCTURE
  server.js          — backend server (edit this to add features)
  public/index.html  — frontend UI (edit this to change the look)
  package.json       — dependencies
  node_modules/      — installed packages (don't touch)

NOTES
  • Real Sports auth uses real-auth-info, real-request-token, real-device-uuid headers
  • Your credentials stay in your browser session — not stored anywhere
  • The server auto-tries multiple endpoint formats for each job
  • If a job fails, check the Live Log for the exact RS API response
  • Keep the terminal window open while using the bot locally
