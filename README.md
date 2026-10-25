# GuardianCart

**Rosa's shopping and payment safety helper.** Rosa, 78, lives on her own and shops the way she always has. She and her daughter Priya agree on a few safety rules together. When something unusual happens on Rosa's card, a rule she co-signed pauses that one payment, and GuardianCart asks her one question: *"Is someone on the phone asking you to buy something?"* If her answer shows a scam, it tells her to hang up, keeps the money from moving, and Priya's phone turns red with the conversation. Everyday purchases never interrupt anyone.

> Rosa and Priya are fictional. All card activity is **SIMULATED** (not real Visa authorizations). The year of purchase history is labeled synthetic data.

## Run it

```bash
./start.sh                 # from the repo root: installs on first run, builds, serves on :8787
# or
cd app && npm install && npm start
```

| Who | URL |
|---|---|
| Start page | `http://localhost:8787/` |
| **Rosa** (tablet) | `http://localhost:8787/rosa` |
| **Priya** (phone) | `http://localhost:8787/family` (same Wi-Fi: `http://<laptop-ip>:8787/family`) |
| Card network stand-in (developer tool) | `http://localhost:8787/card-simulator` |
| Presentation mode (separate demo household) | `http://localhost:8787/stage` |

Add `?mute=1` to silence voice on a screen.

## Two modes, one application

- **Normal app** (`/rosa`, `/family`, household `home`): Rosa and Priya use it for real. Card events arrive through the transaction provider, so nobody presses demo buttons. Data persists in `app/data/home.json`.
- **Presentation mode** (`/stage`, household `stage`): split screen plus scenario triggers and Reset for the live pitch. It sends its scenarios through the **same** provider and pipeline into a separate household, so Reset never touches Rosa's real data.

### Sending card transactions (the simulated card network)

```bash
npm run txn -- --merchant "Safeway" --mcc 5411 --amount 46.18            # -> APPROVE (normal)
npm run txn -- --merchant "CVS Pharmacy" --mcc 5912 --amount 500         # -> DECLINE, paused, Rosa gets a check-in
npm run txn -- --merchant "QuickWire" --mcc 4829 --amount 900 --type funds_transfer --channel online   # -> blocked
curl -X POST localhost:8787/api/transactions -H 'content-type: application/json' \
  -d '{"transaction_id":"t-1","merchant":"CVS Pharmacy","merchant_category":"5912","amount":500,"channel":"in_store","transaction_type":"purchase"}'
```

Or use `/card-simulator`. Event fields: `transaction_id, card_id, merchant, merchant_category (MCC), amount, currency, timestamp, transaction_type (purchase | funds_transfer | quasi_cash | cash_withdrawal), channel (in_store | online)`. The card side never carries items. Duplicate `transaction_id`s are ignored.

`server/transactions.ts` defines `VisaTransactionProvider` with `SimulatedTransactionProvider` (in use) and `RealVisaTransactionProvider` (an honest placeholder that refuses to start). With Visa sandbox access, only the real provider needs implementing; the pipeline, policy engine and apps stay unchanged.

## How Rosa uses it

1. **First run:** she reads the rules Priya proposed, can change the check-in amount or turn rules on and off, chooses the scam-safety rule herself, and taps *I agree*.
2. **Home:** her status, recent purchases marked **Normal / Paused / Blocked** (tap one to see why), her usual stores and her usual list.
3. **When a payment pauses,** her tablet speaks the question right away with large captions. She answers by holding the mic, tapping *Yes, someone is on the phone* or *No, this was me*, or typing. She sees the outcome and when Priya was told, and can always ask *Why was this paused?* If it was her own purchase, she taps *Yes, this was me* and continues on her own (only when no scam signs and the rule allows it).
4. **My rules:** answer Priya's suggested changes, or suggest her own (it takes effect only when Priya agrees).
5. **Past check-ins:** every pause, what she said, the outcome, and when Priya was told and saw it.
6. **Messages from Priya** appear on her home screen with *I'm okay* / *Please call me* replies.

## How Priya uses it

1. **First run:** reviews and agrees to the proposed rules (the scam-safety rule is Mom's choice).
2. **Mom tab:** "Mom is doing fine" when nothing's wrong. No approvals and no pings for everyday purchases, only important unusual activity. While a check-in is in progress she sees a calm note, not an alarm.
3. **Urgent alert** only after the fixed rules block a payment or flag a scam: the screen turns red with *From the card* vs *From Mom*, why the helper was concerned, the rules that applied, the transcript and the timeline. She can **Call Mom** (simulated call) or **Message** Mom's tablet, then *Mark as handled*.
4. **Rules tab:** current rules, suggest a change, and see whether Mom agreed.
5. **History tab:** every previous incident with its full conversation.

## Configure sponsor services (all optional)

Copy `app/.env.example` to `app/.env`:

| Variable | Used for | Without it |
|---|---|---|
| `ANTHROPIC_API_KEY` | Claude writes the opening sentence (Haiku 5.5) and analyzes Rosa's answer: risk level, pattern, indicators, plain reason, summary for Priya (Sonnet 5.5) | Template sentence + deterministic scam-phrase classifier |
| `CARTESIA_API_KEY`, `CARTESIA_VOICE_ID` | Slow, calm Sonic TTS; Ink-Whisper push-to-talk STT | Browser speech / browser speech recognition; typing and quick replies always work |
| `MOSS_PROJECT_ID`, `MOSS_PROJECT_KEY` | Rosa's memory per household (Moss session): 191 synthetic purchases, per-store ranges, stores, recurring items, scam-script library, family rules, preferences, and incidents written back during use | Local in-process keyword memory with the same documents |

**Safety architecture:** Claude analyzes -> the deterministic policy engine (`shared/policy.ts`) decides -> the app performs the state change. Claude never approves, releases or blocks money; its output is a whitelisted risk signal that can only raise risk, and payment-status sentences are fixed code.

## What persists

`app/data/<household>.json` (atomic writes, never secrets): agreed rules and signatures, rule-change proposals and answers, transactions and their states, check-ins with transcripts and outcomes, family alerts and whether Priya handled them, messages and read state, the timeline, and memory write-backs (so later check-ins still remember earlier scam calls after a restart). A check-in interrupted mid-analysis goes back to waiting for Rosa's answer. Clear the real app's data with the server stopped: `npm run reset:home`.

## Tests

```bash
npm test          # 58 tests: policy, classifier, flows, Claude misbehaving, pipeline, provider swap, persistence, rule changes
npm run verify    # Playwright: the 15-step MVP check with a REAL server restart (own temp data dir and port 8791)
node scripts/screenshots.mjs   # presentation-mode flow on /stage (server running)
```

## Deploy

Single Node process. `docker build -t guardiancart app && docker run -p 8787:8787 -v $PWD/app/data:/app/data --env-file app/.env guardiancart`. There's no auth: one hard-coded demo family.
