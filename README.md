# lancepal

**Demo freeze — 13 November 2026.** This snapshot freezes the verified desktop build. Follow the [action-only demo checklist](docs/DEMO_CHECKLIST.md) for the presentation. Credentials and the local PayPal sandbox ledger are excluded from Git; PostgreSQL remains deferred.

A working local Demo of a freelancer’s commercial workspace: conversations → versioned agreement → funded work → accepted changes → delivery acceptance → collection. Built from `FREELANCER_BUSINESS_DESK_BUILD_SPEC.md`; the earlier CreatorSplit proposal is not the implementation backlog.

**lancepal is a dark retro work console built around actual AG Grid and AG Studio.** The primary screen starts with one commitment grid, three essential totals, and analog-inspired recorded-voice controls. Compare, collection context, evidence, saved layouts, provider options, and action details appear only when requested. Console / Funding / Records / Activity navigation separates daily work from occasional detail management.

The complete synthetic Demo remains independent of the separate PayPal sandbox project journey. The sandbox reference project collected **$300 deposit + $250 change + $700 final = $1,250** through PayPal checkout and verified webhooks, automatically updating project and obligation AG Grids. Fresh local test agreements and exact-version send reviews govern that flow; they are not authenticated client signatures.

**Funding now offers Nebius natural-language commands.** Speak or type a request such as “What has the client paid so far?” or “Get the next invoice ready for me.” AssemblyAI returns editable text; explicit Run asks Nebius for a bounded plan. Navigation and payment inspection open the requested view. Invoice preparation first shows the server-resolved project, obligation, version, and exact amount; a separate **Prepare sandbox draft** action uses a short-lived signed plan. Agreement, delivery acceptance, invoice approval, and sending remain separate reviews. Local fixed phrases remain an explicitly selected fallback. Current verification is recorded in [the implementation checkpoint](docs/IMPLEMENTATION_STATUS.md).

The live browser pass navigated by natural request and opened the reference project's three payment records. Authorized synthetic audio returned editable AssemblyAI text; explicit Run through Nebius produced a [49-cent deposit preview](docs/screenshots/funding-nebius-preview.png), with zero invoices until a separate Prepare. Canceling preserved zero; Prepare created only a local draft. Ambiguous names and prepare-and-send clarified without action, and [send review remained unchecked](docs/screenshots/funding-nebius-send-review.png). **187 tests, typecheck, production build, and 25 route checks pass.** Post-build reads preserve the original paid reference and one unsent 49-cent draft per rehearsal. A fresh production-browser Nebius request previewed the existing 49-cent obligation, and explicit Open original invoice reused its same reservation. No new PayPal invoice or payment was created. This supports one reviewed action at a time, not continuous dialogue; real microphone capture and streaming remain unverified.

The dock also implements deliberate Talk → **Stop & transcribe** with AssemblyAI → editable text → explicit **Run**. Selecting an audio command file transcribes it too. This is recorded-command transcription, not streaming STT. A direct provider-route smoke passed with temporary transcript deletion confirmed; the browser file-upload path separately returned an editable `universal-2` transcript for an authorized four-second synthetic AIFF recording without automatically running it. A separate explicit Run then used Nebius to apply the comparison view and requested-changes filter; see [the recorded-command result](docs/verification/desktop-voice-command.jpg). Real microphone capture remains unverified. Details are in [the checkpoint](docs/IMPLEMENTATION_STATUS.md). Desk provider routes and sandbox billing actions accept local same-origin requests only; the webhook callback has a separate bounded signed-notification path. No keys are needed for typed Demo mode. PostgreSQL remains deferred. A separate `/sandbox` flow uses PayPal Invoicing with server-held credentials; authenticated multi-user access, private storage, production jobs/outbox, and production payments remain unimplemented. [The approved 2:55 story](docs/DESKTOP_DEMO_STORY.md) protects a $250 scope change while preserving explicit client acceptance and pending/confirmed distinctions.

## Run

Requires Node.js 22.9 or later and npm. This checkout was verified with Node 26.8.1.

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:3000**. While the server runs, `npm run check:routes` smoke-checks the screen URLs and capability endpoint. Open `/workspace` for Desk; `/` and `/overview` also use the Desk surface. `/records` retains the underlying Demo record workflows. Open `/sandbox/projects` for deposit, change, and final collection with automatic project funding updates. `/sandbox` retains the separate PayPal invoice ledger and original provider receipts. `.env.local` is optional for Demo. Copy placeholders from `.env.example` when preparing integrations; never commit actual credentials. Merely setting a key does not enable Connected mode or establish verification.

