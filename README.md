# Knowledge Retriever

## Vercel frontend deployment

`vercel.json` publishes the existing static files in `knowledge/web` without a build
step. Connect this GitHub repository to Vercel to deploy updates automatically.
The episode catalog, video links, theme, and browser-local collections work in
this frontend deployment. AI answers, server history, and Google sign-in require
the Python backend described below; they are not deployed by this configuration.
Provider credentials must stay on that backend, never in the static frontend.

## AWS deployment with private Google accounts

The production entry point is `knowledge.public_server:create_app`, served by Uvicorn.
`python -m knowledge serve` remains the loopback-only local demo. AWS deployments default
to `PUBLIC_AUTH_MODE=google`. The branded `/sign-in` and `/sign-up` pages use the same
Google sign-in flow for new and returning users, without a separate application password.
Google account selection opens directly; the application does not send users through
Cognito's hosted form in this mode.

Add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` to the ignored project `.env`, using a
Google OAuth **Web application** client. Register the exact production redirect URI:

```
https://d34tjhbhxxm88k.cloudfront.net/auth/callback
```

For another deployment, replace the hostname with its `PUBLIC_BASE_URL`. Configure the
Google consent screen with the app name and intended audience. While the Google app is
in testing, only its configured test users can sign in. This server-side redirect flow
does not need a browser client secret or Google JavaScript SDK. Configuration follows
[Google's OpenID Connect documentation](https://developers.google.com/identity/openid-connect/openid-connect).
The deployer refuses incomplete credentials before changing runtime settings. Credentials
are uploaded to the existing AWS Secrets Manager secret, never bundled with the frontend.

The callback checks a single-use state, PKCE, nonce, Google's signature, issuer, audience,
expiry, and verified email. Account ownership uses the stable Google subject ID, never an
email match. Provider tokens and passwords are not stored. Cookies are secure and HttpOnly.
Every question, saved response, and collection belongs to its signed-in account. Knowing
another account's response URL does not grant access. Login and signup retain allowlisted
reader routes, including after cancellation or retry. Sign-out clears private open tabs
and ends this app's session without signing the user out of Google.

Old guest, local developer, and Cognito history are not automatically assigned to Google
accounts, even when email addresses match. The previous Cognito resources remain intact
for explicit `PUBLIC_AUTH_MODE=cognito` compatibility; they are not used by Google mode.
`PUBLIC_AUTH_MODE=guest` is an explicit optional mode with browser isolation for up to 30
days and no cross-device identity. Collections use revision checks to prevent conflicting
saves between tabs. Import and raw-search APIs remain unavailable publicly.

The deployment code provisions a dedicated VPC, one `t3.small` EC2 instance in Mumbai
by default, a retained encrypted 20 GiB data volume, CloudFront with a private VPC
origin and an AWS HTTPS hostname, and a Cognito user pool. No custom domain is needed.
The instance's public IPv4 is for outbound provider/management connections. Inbound
port 8000 admits only AWS's managed CloudFront origin-facing prefix list; SSH has no
inbound rule. CloudFront uses a private VPC-origin ENI, and the app verifies its secret
origin header and expected hostname. A VPC CIDR rule alone does not admit this traffic.
Provider keys stay in Secrets Manager and are loaded using a scoped instance role.

Install the tested Python 3.12 runtime and prepare a release without creating resources:

```bash
.venv/bin/python -m pip install -r requirements-production.txt
.venv/bin/python -m deployment.aws_deploy
```

This writes a credential-free release archive, its checksum and the CloudFormation
template into ignored `.deployment/`. It includes the original 50-video snapshot,
not response history, diagnostics, `.env`, AWS credentials or virtual environments.
Validate `.deployment/cloudformation.json` with `cfn-lint` before provisioning.

For the default `knowledge-reader` stack in Mumbai, a console administrator can create
a customer managed policy named `KnowledgeReaderDeploy` from
[`deployment/knowledge-reader-deploy-policy.json`](deployment/knowledge-reader-deploy-policy.json)
and attach it to the dedicated deployment user. In IAM, open **Policies → Create policy
→ JSON**, paste the file, review the console's validation results and save. Back in
the user wizard, choose **Attach policies directly**, refresh the list and select
`KnowledgeReaderDeploy`. This copy contains the verified deployment account ID ending
in `7065`. Different accounts, stack names or regions require a policy update. IAM
policy variables cannot replace the account portion of a resource ARN; use the actual
12-digit account ID there.

This is a privileged bootstrap policy, not a strict tenant isolation boundary.
EC2/Cognito provisioning in Mumbai and CloudFront provisioning are available through
CloudFormation; storage, secrets, logs and IAM resources use the deployment's name
prefixes, and shell installation requires the project's instance tags. The ability to
set inline policies on the runtime role remains powerful and must be trusted like
administrator access. Keep this credential limited to the deployment operator and
deactivate its key when it is no longer needed. The application uses its own instance
role and does not need the operator's key. The policy is prepared locally; IAM console
validation and actual account permissions still need to be checked before deployment.

Add AWS credentials to the project's ignored `.env` locally, preserving existing
provider settings. Do not paste real keys into chat or commit them:

```dotenv
AWS_ACCESS_KEY_ID=your_access_key_id
AWS_SECRET_ACCESS_KEY=your_secret_access_key
AWS_DEFAULT_REGION=ap-south-1
# Set AWS_SESSION_TOKEN only when using temporary credentials, with their matching token.
```

An explicit `--profile PROFILE_NAME` uses that AWS profile. Otherwise, a complete key
pair in the process environment takes precedence over `.env`, followed by the normal
AWS SDK credential chain when neither contains keys. Partial credentials fail rather
than mixing sources; temporary credentials must include their token in the same source.
`--region` overrides environment/`.env` region settings; the default is Mumbai.
The standard AWS CLI does not read this project's `.env`. Use the deployment command
to check credentials without packaging or creating resources, then deploy:

```bash
.venv/bin/python -m deployment.aws_deploy --check-aws
.venv/bin/python -m deployment.aws_deploy --deploy --region ap-south-1
# Add --profile PROFILE_NAME for a nondefault AWS profile.
```

The credential check verifies identity only; provisioning can still fail if the
account lacks a required deployment permission.

Both provider keys must already exist in the local environment or `.env`; the script
transfers only these application settings to this stack's Secrets Manager secret.
Nonempty provider keys/model settings in the project's `.env` take precedence over
inherited shell values, so replacing a rejected key locally updates the deployed key.
It never copies your AWS access keys to the server. AWS credits are subject to your
account's terms and do not automatically pay the separate OpenAI/Supermemory accounts.
Provisioning needs permissions for CloudFormation, EC2/VPC, IAM, CloudFront VPC origins,
Cognito, S3, Secrets Manager, Systems Manager, CloudWatch and Logs, including creation
of any required AWS service-linked roles. It creates a new named stack and refuses to
reuse an unrelated stack. Existing infrastructure changes require a reviewed change
set; rerunning an unchanged stack installs a new application release.

For an initial stack created with the older VPC-CIDR ingress rule, run
`.venv/bin/python -m deployment.repair_cloudfront --apply`. This narrowly scoped
migration creates and checks a CloudFormation change set, and refuses any changes
except one security-group ingress update without replacement. It preserves the
server, data volume and accounts. The deployment policy needs prefix-list discovery
and change-set permissions; the refreshed JSON includes both.

CloudFormation resources have explicit names matching the deployment policy's
prefixes; named IAM roles require `CAPABILITY_NAMED_IAM`. A failed first deployment
that reaches `ROLLBACK_COMPLETE` before creating any app instance or data volume can
be retried with `--deploy --recover-failed-stack`. This explicit recovery mode saves
the old resource inventory in `.deployment/failed-stack-resources.json`, disables
termination protection on that failed stack, removes its stack record and starts
again. It refuses healthy, unrelated or still-changing stacks and any stack that
created an app instance/data volume. Persistent resources must retain `DeletionPolicy:
Retain` and remain preserved. The policy includes `DeleteStack` and
`UpdateTerminationProtection` only for the default stack; these are privileged recovery
permissions. Retained resources from a failed attempt must be reviewed separately.

Deployments seed an empty data disk and preserve existing data on later releases.
Systemd restarts failed processes. Daily backups use SQLite's online backup API and
upload databases/captions/diagnostics to an encrypted, private S3 bucket with 35-day
backup retention. The installer creates and verifies the first backup before reporting
success. Logs exclude questions and authentication callback query strings, and are
retained in CloudWatch for 14 days. CloudWatch alarms report instance failures and
missing backups in the console; email/SNS notifications are not configured.

The default limits are two concurrent answers, one per browser session/account, 20
questions per browser session/account per UTC day, and 200 total per UTC day. Guest mode
also limits each connecting IP to 20 per UTC day, so clearing cookies does not reset the
allowance. People sharing a network share that limit. Only an HMAC of the address is stored
for usage accounting. New browser sessions are limited to 10 per IP per minute and 10,000
active sessions in total. Attempts count toward question limits,
including provider failures. These are request limits, not a guaranteed monetary cap.
Question limits can be adjusted in the runtime secret followed by a service restart.
Guest sessions expire after 30 days. Signed-in sessions expire after at most one hour;
signing in again restores the same account’s saved data. Google handles identity and
account recovery in Google mode. The optional legacy Cognito mode has separate email
sender limits. This is one instance in one availability zone, so backups
provide recovery, not automatic high availability. Do not increase Uvicorn workers or
add instances without coordinating admission limits and moving account storage to a
shared database.

Verify through the actual AWS hostname before announcing a launch: open two independent
browser profiles (or two accounts in Cognito mode); test inaccessible cross-session response IDs; save/reopen a
collection; ask both an off-topic and supported question; restart the service; check
that saved data survives; and restore a downloaded backup into an isolated directory.
Local tests use simulated Cognito/provider responses and cannot prove AWS permissions,
email delivery, instance bootstrap or the deployed network path work.

Operational commands through Systems Manager: `systemctl status knowledge-reader`,
`systemctl restart knowledge-reader`, and `systemctl start knowledge-reader-backup`.
Release paths and resource IDs are saved in `.deployment/aws-resources.json`. For a code
rollback, point `/opt/knowledge-reader/current` to the prior tested release and restart;
database schema compatibility must be checked before rolling back. Failed health checks
during installation restore the prior code symlink automatically when one exists.
Restore backups to a separate directory with a safe tar extraction mode and verify
database integrity before replacing live data with the service stopped. Never overwrite
the live data directory as part of an ordinary release. Stack termination protection
and retained data/bucket/user-pool resources prevent accidental deletion; retained
resources continue to incur charges until explicitly cleaned up.

## Figuring Out reader

The browser now opens an editorial discovery experience with real episodes from
the committed `INDEXED_VIDEOS.md` snapshot. It includes topic and title search,
episode playback, and named collections. The local demo uses browser local storage;
the deployed site saves collections through `/api/collections` into server-side SQLite,
scoped to the current guest session or signed-in account. Past questions come from
`/api/responses` and reopen their saved answer without another generation request.
In the deployed guest/account modes, collection changes refresh on reopening the
view, returning to the tab, and periodically while visible. Open tabs in the same
session receive change notifications. Bookmark state and counts update after a
successful save or removal; delayed reads cannot replace newer saves. The navigation
count is the number of collection folders, including empty folders. A bookmark saves
immediately to Watch later; its notification offers **Change collection**. Existing
bookmarks open the move dialog. Collection folders show clip/episode counts and support
rename, delete, and undo. Removing an item also offers undo. Collections and Past
questions have separate tabs. On desktop, the compact folder list sits beside its
contents; on mobile it sits above them. Rename/delete are in **Collection options**,
and **Backups** contains export/import. These menus support keyboard focus and Escape.
JSON export/import backs up folders, clips, descriptions,
and exact timestamps; imports are validated, merged, and deduplicated. Guest sessions
last up to 30 days, so use export to retain a copy or move saves to another browser.
The snapshot is a browsing catalog; it does not mark any video as searchable.
Original captions and provider configuration are still required for checked answers.

When connected, questions use `POST /api/ask/stream`. The server sends progress text
with allowlisted search/review/compose phases, short `detail` lines for each finished
step, then one final checked response, using newline-delimited JSON. Retrieved candidates
stay internal: detail lines carry the search phrasing derived from the question, counts,
and whether each clip was verified or set aside, never caption text or unchecked
summaries. Both servers publish only a detail line's phase and message, capped at 240
characters.

The answer view reads as a chat: the question appears as a message, and the reply,
its source clips, and a composer pinned to the bottom of the window follow in one
column at every width. While generating, the composer is hidden. A vertical reasoning
timeline follows real search, clip review, and answer preparation events. The running
step shows a thinking orb and its latest detail lines; finished steps collapse to a
check. Elapsed time never advances the steps or implies an estimated completion time.
After an answer, "How this answer was checked" reopens the full log. Saved answers
reopened from Past questions have no log. The orbs are the MIT-licensed
[thinking-orbs](https://github.com/Jakubantalik/thinking-orbs) 0.3.1 engine, vendored
unchanged as `knowledge/web/thinking-orbs.js` and drawn by the framework-free
`<thinking-orb>` element in `knowledge/web/orb.js`. They follow the page theme, pause
offscreen and in hidden tabs, and show a still frame when reduced motion is requested.
The form returns on success, failure, or cancellation. Cancel stops waiting and restores
the question for editing; it does not guarantee that a running provider call stops or
avoids its charge. A completed answer can still appear in Past questions. The homepage
keeps one question heading and search field, with the portrait and topic
links for browsing. Repeated explanations, suggested-question buttons, and
duplicate podcast links are omitted. It also ignores interim
excerpts from older servers. The final response uses the existing verification
pipeline and is saved to response history. The JSON `/api/ask` endpoint remains
available. A remote Supermemory search failure falls back to local keyword retrieval
when the original captions exist.

Disconnected, malformed, or failed requests show a retry action without leaving
unchecked clips on screen. A final answer releases the form immediately, even if
the connection stays open. Slow requests show an update after 30 seconds; the browser
stops waiting after five minutes and preserves any next-question draft. Disconnecting
does not cancel server generation: a completed response may still appear in history.
Provider calls share a 270-second server budget, so each call uses the time remaining
instead of starting a fresh full timeout. This is cooperative: it prevents subsequent
calls after expiry but cannot forcibly interrupt all local work or a continuously
active network connection. Catalog and history requests have a separate 15-second
browser timeout. Failed history pagination preserves loaded rows and retries the same
page; the video selector includes all pages of the ready catalog.

The answer view shows a short lead, supporting points with their own source references,
and a separate checked limitation. Older saved answers remain readable. Clip titles
describe the excerpt's topic and must pass source review; a rejected title is omitted
without hiding an otherwise verified summary. Titles reuse the existing summary and
review calls, with GPT-4.1-mini unchanged. Each clip has two playback actions:
**Play clip** plays the selected time range on this page; **Full video** opens the
complete episode on YouTube without clip timing parameters. Numbered answer references
play their matching clips directly and keep the saved-answer URL unchanged. The player
appears inside the selected clip on mobile and desktop. An ended clip shows **Replay clip**.
Original-caption disclosures, duplicate player
links, and raw JSON download links in question history are not shown. Original captions
remain available to the backend for evidence validation and stored response data.

Playback uses YouTube; individual videos may have embedding or availability
restrictions. **Play clip** passes both original caption
bounds to the embedded player: the start is rounded down and the end rounded up to
whole seconds. YouTube stops the excerpt at that end time. The official IFrame API
updates the playback status and adds an end-time guard after seeking. If that optional
script cannot load, the native bounded embed remains available. The iframe sends the embedding origin so YouTube can
identify the site even under the production page's `no-referrer` policy; it does not
send the page path, question or fragment. Collections are local to the browser,
while past questions remain in `data/responses.sqlite3`.

UI assets: `knowledge/web/index.html`, `reader.css`, `reader.js`, `catalog.json`.
Dark mode uses black and charcoal surfaces with off-white text and primary controls.
Light mode remains available, and the selected theme persists across visits.
Asset provenance is in `knowledge/web/MEDIA.md`. The previous browser script and
styles remain in the repository for the historical regression suite.

### Verify the reader

`npm run test:player` checks clip bounds, switching clips, replay, answer references,
full-video links, saved moments after reload, and the iframe's origin-only Referer in Chrome. All requests
are intercepted locally; it needs no running server and makes no paid requests.

With the local Python server running and Google Chrome installed:

```bash
npm ci
npm run test:reader
python -m unittest discover -s tests -p 'test_*.py'
```

Set `APP_URL` for a different local server URL or `CHROME_PATH` for another Chrome
executable. The browser check uses an isolated browser context, real catalog data,
and simulated provider responses; it never makes a paid answer request. Screenshots
are saved under `data/reader-check/`. The browser suite also exercises delayed chunks,
off-topic/no-match outcomes, clarification, failed checks, provider failures,
disconnects, malformed responses, split UTF-8, cancellation, timeouts, and recovery.
It checks core text contrast, touch controls, and overflow at 320, 390, 768, and 1440px
in both themes. These targeted checks are not a complete accessibility audit.
It also covers stale history responses, pagination retries, catalogs exceeding 50
videos, and recovery of valid collection entries alongside malformed entries.
`npm test` runs the earlier browser-script
regressions. Live answer accuracy and latency require the original dataset and keys.
`npm run test:accounts` checks the production account UI using simulated identity and
storage endpoints, including isolation, persistence, conflicts, failed saves, cross-tab
updates, rename/delete/undo, backup restoration, duplicate imports, and keyboard tabs.
Use `GUEST_MODE=1` to exercise the optional guest interface. Install
`requirements-production.txt` to run all Python tests including the public server.
`npm run test:auth` runs isolated browser fixtures for sign-in routes, responsive
layouts, signup/signin switching, retry routes, account changes, expired sessions, and
cross-tab sign-out during generation. Provider identities in these tests are simulated;
a real Google consent/callback check requires configured credentials and a test user.

### Run the frontend and backend separately

From the repository root, install the frontend development dependency once with
`npm install` (Node.js 22.12+ is supported). Start each process in its own terminal:

```bash
# Terminal 1 — backend API on http://127.0.0.1:8000
npm run dev:backend
```

```bash
# Terminal 2 — frontend on http://127.0.0.1:5173
npm run dev
```

Open **http://127.0.0.1:5173**. Vite serves the files in `knowledge/web/` and forwards
`/api` requests, including streamed answers, to the backend on port 8000. Keep both
terminals running for answers and history. Frontend browsing and browser collections
also work while the backend is stopped. Edit `knowledge/web/` and refresh the page to
see changes. `npm run dev:frontend` is an alias for the frontend command.

For a different backend port, start `.venv/bin/python -m knowledge serve --port 8001`
and then `BACKEND_URL=http://127.0.0.1:8001 npm run dev`. Provider and AWS credentials
belong in the repository's server-side `.env`; do not put them in `knowledge/web/` or
variables prefixed with `VITE_`. Browser collections are stored per origin, so those
saved on port 8000 do not automatically appear on port 5173.

