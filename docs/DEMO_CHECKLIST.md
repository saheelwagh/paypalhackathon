# lancepal demo checklist

Action steps only. Use the desktop interface and keep the distinction between **SIMULATED DEMO** and **PayPal sandbox** visible.

## Before the demo

- Open the running local app at [Console](http://127.0.0.1:3002/workspace), ideally at 1440 × 900 or larger. Close unrelated tabs and expanded inspectors.
- Keep the app and webhook listener running. In Funding, expand **SYNC / 3s** and check that the listener is active without a reconciliation error. The interval describes local ledger checks; PayPal events can arrive later.
- Check that Funding's **Command options → PROCESSOR** shows **Nebius · natural language** as available. Check AssemblyAI availability separately.
- Rehearse microphone recording once on the actual demo computer. Physical microphone capture has not yet been verified; audio-file transcription has. Keep a short non-sensitive recording available through **Command options → Audio command**, or type the request if audio is unavailable.
- Preserve the existing paid reference and rehearsal projects. Do not reset Demo data or delete the sandbox ledger.
- For a new-draft demonstration, create a uniquely named sandbox project before presenting: use the separate US Personal sandbox buyer, a $1.49 baseline, and a $0.49 deposit. Open **Review sandbox agreement**, inspect the terms, check the acknowledgment, then **Record sandbox agreement**. Leave its invoice unprepared.
- The existing **Natural voice rehearsal** already has one unsent $0.49 draft. Use it to demonstrate original-invoice reuse if you do not prepare a fresh project. It will show **Open original invoice**, not **Prepare sandbox draft**.
- The existing **Launch website · sandbox reference journey** is already complete. Its $300 deposit, $250 change, and $700 final were previously paid through PayPal sandbox. Treat these as recorded evidence, not new payments during this demo.

## Main walkthrough — about 5–7 minutes

1. **Start in Console.** Select a project with a scope request using the project selector. Show the single AG Grid register, three totals, and the **SIMULATED DEMO** label. Sort a column and use the commitment filter; keep record-management forms closed.
2. **Reveal only the needed context.** Select a change row, open **Compare**, then double-click the change to inspect its review drawer. Inspect the source evidence and versioned terms. Close the drawer and return to **Register**. Optionally visit **Collection** or **Totals** briefly to show the focused AG Studio views.
3. **Move to Funding.** Keep **Nebius · natural language** selected. Use the microphone to request navigation to the website reference project, stop recording, review or correct the AssemblyAI transcript, then press **RUN**. Use audio upload or typed input if needed. Submit one request at a time.
4. **Inspect actual sandbox payment evidence.** Request the selected project's payment details and press **RUN**. Show the three-invoice payment grid. Open a paid invoice and expand **Provider evidence & webhook receipt** to inspect its PayPal transaction and verified event. Return to the project: $1,250 collected, $0 unbilled, and a complete journey.
5. **Prepare a new invoice by natural request.** Open the fresh, agreed project from preflight. Record or type a request to prepare its next invoice, review the text, and press **RUN**. Inspect the $0.49 deposit preview, exact project, and source version. First choose **Cancel preview**; verify no invoice was created. Run the request again and explicitly choose **Prepare sandbox draft** within two minutes.
6. **Show the approval boundary.** On the resulting invoice, verify $0 confirmed collection and no provider payment evidence. Open **Review & send to sandbox**. Inspect the recipient, amount, coverage, and version. Leave the acknowledgment unchecked so **Approve & send** stays disabled, then cancel. The main walkthrough ends before a new PayPal send.
7. **Demonstrate duplicate prevention.** Return to the same project and request its next invoice again. Inspect the existing-obligation preview and choose **Open original invoice**. Verify it reopens the same $0.49 draft instead of creating another one.
8. **Finish on the funding grid.** Return to **Project funding**. Show the completed reference alongside the unsent rehearsal project, each with its own collected total. Collapse the inspector and command options.

If using the existing **Natural voice rehearsal** in step 5, skip the new-draft claim: inspect its $0.49 preview and use **Open original invoice**. Continue with the separate send review and original-invoice check.

## Optional: fresh deposit → change → final payment journey

Use this longer route when there is time for three PayPal checkouts and eventual webhook delivery. Use a new project, not the already completed reference or the $0.49 rehearsal draft.

1. In **Funding → New project**, enter a unique title, reviewed scope, the separate US Personal sandbox buyer, a **$1,000 baseline**, and **$300 deposit**. Save it.
2. Open **Open next step → Review sandbox agreement**. Inspect the exact version, acknowledge it, then **Record sandbox agreement**. This is a local test decision, not an authenticated client signature.
3. Request the next invoice through Nebius. Review the $300 deposit preview, then **Prepare sandbox draft**. On the invoice, use **Review & send to sandbox**, inspect the terms, explicitly acknowledge them, and choose **Approve & send $300.00**.
4. Choose **Open PayPal sandbox payer** and complete checkout with the separate Personal test buyer. Return to the visible Funding project and wait for verified collection. Inspect the deposit row and webhook receipt; do not manually refresh when demonstrating automatic updates.
5. Open the project inspector, select **Changes**, and **Add billable change** for a $250 animation addition. Save it, **Review change v1**, explicitly **Record owner approval**, then separately **Record sandbox agreement**.
6. Request the next invoice, inspect the $250 change preview, and prepare its draft. Explicitly review/send that invoice, pay through the sandbox payer page, then wait for the change row to become funded. Confirm $550 collected and $700 unbilled.
7. In **Delivery**, choose **Prepare delivery submission**, enter evidence, and **Submit delivery**. Separately choose **Review sandbox delivery acceptance**, inspect and acknowledge the version, then **Record sandbox acceptance**.
8. Request the next invoice, inspect the $700 final preview, and prepare its draft. Explicitly review/send, pay through sandbox checkout, and wait for verified final collection.
9. Return to the obligation grid: verify **$1,250 agreed**, **$1,250 collected**, **$0 unbilled**, and completion. Open **Evidence** to inspect all three original invoices and their collection records.

If an invoice is pending or an operation is uncertain, leave it unresolved and inspect the original operation. Pending does not fund work. A delayed webhook is not a successful update; use the existing completed reference as historical evidence if the live event does not arrive in time. Manual **Refresh PayPal status** is a recovery action, not an automatic-update demonstration.

## Short failure demonstrations — choose one or two

- **Missing agreement:** on a fresh unagreed project, request invoice preparation. Observe the agreement requirement and unchanged invoice count.
- **Unsafe compound action:** request invoice preparation and sending together. Observe clarification without approval or send, then use the separate review flow.
- **Ambiguous project:** request a rehearsal project without distinguishing the two names. Observe clarification; retry with the full unique project name.
- **Unfunded delivery:** on an unpaid project, inspect **Delivery**. Verify submission/final billing remain blocked. Do not fabricate a PayPal pending transaction to demonstrate this.
- **Duplicate obligation:** repeat preparation on the existing rehearsal draft. Reopen its original invoice and verify no second charge.

## Boundaries to retain

- Console data, approvals, and payment simulations stay separate from Funding's PayPal sandbox test funds.
- Voice supports recorded commands, editable transcription, and one reviewed action at a time. It does not provide streaming conversation or financial approval.
- New PayPal sends always require explicit review. Payment success comes from provider evidence, not checkout navigation or model output.
- PostgreSQL remains deferred. The working demonstration uses browser-local Demo state and a separate local sandbox ledger; cloning the source does not copy that private ledger or credentials.