```sh
npm test
npm run typecheck
npm run build
npm start
```

Stop the development server before building/starting production: both use `.next`. `npm start` uses the production build. No hosted deployment, account creation, external email, or hackathon submission is performed.

## Implemented behavior

- Dark lancepal Console / Funding / Records / Activity / Settings navigation, a compact instrument-style rail, on-demand record search, and a grid-first desktop view. Secondary details and controls live in disclosures or focused inspectors; mobile navigation remains available, but this iteration targets desktop. Dialogs show command failures within the review and preserve focus during updates.
- Client create/edit and relationship detail; projects for web design, design, writing, or consulting.
- Sample conversations, reviewed notes, uploaded audio metadata, session-local audio playback, deliberate microphone recording, speaker mapping, timestamp navigation, preserved original transcript, corrections, and reviewed constraints.
- Proposal editing/comparison, version-specific owner review and explicit simulated client agreement; immutable accepted scope and activation. Editors retain the version they opened and block stale saves after another tab changes the draft. New proposals/changes inherit their project's delivery target; discovery reads that project's actual recorded values.
- Projects with scope, milestones, delivery, files/links, changes, and finance tabs. Contextual drafts retain the selected project. Next steps open existing invoices and the completion receipt instead of proposing duplicate obligations; an accepted unpaid extra opens its invoice before delivery. Absent evidence has no broken source link.
- Included/extra/unclear scope reviews, valid source checks, draft alternatives, explicit clarification, owner/client agreement, and separate addition invoices.
- Deposit/change/final invoice preparation, exact decimal-text parsing into cents, matching cent-preserving table/detail display, exact send review, simulated payer, partial/pending/confirmed collection, event deduplication, uncertain send/reconciliation, PO corrections, and reviewed reminder records. Replayed approvals/payment snapshots preserve later delivery/funding state; final collection marks the final milestone paid.
- Collections grouped by their actual blocker, visible agent tool runs, and approval/activity history. Fully collected invoices do not trigger a reminder recommendation. Legacy scripted-run history remains available alongside commercial activity.
- Actual AG Studio is the home workspace. Its initial view is a single full-width commitment AG Grid. Focused views reveal scope/offer comparison, payment/delivery timeline, or a built-in financial grid with one row per project. Existing saved layouts remain available through explicit restore. They share selected-project context. Row selection links evidence, comparison, and timeline; double-clicking a change or choosing review opens contextual drawers, which reuse the existing proposal, change, source, invoice, delivery, and client-review flows. Four named report presets, explicit save/restore, undo/reset, and editable layout remain presentation-only. USD displays retain cents; selectors wait for readiness and built-in data sources refresh through the API.
- The analog-inspired command dock has a physical microphone control, recording-duration meter, reviewed text input, and explicit Run. Provider choice, file upload, shortcuts, and receipts are revealable. It accepts typed Demo or explicit live Nebius requests. Validated tools can inspect scoped synthetic records and select/filter/rearrange views or open a review. They cannot grant approval, issue an invoice, or change money. Their receipts appear in the dock; they are not persisted as Activity runs. The recorded-command AssemblyAI path limits audio to 30 seconds/8 MB, preserves review before Run, and reports best-effort provider-transcript cleanup.
- Funding defaults to **Nebius · natural language**, independent of Console’s simulated context. Only the request and minimized sandbox project/obligation data reach the model; recipient emails, full scope text, raw PayPal transaction evidence, credentials, and Demo records are excluded from server-supplied context. A strict tool allowlist and server lookup resolve targets. A draft preview expires after two minutes or a context change. Apply verifies its signature and frozen source without calling Nebius again, then uses the existing atomic agreement/funding/duplicate guards. Uncertain outcomes require inspecting the original project. Local rules are an explicit fallback, never a silent replacement for a failed model request.
- Versioned browser persistence with runtime validation, cross-tab reads, Web Locks when available, explicit sample/empty resets, and ten reproducible synthetic scenarios.
- A separate `/sandbox/projects` journey with baseline agreement, owner-reviewed changes, separate sandbox agreements, delivery acceptance, and deposit/change/final invoices. Actual project and obligation AG Grids derive funding from bound provider invoices; pending funds never unlock work, and refunds reopen funding shortfalls without erasing acceptance. `/sandbox` retains exact-cent draft editing, version-bound send review, safe payer links, and original-invoice reconciliation. Visible tabs reread the local ledger every three seconds while the webhook worker reconciles provider events. No Demo approval, simulated payment, or unrelated standalone invoice funds a sandbox project.