The existing single-process command, `.venv/bin/python -m knowledge serve`, still
serves both the frontend and API on port 8000. Production deployment continues to
serve the app through the authenticated Python server; Vite is for local development.
With the archive and keys available, run
`npm run test:reader:live` for an opt-in browser check using one real question
and the configured paid providers. It supports guest sessions and checks the exact
streamed answer, every clip's bounds and full-video link, numbered references,
readability from 320 to 1440 pixels, and reopening history without another generation
request. Set `APP_URL` to check a deployed reader. The exact response and light/dark
screenshots are saved in `data/reader-live-check/`; pass a different output directory
after `--` to keep these artifacts elsewhere. YouTube frames are intercepted in this
content check; real playback and automatic stopping require a separate live check.

For live off-topic and clarification checks through the actual reader API, run
`.venv/bin/python tests/reader_offtopic_live.py --output data/offtopic-live/results.json`
with the server running. This makes nine paid-provider requests, including a relevant
control question, and saves exact stream events and outcome checks. Review the content
as well as the automatic checks. Use a new output path for a fresh run.
The command exits unsuccessfully if any requested case fails its outcome checks.

---

Find useful moments in Raj Shamani's indexed videos. Describe a question or situation
and get one concise reply based on the retrieved passages, followed by summaries of
useful video moments, their relevance and limitations, and timestamp links to watch.
Supported advice addresses the reader directly; missing facts and personal outcomes
are not filled in from general model knowledge.

For example: "What do the videos say about customer validation?" or "Where is work
stress discussed?" Suggestions distinguish direct discussion from related background.
Related excerpts can support a partial answer with a clear explanation of the gap.
When the retrieved excerpts cannot support a substantive answer, the reader shows a
no-match message with no recommendations. It does not force the nearest background
clip into an answer to an unrelated request, such as cooking instructions. Ambiguous
questions can receive a clarification. Generated answers, summaries, limitations,
clarifications, and interface messages are always in English, even when the question
uses or requests another language. Original transcript quotes remain unchanged in
the stored evidence used for validation. Caption interpretation and answer quality
still have limits.

## Run the knowledge base

The browser uses **YouTube captions + Supermemory retrieval + OpenAI video guidance**.
The default browser is a fixed **Raj Shamani** library. It lists only his already
indexed videos and lets readers ask across them or select one video. Channel handles,
video URLs, import actions, pending videos, and background indexing are disabled.
The existing 50-video collection is preserved; no re-indexing is required.

On macOS/Linux with Python 3.12+:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements-channels.txt
# First setup only: copy .env.example to .env, preserving any existing keys.
# Set SUPERMEMORY_API_KEY and OPENAI_API_KEY (optional OPENAI_CHAT_MODEL).
python -m knowledge serve
```

Open http://127.0.0.1:8000 and ask a question. Browse the video catalog or select an
indexed conversation in the question form. Recommendations show summaries, any
limitations, and **Play clip** / **Full video** controls. Descriptions and their checks use
`OPENAI_CHAT_MODEL=gpt-4.1-mini` by default, through OpenAI's Responses API.
Planning, passage summaries, answer synthesis, and evidence checks use this same model;
there is no automatic fallback to another provider or a more expensive model.
Requests use `temperature=0` and a 4,000-token output limit. Citation validation,
support checks, and abstention rules remain required; model output does not
guarantee correct caption interpretation.
See [the model specifications](https://developers.openai.com/api/docs/models/gpt-4.1-mini).

The root `.env` and `.env.example` contain only the caption reader's OpenAI,
Supermemory, guest/auth-mode, and AWS deployment settings. Historical transcription
and Groq experiments are opt-in tools; their credentials are not part of the reader
configuration. Supply their documented variables in the shell only when running them.
After changing the model, restart the local server. An existing AWS deployment keeps
its Secrets Manager settings until the updated release is deployed.
The OpenAI API account needs its own available quota; Supermemory credits are separate. FFmpeg, Deepgram, and local embeddings are unnecessary
for this caption-based browser.

The catalog and queue persist in `data/channels.sqlite3`. Original timed captions
persist under `data/supermemory-trial/timed-captions/`; Supermemory stores searchable
text with video IDs and revision metadata. This is retrieval-augmented generation
(RAG), with no application-managed graph database. Back up the entire data directory.
The reader does not adopt new trial documents or start an import worker. A fresh
checkout needs the existing local data directory and access to the corresponding
Supermemory container; credentials and runtime response history are not committed to Git.

This repository includes the read-only 50-video catalog and timed-caption snapshot
under `data/channels.sqlite3` and `data/supermemory-trial/timed-captions/`. These
files connect cloud retrieval results to video titles and timestamps. Runtime
response history, screenshots, and evaluation artifacts remain local.

Pending, failed, and unindexed videos are excluded from the reader catalog. There is no automatic paid audio
transcription fallback. Only provider-completed documents become searchable.
Caption timestamps are machine-generated segment boundaries, not verified audio
alignment. Answers still need evaluation; citation validation cannot guarantee
that the model interprets a quote correctly.

See [channel import details](CHANNEL_IMPORT.md), the earlier
[question-and-answer review](VIDEO_QA_REVIEW.md), and
[actual generated replies](VIDEO_QA_ACTUAL_ANSWERS.md).
The default demo remains local and single-user. The separate AWS production entry
point described above requires isolated signed-in accounts by default, with an optional guest mode.

## Retrieval and answer reliability

The reader combines Supermemory semantic search with keyword search over the existing
saved captions, using up to two query reformulations and relevance selection. It keeps
nearby transcript context and preserves canonical timestamp links. Each of up to six
passages is summarized without the user question. A malformed or incomplete summary
gets one source-only repair attempt and must still pass the original checks. A separate selection step sees the
question and these fixed summaries, then adds a relevance explanation and scope limit.
A separate review checks each proposed card against its own original excerpt and can
downgrade a direct match to related, or reject it. Up to three checked, nonredundant
moments are shown. A synthesis step combines their original passages into one concise
reply and checks every sentence against its own cited excerpts. Unsupported sentences
can be removed while keeping independently checked advice. A separate scope check
validates what the reply says the retrieved passages do not establish. Partial replies
name the missing part. One repair is allowed; if synthesis cannot be verified or its
provider fails, a clear failure message precedes the checked moments and offers retry.
The reader sets `allow_closest=False`: ranking can reject all candidates immediately,
avoiding unnecessary summary and synthesis requests for unrelated questions. Rejected
relevance or a writer finding no substantive answer produces a no-match outcome with
no cards. Missing original captions produce a data-availability error instead of a
misleading no-match result. The earlier closest
background fallback remains available to offline experiments and other library
callers. Search still includes a broader subject query and may retrieve nearby
candidates; retrieval alone does not qualify a clip for display. A no-match outcome
describes the retrieved excerpts, not an exhaustive check of the entire library.
See [the consolidated reply check](CONSOLIDATED_REPLY_REVIEW.md).
A model check can still miss semantic mistakes or overstate how useful a clip is.
See [the workflow and limits](CHANNEL_IMPORT.md).

The [15-question English system check](ENGLISH_15_QUERY_SYSTEM_CHECK.md) records the
earlier closest-content workflow: 11 substantive replies, 3 closest-content replies,
and 1 clarification, with no request errors. All displayed citations matched saved
captions, but assistant review found six responses needing quality revisions. The
report includes every exact reply, reference, limitation, and reproduction command.

The tester's 15 questions are in `tests/fixtures/direct_query_review.json`. Run the
opt-in paired evaluation with `.venv/bin/python tests/evaluate_direct_queries.py`.
It uses the configured OpenAI/Supermemory keys and incurs API usage, but never imports
videos. It compares the baseline at `fe4048a` against the revised pipeline and saves
full results locally in `data/accuracy-review/video_guide-results.json`. Existing results
are reused; use a new output filename for a fresh run. A verifier pass is not an
independent accuracy score; review claims and summaries against their original captions.
See [the measured results and remaining accuracy gaps](ACCURACY_IMPROVEMENTS.md).
The [new 15-question review](WIDE_QUERY_REVIEW.md) includes every recorded reply,
reference links, an assessment of the evidence, and prioritized improvements. Questions
with missing topics or unnamed options now ask for clarification before retrieval.
The earlier [response improvement report](RESPONSE_IMPROVEMENTS.md) preserves the same
15 questions and their exact before/after replies, reference summaries and timestamp links.
All development runs, including unsuccessful approaches, remain under `data/accuracy-review/`.
Normal app questions and replies continue to be saved in `data/responses.sqlite3` and can
be reopened through Saved responses without making another answer request.
The default evaluation strategy, `video_guide`, matches the reader. `isolated_statements`
preserves the previous direct-answer workflow; `isolated_summaries` is another experiment.
See [the video guide review](VIDEO_GUIDE_REVIEW.md) for saved questions and recommendations.

## Separate local transcription backend

The original CLI commands below use Deepgram and local hybrid retrieval. Their
database is separate from the channel browser. Use `serve --backend local` to open
that collection. The channel import implementation remains in `ChannelLibrary` for maintenance;
the default server uses `RajShamaniLibrary` and rejects import API requests.

Python 3.12+ and FFmpeg are required. From this directory on macOS/Linux:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements-app.txt
cp .env.example .env
```