**PayPal sandbox verification before webhooks:** a separate USD $1.49 invoice was created, sent, paid through PayPal-hosted sandbox checkout, and refreshed in the app as `PAID` with 149 cents confirmed and zero due. The provider payment transaction was visible; a duplicate coverage attempt was rejected. Server restart and browser reload retained the ledger, and the actual AG Grid row reopened the same paid receipt. That checkpoint passed **107 tests**, typecheck, **23 routes**, and the production build. Earlier permission and account/region failures stayed visible without fake payment success. The later webhook checkpoint separately observed a signed payment event reconcile a new $1.49 sandbox invoice and update the AG Grid to paid automatically, without manual refresh or reload. See [the automatic-update capture](docs/verification/paypal-webhook-grid-paid.jpg) and [the checkpoint](docs/IMPLEMENTATION_STATUS.md) for exact evidence and limits. Earlier captures: [sandbox ledger](docs/verification/paypal-sandbox-ledger.jpg), [paid detail](docs/verification/paypal-sandbox-paid.jpg), and [payer success](docs/verification/paypal-sandbox-payer-paid.jpg).

**Desktop checkpoint before PayPal integration:** 82/82 tests, typecheck, final production build, 21/21 route checks, capability HTTP 200, and `git diff --check` passed. At 1280 × 720 with normal page scrolling, browser QA exercised actual Grid/Studio commands, linked evidence/review drawers, exact-version owner/client agreement, and the $250 addition from pending ($300 total confirmed) to paid ($550 confirmed, $700 unbilled). Continuing through delivery acceptance, the uncertain $700 final send reconciled the original invoice; collection and reload retained $1,250 agreed/invoiced/confirmed and reopened the same final receipt.

Browser checks also confirmed duplicate-billing rejection, recoverable exponent input with exact `$1,000.49` → `$300.15/$700.34` retry, stale-editor Save rejection, cancellation without accidental resubmission, explicit live retry, clearing both grid filter types, and named-layout save/undo/reload/report switching. The final console check returned no error/warning entries. Fresh captures: [pending](docs/verification/desktop-pending-addition.jpg), [addition funded](docs/verification/desktop-addition-funded.jpg), [recorded command](docs/verification/desktop-voice-command.jpg), and [completed desktop journey](docs/verification/desktop-completed-journey.jpg). Real microphone capture and fresh mobile checks remain outside this pass. See [the checkpoint](docs/IMPLEMENTATION_STATUS.md) for exact evidence; older screenshots below remain baseline-only.

## PayPal sandbox project funding

Open `/sandbox/projects` for the full financial journey in its own server ledger. The simulated Desk and its seeded approvals/payments stay separate.

1. Create a sandbox project with a buyer, reviewed scope, baseline amount, and deposit. Record agreement for that exact version using the explicit local sandbox review.
2. Prepare its deposit invoice. The server derives the amount and recipient; review and send from the existing invoice page, then pay through PayPal-hosted sandbox checkout.
3. Watch the project funding grid update from the verified collection. Add a change, explicitly approve its version, and separately record its sandbox agreement. Prepare/review/send/pay that change invoice.
4. Submit delivery only after the deposit and every agreed change are fully funded. Review and record acceptance of the exact delivery version.
5. Prepare the final invoice for **baseline minus deposit**, review/send/pay it, and watch the project reach complete only after verified collection.

For the reference amounts, the three invoices are **$300 deposit + $250 change + $700 final = $1,250**, with a $1,000 baseline. The change is not charged again in the final. Repeated preparation opens the same reserved invoice; pending funds block progression; a later refund reopens the funding shortfall. Invoice terms and payment authority cannot be supplied from Demo records or matching display names.

In Nebius mode, try **“Could you take me to the website project?”**, **“How much has the client paid me so far?”**, or **“Could you get the next invoice ready for this project?”**. Review the transcript before Run and the exact source/amount before Prepare. A preview expires after two minutes, a changed context, or a server restart; request a fresh preview instead of retrying an old one. The local-rule fallback retains **“show projects”**, **“inspect deposit invoice”**, and **“prepare change Custom hero animation invoice”**. Both paths require a selected current project for preparation and reject ambiguous targets. Local fixed phrases may require IDs for titles containing reserved words. Draft preparation never contacts PayPal; approval and sending remain separate exact-version reviews.

These are explicit local sandbox test decisions, not authenticated client approvals. The model still cannot approve agreements or send invoices. Project status is derived from bound provider invoice evidence and appears in actual AG Grid; the existing synthetic Studio stays independent. Keep the app and webhook runner active using the commands below. PostgreSQL remains for the end. See [the implementation checkpoint](docs/IMPLEMENTATION_STATUS.md) for verified results and limitations.

## PayPal sandbox invoices

Use the verified `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` already in ignored `.env.local`. The adapter fixes its API host to `https://api-m.sandbox.paypal.com` and requests the Invoicing OAuth scope; there is no production-host switch. The sandbox app must have its Invoicing feature enabled: successful OAuth alone does not prove invoice permission. The endpoint is restricted to same-origin loopback requests, so this is a local desktop integration, not public or multi-user authentication.

1. Open **PayPal sandbox** and create a new draft with a project reference, a unique billing item such as `deposit`, `animation-change`, or `final`, a sandbox recipient, description, and exact USD amount.
2. Review the current version, recipient, scope description, and amount; explicitly approve and send that sandbox version. Editing a local draft changes its version. Demo approvals and fake payment history do not authorize this operation.
3. Open the provider's sandbox payer page and use a separate test buyer account. Sending/opening an invoice is not payment. Email notifications are suppressed by the send adapter.
4. With the webhook runner active, return to `/sandbox` and watch the automatic ledger update. A verified notification queues an authenticated read of the original invoice; only supported PayPal transaction evidence can increase confirmed collection. Pending remains separate; external/manual payment entries are excluded. **Refresh PayPal status** remains a manual recovery action, and no button simulates settlement in this ledger.
5. If an operation is uncertain, reconcile the original invoice/reference. The app reserves billing coverage before calling PayPal and does not create a replacement invoice after an unknown result. A recovered provider draft requires a new explicit review/send.