On Windows, activate with `.venv\Scripts\Activate.ps1` in PowerShell and use
`Copy-Item .env.example .env` on first setup. Set `OPENAI_API_KEY` in `.env` and
supply `DEEPGRAM_API_KEY` in the shell environment for this optional transcription
backend. OpenAI is used for understanding questions and generating answers;
Groq transcription and pyannote are not required. The active caption reader does
not need transcription credentials. `HF_TOKEN` is only needed in the shell for
the separate original pyannote experiment below.

```bash
# Add one or several links. Each command processes the whole linked video.
python -m knowledge ingest "YOUTUBE_URL_1" "YOUTUBE_URL_2"

# Process every video listed in LINKS.md.
python -m knowledge ingest --links-file LINKS.md

# Open http://127.0.0.1:8000 for the browser interface.
# The Process videos button also ingests the links in LINKS.md.
python -m knowledge serve --backend local

# Inspect the collection and search original passages.
python -m knowledge sources
python -m knowledge search "customer validation before building features"

# Ask a question, optionally including English translations of the excerpts.
python -m knowledge ask "What do the videos say about customer validation?" --translate

# Structured output, also returned by POST /api/ask with {"question": "..."}.
python -m knowledge ask "Where do the videos discuss distractions?" --json
```

Ingestion downloads media, sends audio to Deepgram, and creates embeddings locally.
Questions send the question, source catalog, and retrieved transcript passages to OpenAI. These
provider calls use your accounts. The first nonempty ingestion/search loads the
public embedding model from Hugging Face; subsequent runs reuse its local cache.
`sources` and empty-collection queries need no API keys or model downloads.

The CLI is stateless: after a clarification, submit a question containing both the
original question and the missing detail. Every browser submission is an independent query containing only the current input.
After a clarification, rewrite the complete question with the missing detail; previous
questions and saved responses are never automatically added to a new request. Browser requests are now recorded in `data/responses.sqlite3` and
available under **Saved responses**, with View response and Download JSON controls.
Each record includes the question, selected video, final answer or safe error, exact
citation data, model, timestamp, and elapsed time. Recording starts with new requests;
earlier unsaved browser answers cannot be reconstructed. Reopening a saved response
does not call the model again. This is an answer archive, not conversation memory.

An answered result contains `points`, each with `text` and `citations`. Every citation
includes the video title, `source_id`, canonical `video_url`, timestamped `url`, precise
`start` and `end` seconds, readable `time_range`, original `quote`, and original word
positions. Other statuses are `needs_clarification`, `insufficient_evidence`, and
`invalid_evidence`, with empty `points`. This replaces the earlier advice-only `steps`
response shape. The browser displays the same data and can play the excerpt in place.

## Supermemory trial

The optional trial uses Supermemory's `taskType: "superrag"` and v4 search with
`searchMode: "documents"`. The live text control was retrievable through v4, while
v3 returned no matches for the same indexed content; `search --v3` remains available
for comparison.
It needs only `SUPERMEMORY_API_KEY` in `.env` and the lightweight dependencies below;
it does not download a local embedding model or require Deepgram/Groq.