Sandbox data is persisted under ignored `.local/paypal-sandbox/` with restrictive file permissions, atomic file replacement, and process locking. The ledger is namespaced by a hash of the merchant app ID; secrets are not persisted in it. Keep these files for reconciliation: deleting them does not delete PayPal invoices and loses local duplicate reservations and webhook receipts. This file repository can later be replaced through `SandboxRepository` without mixing it with Demo localStorage. It is single-host development persistence, not production authentication or a managed job service. The local sandbox project funding journey is implemented; authenticated client decisions, connected Studio funding views, and model-executed commercial operations remain separate future work. See [the current verification checkpoint](docs/IMPLEMENTATION_STATUS.md) for actual tested outcomes. API references: [create invoice](https://developer.paypal.com/api/invoicing/v2/invoices-create/), [send invoice](https://developer.paypal.com/api/invoicing/v2/invoices-send/), and [payment details](https://developer.paypal.com/api/invoicing/v2/definitions/payments).

### Automatic sandbox updates

Install `cloudflared` on your `PATH`. Keep the app and webhook runner running in separate terminals:

```sh
npm run dev -- --port 3002
```

```sh
npm run paypal:webhooks
```

The runner reads the existing ignored `.env.local`, binds a callback relay at `127.0.0.1:8787`, starts an ephemeral HTTPS tunnel, and registers that callback with the configured PayPal sandbox app. Only `POST /api/paypal-sandbox/webhook` is forwarded; the dashboard and billing mutation route remain local. If the app uses another port, pass `npm run paypal:webhooks -- --app-origin http://127.0.0.1:PORT`. `npm run paypal:webhooks -- --help` also describes using an existing tunnel to the relay with `--no-tunnel --url https://HOST/api/paypal-sandbox/webhook`.

PayPal signature verification happens before a receipt enters the persistent inbox. The runner stores its registration ID in that ledger; no manual `PAYPAL_WEBHOOK_ID` or `.env.local` edit is needed. Event IDs deduplicate redelivery; a worker claims receipts, retries failures, and rereads the original saved invoice. Event names and event amounts never directly mark an invoice paid. Unknown invoices are not imported. The `/sandbox` grid checks only the local ledger every three seconds while visible, catches up on focus, and displays listener health, last verified event, and reconciliation receipts. PayPal delivery may take longer than that interval. These browser checks do not call PayPal. Editing and exact-version review remain intact as background data changes.

The completed webhook increment passed **144 tests**, TypeScript, the production build, and **23 page-route checks**. Actual signed `CREATED` and `PAID` deliveries reconciled a fresh $1.49 sandbox invoice and changed AG Grid to paid without manual refresh. Setup reference: [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/). Provider contracts: [signature verification](https://developer.paypal.com/api/webhooks/v1/verify-webhook-signature-post), [webhook registration](https://developer.paypal.com/api/webhooks/v1/webhooks-post), and [invoice events](https://developer.paypal.com/api/invoicing/webhooks/).

Keep both terminals open for automatic reconciliation. Stop the runner with **Ctrl+C**: it attempts to remove only its own sandbox registration, marks its local listener inactive, and stops its tunnel. Cleanup failures are reported for manual review; an unexpected kill may leave a registration or lock behind. Already accepted inbox receipts survive a restart, but this local process is not an always-on production worker. Payments made while the listener/tunnel is stopped may need **Refresh PayPal status**: starting a new subscription does not backfill missed events. PostgreSQL remains deferred.

## Walk the reference journey

1. Open **Records → Conversations → A clearer picture of the launch**. Review the synthetic transcript, map speakers, and save “Monday delivery is fine” as the missing constraint.
2. Open **Records → Proposals → A considered launch**. Compare scopes, retain the $1,000 full proposal, then **Review & share**. The dialog shows the exact recipient, amount, purpose, and version.
3. **Open simulated client review**, intentionally accept that version, return to the proposal, and **Activate agreed scope**.
4. In **Records → Projects → Launch website**, **Continue the journey** prepares a $300 deposit invoice. Review/issue it, open the simulated payer, and confirm collection.
5. Open **Records → Change reviews → Add a custom hero animation**. Inspect source evidence, answer the question, retain $250, save a new version, and record owner approval. In the simulated client portal, explicitly accept that same version. The copy correction remains included at $0.
6. Prepare the separate $250 addition invoice. Issue it. First simulate **Payment pending**: collected remains $300. Later simulate **Payment confirmed**: collected becomes $550. The original deposit is unchanged.
7. Return to the project. Submit delivery evidence, visit the client portal, and deliberately accept that delivery version.
8. Prepare and issue the **$700 final** invoice. Confirm its simulated collection. The project reads **$1,250 agreed / $1,250 invoiced / $1,250 confirmed / $0 outstanding**. These are distinct measures, never summed.
9. Open **Desk**, choose Acme and a named report, and use a view tab or a labeled Demo command. Inspect the actual canvas, source excerpts, linked context, and invoice timeline. Save a layout, change it, undo, then switch reports and reopen the saved report. Layout operations never mutate money. Offer review is available before an extra is accepted; it saves a draft for later agreement rather than approving the extra.

The client portal is a **demo role preview**, not an authentication boundary. Never put real customer information in this browser-local workspace.

**Previous baseline verification:** before the desktop redesign, browser verification completed the fresh $1,250 journey, pending-delivery/duplicate blockers, reload and existing-final receipt, assistant timeout retry, uncertain-send reconciliation, PO correction, and transcript-preview recovery with preserved original text. Empty-workspace creation retained a $1,000.49 proposal with $300.15/$700.34 milestones. At 390px, Settings navigation and explicit v2 client acceptance worked. A two-tab stale editor blocked Save, and a named Studio layout survived command/undo/reload. That baseline automated suite passed **65/65**, including 11 Nebius boundary cases; typecheck, the final production build, and 20/20 route smoke checks plus the capability endpoint also passed. See [the verification checkpoint](docs/IMPLEMENTATION_STATUS.md), [completed journey](docs/verification/completed-journey.jpg), [Studio layout](docs/verification/studio-linked-workspace.jpg), and [stale editor](docs/verification/stale-editor-blocked.jpg) for evidence and limits.

## Reproduce exceptions

In **Settings**, select a scenario and explicitly replace the synthetic workspace. Seeded approvals and payments are marked as fixture history. Available scenarios include fresh discovery, funded deposit, paid-claim/provider-pending, missing PO, uncertain send, transcription failure, ambiguity, already-invoiced addition, accepted delivery, and completed $1,250 collection.

You can also enable **Simulate a lost provider response** in an invoice send review. The outcome becomes unknown and cannot be resent or paid until the original operation is reconciled. Repeated invoice coverage is rejected, including when the first invoice is still a draft.

The earlier scripted assistant had a labeled one-shot timeout/retry check. For the new command dock, verify cancellation, invalid live responses, timeout handling, and explicit retry separately; a failed live command must never be presented as successful Demo output. Typed Demo commands remain available without provider keys. See [the recording and manual QA checklist](docs/DEMO_SCRIPT.md) for repeatable steps and expected outcomes. A checklist entry is not evidence that its browser check has passed; completed checks belong in [the implementation checkpoint](docs/IMPLEMENTATION_STATUS.md).

## Data and licensing

Synthetic records use `demo_` IDs and localStorage key `business-desk:demo:v1`. Runtime validation accepts only empty or synthetic invoice provider references in saved snapshots. Browser Web Locks serialize updates across tabs where supported. Without Web Locks, cross-tab atomicity is not guaranteed; Connected concurrency must use database transactions and unique coverage constraints. Conversation Demo media uses in-memory object URLs and disappears on reload; that older conversation fixture flow does not call a provider. The Desk command dock explicitly uploads stopped recordings or selected audio files to AssemblyAI, returns editable text, and attempts to delete its temporary provider transcript. Audio is not placed in localStorage. Cleanup failure is reported; deletion is not guaranteed. Original text and timing metadata remain separate from corrected text. Browser clearing deletes demo data.

AG Grid uses Community features only. AG Studio is installed from the vendor’s npm package and runs locally in evaluation mode, with vendor licensing warnings/watermarks retained. Deployment requires the applicable license/trial. `NEXT_PUBLIC_AG_STUDIO_LICENSE_KEY` is an optional public license string, never a provider secret. No starter source was copied; therefore there is no adopted starter commit to attribute. Third-party package licenses still apply.

## Source map and next phase

- `src/lib/domain.ts`: entities, runtime persistence schema, money, approval and command invariants.
- `src/lib/demo-repository.ts`: synthetic persistence and concurrency boundary.
- `src/lib/agent.ts`, `src/lib/scenarios.ts`: labeled deterministic task plans and fixtures.
- `src/lib/desk-commands.ts`, `src/lib/server/desk-agent.ts`: bounded Demo/live view actions, scoped context, and validated model tool loop.
- `src/lib/server/nebius.ts`, `model-config.ts`, `scripts/check-model.ts`: Nebius adapter, dedicated-key configuration, and separate catalog/transport checks.
- `src/lib/server/assemblyai.ts`, `local-request.ts`, `src/app/api/desk-command/route.ts`, `voice-command/route.ts`: recorded-command transcription, local-request guards, and bounded provider routes.
- `src/lib/contracts.ts`: typed service/repository/dashboard contracts for the later connected implementations.
- `src/lib/sandbox-contract.ts`, `src/lib/server/paypal.ts`, `sandbox-service.ts`, `sandbox-repository.ts`, and `src/app/api/paypal-sandbox/route.ts`: separate sandbox terms, fixed-host provider, review/coverage state machine, replaceable server ledger, and local-only endpoint.
- `src/lib/sandbox-project-contract.ts`, `src/lib/server/sandbox-project-service.ts`, and `src/app/api/paypal-sandbox/projects/route.ts`: version-bound sandbox project decisions, immutable invoice bindings, server-derived obligations, and funding projections.
- `src/lib/server/paypal-webhook-provider.ts`, `sandbox-webhooks.ts`, `webhook-relay.ts`, `src/app/api/paypal-sandbox/webhook/route.ts`, and `scripts/paypal-webhooks.ts`: signature verification, persistent retry inbox, original-invoice reconciliation, and the owned local callback runner.
- `src/lib/sandbox-ledger-poll.ts`: serialized, visible-only local ledger reads with stale-response protection; it does not call a payment provider.
- `src/components/sandbox-projects.tsx`, `sandbox-projects.css`: desktop project funding/obligation Grids and the separate scope, change, delivery, and invoice-preparation journey.
- `src/components/sandbox.tsx`, `sandbox.css`: independent sandbox invoice Grid, review, payer link, project handoff, and reconciliation UI.
- `src/components/desk.tsx`, `pages.tsx`, `workspace.tsx`, `workspace-review.tsx`, `command-dock.tsx`: desktop shell, record workflows, actual Studio/Grid, contextual drawers, and text/voice controls.
- `src/app/api/capabilities/route.ts`: safe configuration inventory; it does not test external connectivity.
- `tests/`: focused domain, repository, and scripted-plan checks.
- `FREELANCER_BUSINESS_DESK_CONCEPTS.md`: synchronized learning guide and implementation inventory.
- `docs/IMPLEMENTATION_STATUS.md`: verification evidence and remaining Phase A–F gates.

**Current priority: PostgreSQL provisioning and integration are deferred until the end at the user's request.** Keep the synthetic Demo independently usable and verify sandbox transactions in their separate local server repository; missing database credentials do not block this work. The authenticated connected project mode remains unavailable.

The remaining connected implementation includes PostgreSQL/migrations, authenticated owner and scoped client sessions, private object storage, a production jobs/outbox service, a model loop authorized for commercial execution, recorded client-conversation evidence and streaming AssemblyAI STT, and authenticated/model-executed commerce with linked Studio funding views. The local sandbox deposit/change/final journey, project funding AG Grids, invoice ledger, and persistent webhook inbox/worker are implemented separately; their exact verification is recorded in the checkpoint. These are substantive remaining requirements, not features enabled by pasting keys. Separate adapter source or checks do not establish the full commercial flow or complete hackathon readiness.

## Selected model provider: Nebius Token Factory

The requested model provider is now **Nebius**, using its hosted Chat Completions endpoint at `https://api.tokenfactory.nebius.com/v1`. AssemblyAI remains the speech provider. PostgreSQL remains deferred and Demo business records stay synthetic.

```dotenv
LLM_PROVIDER=nebius
LLM_MODEL=Qwen/Qwen3-235B-A22B-Instruct-2507
NEBIUS_API_KEY=<Token Factory inference key, in ignored .env.local only>
```

The default model is a configurable candidate; `npm run model:check` checks whether the saved key can access that exact model in its catalog. A Nebius Cloud IAM credential is not a Token Factory inference key. Credits must belong to the account/project behind the inference key; application configuration cannot transfer credits between products or accounts.

`src/lib/server/nebius.ts` implements bounded, non-streaming Chat Completions and model listing with the dedicated `NEBIUS_API_KEY`. It supports registered function schemas, assistant tool-call IDs, tool-result messages, and provider context retained privately for the next turn. It rejects unregistered tools, duplicate call IDs, truncated/invalid responses, and explicit provider/network failures. The adapter does not execute tools itself. The new local-only desk route calls a separate validated planner restricted to presentation and review actions. Its same-origin loopback guard is not production authentication; financial authority remains unavailable. No generic/AssemblyAI key or mock response is substituted on provider failure.

```sh
npm run model:check
npm run model:smoke
```

The first command only reads the model catalog. The smoke command makes two bounded real generations with one synthetic read-only tool/result roundtrip and consumes a small amount of the selected Nebius account's available credits. It never sends an invoice or changes payment state. It logs request IDs, model, and usage, not the key, reasoning, or source conversations. The dock now offers a separate explicit live Nebius mode, while default Demo commands remain deterministic. That narrow view/review loop does not establish the full connected commerce loop.

Official references: [Nebius API](https://api.tokenfactory.nebius.com/docs), [Token Factory cookbook](https://github.com/nebius/token-factory-cookbook), and [agent protocol example](https://dev.nebius.com/cookbook/beam-reflection-token-factory).

Nebius setup verification: authenticated model catalog and a two-completion synthetic tool/result roundtrip succeeded on 12 November 2026 (337 tokens). Use automatic tool selection with project-scoped validated arguments; earlier forced empty-argument probes were truncated and rejected. Two later live Desk commands succeeded; commercial execution remains a separate build step. Details: `docs/IMPLEMENTATION_STATUS.md`.