```bash
python -m pip install -r requirements-supermemory.txt
python -m knowledge.supermemory check
python -m knowledge.supermemory add --links-file LINKS.md
python -m knowledge.supermemory status
python -m knowledge.supermemory search "What do the videos say about customer validation?"
```

The three URLs are submitted for Supermemory's own extraction. A `queued` response
only means accepted, not searchable. Run `status` again to inspect processing; `done`
means the provider reports indexing complete. Search returns the provider's excerpts,
not generated advice. Run `python -m knowledge.supermemory control` to submit/check
a small synthetic text control in a separate container, useful for distinguishing
general indexing delays from video-specific extraction problems.

Video trial documents are isolated under `knowledge-retriever-trial`; the control
uses `knowledge-retriever-trial-control`. Stable IDs and a local manifest avoid repeat
uploads. Raw extraction responses and the latest search are saved under
`data/supermemory-trial/`. Documents remain in the Supermemory account for inspection.

This direct-URL trial does not supply the channel browser's citations or insert unverified
provider excerpts into the timed transcript database. Timestamp-looking strings in
provider output are diagnostic only, not validated word alignment. Direct video
extraction must be evaluated before it can supply precise citations. Our existing
Deepgram pipeline and answer generation still need their own provider keys.

### Working caption-based trial

In the live trial, direct extraction of all three YouTube URLs failed. Downloading
their original automatic captions and uploading the transcript text succeeded:
all three caption documents reached `done`, and real questions returned passages.
The default browser now uses this caption retrieval approach, with a persistent
channel catalog and OpenAI answer generation. These commands remain useful for diagnostics.

```bash
# Needs yt-dlp as well as requirements-supermemory.txt. Downloads captions only.
python -m yt_dlp --skip-download --write-auto-subs --sub-langs '.*-orig' --sub-format json3 --write-info-json --paths data/supermemory-trial/captions --output '%(id)s.%(ext)s' 'YOUTUBE_URL'

# Upload all downloaded original caption files, retaining local timing records.
python -m knowledge.supermemory_captions upload
python -m knowledge.supermemory_captions status
python -m knowledge.supermemory_captions search "What do the videos say about sleep?"
python -m knowledge.supermemory_captions search "Why do professionals stop growing in their careers?" --video-id XwawXRaNfzM
```

Supermemory stores and searches the caption text, with stable segment markers.
The original text and times remain under `data/supermemory-trial/timed-captions/`.
Only complete retrieved segments matching the saved original text, video ID, and
revision produce citations. Partial segments, invented IDs, altered wording, and
stale revisions are rejected. Links are constructed from the saved caption times.
The `--video-id` option applies both a provider metadata filter and a local check.

These are automatic **caption-segment** timestamps, not verified word-level audio
alignment. This trial returns retrieved excerpts rather than generated answers.
It does not need Deepgram, Groq, or a local embedding model. OpenAI is needed
for the app's answer-generation pipeline; Deepgram remains useful when captions
are missing or when a separate transcription is required. This small trial establishes
working retrieval, not a full quality comparison with the local retrieval backend.

API references: [SuperRAG](https://supermemory.ai/docs/concepts/super-rag),
[add document](https://supermemory.ai/docs/api-reference/ingest/add-document), and
[document search](https://supermemory.ai/docs/api-reference/documents/search-documents).

## How evidence reaches an answer in the local transcription backend

1. **Capture:** Deepgram Nova-3 multilingual produces original words, confidence,
   timestamps, and anonymous speaker labels. Raw responses are retained.
2. **Index:** overlapping passages preserve nearby dialogue. Each word keeps its
   original episode-relative position and time. No English translation overwrites
   the original transcript.
3. **Retrieve:** multilingual E5 embeddings find related meaning across languages;
   SQLite full-text search contributes keyword matches. Rankings are combined.
   Query planning expands the question into related terms and can select explicitly
   named videos. Comparison/overview searches spread candidates across videos.
4. **Answer:** OpenAI assesses candidates and writes a direct reply in short paragraphs,
   preserving qualifications and differing perspectives. Each reference has a brief
   summary, with the unchanged original transcript available to expand in the browser.
5. **Cite:** the model selects stored passage IDs and word ranges. Python validates
   those ranges and constructs quotes, time ranges, and YouTube links from source
   data. Invented passage IDs and out-of-range citations are rejected.
6. **Check support:** a separate OpenAI call checks every answer paragraph and reference
   summary against its own cited original excerpts. Shared excerpts are sent once to
   reduce token usage. Missing, malformed, or negative checks withhold the answer.
7. **Translate:** optional English translations are cached separately from the
   original evidence. A translation failure still leaves the original answer usable.

YouTube links jump to the start of the cited excerpt, rounded down to a whole
second. Displayed start/end values retain transcript precision in JSON. Times
refer to the **linked video**, so a Short's timestamps are relative to that Short,
not an unknown full episode. Incoming `t` parameters do not crop ingestion.

The new code is in `knowledge/`. Episodes and raw responses are separated under
`data/sources/VIDEO_ID/`; the SQLite collection lives at `data/knowledge.sqlite3`.
Use `python -m knowledge --data-dir /path/to/collection ...` for another collection.
Generated data and model caches are excluded from Git.

API response caches include an audio hash and request settings. Re-running ingestion
reuses matching responses and skips unchanged embeddings; replacing an episode's
index happens in one database transaction. A failed replacement leaves its previous
searchable version intact. Source media remains on disk for review.

## Local transcription backend limits and validation

This is a local CLI and browser demo, with background ingestion in the server process.
There are no accounts or conversation memory. Browser response history is saved locally.
Keep the server running
while processing; restarting it loses job progress, but ingestion can reuse saved audio
and transcription responses. Ingestion, search, and answering share a runtime lock,
so questions may wait while a video is being processed.

Only individual YouTube video URLs are accepted; add multiple URLs to `LINKS.md`
or the ingest command. The browser also accepts individual links. Successful additions
remain in the database, but do not rewrite `LINKS.md`.
Some videos may require additional yt-dlp setup or may be unavailable to download.
Vector search scans the local collection, which is intended for an initial small
library rather than a large hosted service. Long model inputs can be truncated by
the embedding model; retrieval quality still needs evaluation on real Hindi-English
episodes and representative questions. Ordinary questions retrieve up to 12 passages;
overviews/comparisons retrieve up to 20. All indexed videos are searchable, but an
answer is based on retrieved excerpts, not an exhaustive analysis of every video.
The index captures speech, not information visible only in slides or video frames.

Citation validation proves that an excerpt and its timestamps exist in the retrieved
transcript. It does **not** prove that the model's interpretation is correct or that
ASR captured the audio perfectly. The additional support check is also model-based,
so it reduces unchecked claims without guaranteeing interpretation accuracy.
Human listening checks remain necessary, particularly
around negations, interjections, and speaker changes. No speaker names are inferred.
The backend reports machine transcripts and translations as unverified. A correction
workflow remains future work; translated excerpts are currently for display, not indexing.

Offline tests use synthetic transcripts, embeddings, and model responses. They test
source isolation, cache reuse, index replacement, retrieval wiring, clarification,
abstention, general Q&A, per-video search, cross-video citations, support-check rejection,
Hindi keyword handling, translation caching, and exact citation construction without
network access or API charges:

```bash
python -m unittest discover -s tests -v
# Optional browser-script checks with Node.js 18+ (no npm dependencies).
node --test tests/web_smoke.cjs
```

Provider integration references: [Deepgram diarization](https://developers.deepgram.com/docs/diarization/),
[OpenAI structured output](https://developers.openai.com/api/docs/guides/structured-outputs),
[multilingual E5 model](https://huggingface.co/intfloat/multilingual-e5-small),
and [yt-dlp embedding examples](https://github.com/yt-dlp/yt-dlp#embedding-examples).

## Original podcast transcript pilot

An experimental pipeline for building searchable podcast datasets with:

- Hindi-English transcription and word timestamps
- speaker diarization (who spoke when)
- speaker-attributed transcript exports
- raw result preservation for human review

The pilot compares three approaches:

1. Groq Whisper large-v3 for transcription plus local pyannote Community-1.
2. Groq Whisper large-v3 words aligned to Deepgram speaker timestamps.
3. Deepgram Nova-3 multilingual for both transcription and diarization.

The 45-second trial favored Deepgram alone. It finished in 6.63 seconds,
captured 135 words, and detected the brief opening speaker. Groq captured 123
words and missed that opening question. Deepgram also made one suspicious late
speaker switch, so human review remains required.

## Setup

Requirements:

- Python 3.12+
- FFmpeg on `PATH`
- Groq, Deepgram, and Hugging Face tokens as needed
- accepted access to `pyannote/speaker-diarization-community-1`

Create a virtual environment and install dependencies:

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env
```

Keep `.env` for the active reader. Supply the Groq, Deepgram, or Hugging Face
credentials needed by these historical pilot commands through the shell environment.
Never commit credentials.

## Groq and local speaker separation

```powershell
.venv\Scripts\python.exe run_test.py prepare --url "YOUTUBE_URL"
.venv\Scripts\python.exe run_test.py transcribe
.venv\Scripts\python.exe run_test.py diarize
.venv\Scripts\python.exe run_test.py merge
python export_speaker_review.py
```

The speaker model runs on CPU by default. A forced speaker count is available
only as a diagnostic:

```powershell
.venv\Scripts\python.exe run_test.py diarize --speakers 2
.venv\Scripts\python.exe run_test.py merge --speakers 2
python export_speaker_review.py --speakers 2
```

A forced count is an assumption, not evidence that the labels are correct.

## Deepgram

After audio preparation:

```powershell
.venv\Scripts\python.exe deepgram_test.py
```

This uses Nova-3 multilingual, the latest batch diarizer, word timestamps,
utterances, and smart formatting. It saves Deepgram's native transcript and a
diagnostic alignment of Groq words to Deepgram speaker timestamps.

For the pilot clip, Deepgram's native transcript was better than the combined
output because Groq omitted the opening question. The current direction is
Deepgram-first, with Groq retained as an optional check for uncertain passages.

## Data rules

- Store original wording, timestamps, confidence, and anonymous speaker labels.
- Add verified speaker names only after listening or matching a known voice.
- Keep a separate normalized English translation for search.
- Preserve raw provider responses so corrections remain auditable.
- Flag overlaps, short interjections, and uncertain speaker boundaries.
- Keep downloaded media and generated transcripts outside Git.

## Limitations

- Speaker labels are anonymous until verified.
- Short replies, cross-talk, music, and edited clips can cause false switches.
- Provider utterance labels may disagree with word-level labels.
- This pilot validates dataset capture; it is not yet a searchable knowledge base.

References:

- [Groq speech-to-text](https://console.groq.com/docs/speech-to-text)
- [Deepgram diarization](https://developers.deepgram.com/docs/diarization/)
- [Deepgram multilingual code switching](https://developers.deepgram.com/docs/multilingual-code-switching)
- [pyannote Community-1](https://huggingface.co/pyannote/speaker-diarization-community-1)
