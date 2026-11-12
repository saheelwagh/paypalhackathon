# Freelancer app alternatives

This document preserves the nine alternative product directions considered alongside **Freelancer Business Desk**, the selected idea. These are product proposals for later exploration; none is described here as built or verified.

The selected direction is documented in [Freelancer Business Desk build specification](./FREELANCER_BUSINESS_DESK_BUILD_SPEC.md) and [Freelancer Business Desk concepts](./FREELANCER_BUSINESS_DESK_CONCEPTS.md). The numbers below retain the original idea numbering, from 2 through 10.

## Shared product and stack assumptions

Each alternative is a complete freelance business application spanning client intent, agreed work, delivery, and money movement. Its agent should interpret changing requirements, inspect relevant records, propose alternatives, and coordinate approved actions. A voice interface alone does not make the workflow agentic.

The general stack across these proposals is:

| Layer | Intended role |
| --- | --- |
| Next.js, React, and TypeScript | Client-facing and freelancer-facing application experiences. |
| AG Grid and AG Studio | An inspectable decision workspace: related records, comparisons, linked filters, custom widgets, and agent-created views. |
| Backend agent tools | Authorized access to business records and application actions, with validation and an approval boundary for commercial commitments. |
| PostgreSQL | Persistent client, project, agreement, delivery, invoice, payment, and audit records. |
| Object storage | Audio recordings, uploaded source material, and deliverable assets where appropriate. |
| AssemblyAI | Speech-to-text for briefs, meetings, reviews, and dictated updates; text-to-speech for conversational replies. Its LLM Gateway is optional, and the reasoning model remains provider-neutral. |
| PayPal Agent Toolkit and REST APIs | Supported payment-related agent tools and documented APIs for actual payment operations. The Toolkit is not assumed to expose every API; direct REST integration covers the capabilities an app uses. |

For every concept, application code calculates amounts and validates permissions. The agent works from approved commercial terms and authoritative payment records. An invoice is a payment request, and a submitted payout is not proof of successful settlement. Incoming client payments and outgoing collaborator payments are separate operations, not escrow or automatic split settlement.

## 2. Software Freelancer Studio

**Audience:** Independent software developers who sell scoped builds, integrations, migrations, or maintenance work.

**Value:** Connect what a client asked for, what was agreed, what was delivered, and what should be billed, so scope changes do not disappear into messages.

**Core features**

- Discovery briefs, proposals, and versioned statements of work with explicit deliverables and acceptance criteria.
- A delivery workspace linking requirements, tasks, releases, review evidence, and client decisions.
- Change-request assessment that compares new requests with the approved scope and prepares priced alternatives.
- Milestone invoicing, payment status, outstanding balances, and an audit trail connecting each charge to approved work.
- Optional subcontractor assignments and approved settlement records for specialist work.

**Agent mission:** Help deliver the agreed software outcome within the freelancer's capacity and the client's budget. When a request arrives late, the agent traces its dependencies, distinguishes a defect from an enhancement using the recorded agreement, and proposes deferral, substitution, or an approved change order. The accepted choice changes both the delivery plan and the billing obligation.

**Stack fit:** AG Studio joins scope, delivery, approvals, and receivables in one workspace; the agent can construct a view of unpaid changes affecting a release. AssemblyAI turns discovery and review calls into source-linked requirements and decision records. PayPal supports client collections and refunds when appropriate, with separate approved subcontractor payouts if included. The shared stack stores software-specific requirement, release, acceptance, and change-order records.

## 3. Design and Branding Studio

**Audience:** Freelance brand designers, graphic designers, and small design practices delivering identity packages and campaigns.

**Value:** Preserve the connection between a creative brief, revision allowances, approved assets, and the commercial agreement.

**Core features**

- Structured creative briefs capturing audience, positioning, desired tone, references, and exclusions.
- Package proposals and a deliverable register covering identity assets, formats, variants, and usage requirements.
- Review rounds that connect client feedback to particular assets and distinguish unresolved decisions from new scope.
- Change-order and revision-budget management, including alternative ways to meet an expanded request.
- Deposit, milestone, and final-balance tracking alongside approved asset handoff.

**Agent mission:** Turn evolving creative feedback into a coherent delivery plan. If a logo project expands into packaging and social templates, the agent compares the new requirements with the original package, identifies reusable work, proposes alternative packages, and prepares an additional invoice only after the commercial change is approved.

**Stack fit:** AG Studio displays the asset matrix, feedback, revision status, approval history, and amounts due, with views showing which client decisions block delivery. AssemblyAI captures the nuance of spoken creative feedback and preserves the statements behind proposed changes. PayPal handles agreed collections and payment adjustments. The shared stack adds asset variants, review rounds, package definitions, and client approval records.

## 4. Content Production Studio

**Audience:** Freelance video producers, podcast producers, editors, and content teams delivering recurring or project-based media.

**Value:** Manage a production from spoken brief and source media through collaborators, revisions, delivery, and payment.

**Core features**

- Briefs and costed production proposals linked to scripts, episodes, or campaign deliverables.
- Shoot, recording, and editing coordination with crew assignments, equipment commitments, and dependencies.
- Media asset tracking and timestamped review feedback across deliverable versions.
- Revision and reshoot assessment against the agreed production scope.
- Client milestone collections, contributor obligations, and approved payouts with item-level status.

**Agent mission:** Keep a production deliverable feasible when the client, footage, or collaborators change. If a reshoot becomes necessary, the agent inspects the reason, existing terms, available crew, and dependent edits; it proposes schedule and budget alternatives and coordinates the approved financial change.

**Stack fit:** AG Studio connects shots or episodes, assets, crew, commitments, revision requests, and payment status. AssemblyAI transcribes source recordings and turns review sessions into timestamped requests attached to the relevant material. PayPal supports client payments and separate crew or editor settlement. The shared stack includes media versions, transcript references, production commitments, and contributor records.

## 5. Retainer Business Manager

**Audience:** Freelancers serving several clients through ongoing monthly packages, reserved capacity, or recurring deliverables.

**Value:** Make recurring revenue and recurring obligations understandable together, so a retainer does not quietly become unlimited work.

**Core features**

- A register of retainer terms, included services, capacity allowances, renewal dates, and client priorities.
- Intake and prioritization of incoming requests against the client's remaining allowance and the freelancer's availability.
- Delivery and consumption records showing the work associated with each billing period.
- Overage, carryover, upgrade, and renewal proposals based on approved contract rules.
- Recurring payment status, one-off adjustment invoices, collection exceptions, and account-level profitability views.

**Agent mission:** Maintain a workable service commitment across clients. When an urgent request exceeds a client's allowance, the agent compares deferral, replacement of lower-priority work, and a separately approved purchase of additional work. A failed recurring payment prompts an account review under the agreed terms rather than an invented contractual penalty.

**Stack fit:** AG Studio compares client demand, capacity, delivery, recurring revenue, and collection status across periods. AssemblyAI turns client check-in calls and dictated requests into a traceable intake queue. PayPal Subscriptions may support suitable fixed recurring arrangements; separately agreed adjustments use an appropriate additional payment request. The shared stack records retainer versions, billing periods, allowance consumption, and exceptions.

## 6. Independent Consulting Practice

**Audience:** Independent strategy, operations, research, marketing, and fractional leadership consultants.

**Value:** Connect conversations and recommendations to an agreed engagement, client decisions, delivery commitments, and fees.

**Core features**

- Discovery and diagnostic records that capture the client's problem, evidence, desired outcomes, and boundaries.
- Engagement proposals, deliverables, milestones, and explicitly assigned client responsibilities.
- Meeting decisions, action ownership, research evidence, and acceptance records.
- Scope and schedule changes, including optional specialist subcontracting.
- Milestone collections, expenses agreed with the client, and engagement profitability.

**Agent mission:** Keep a consulting engagement moving when new findings or delayed client decisions change the work. The agent identifies affected deliverables, compares a narrower outcome with additional discovery or specialist help, and prepares a revised commercial proposal. The client remains responsible for accepting any change in fees or commitments.

**Stack fit:** AG Studio joins engagements, outcomes, evidence, actions, dependencies, fees, and payment state; a useful agent-created view shows decisions delaying billable milestones. AssemblyAI makes discovery and working sessions searchable and connects proposed actions to the source discussion. PayPal handles agreed invoices or Checkout payments and any separately approved specialist payouts. The shared stack emphasizes engagement evidence, decisions, and outcomes rather than a software backlog.

## 7. Freelance Collective Manager

**Audience:** A small collective or lead freelancer who sells a package and coordinates several independent contributors.

**Value:** Run a shared client engagement without losing visibility into responsibilities, accepted work, client collections, and contributor obligations.

**Core features**

- A collective capability roster, availability view, and client proposal workspace.
- Assignment and delivery tracking across contributors, with explicit responsibilities and acceptance conditions.
- Versioned contributor compensation agreements using a bounded, supported set of payment terms.
- Client collection tracking alongside separate amounts owed, approved, pending, and settled for contributors.
- Replacement and change-order management when a contributor or client requirement changes.

**Agent mission:** Assemble and maintain a feasible delivery team. If a contributor becomes unavailable, the agent inspects unfinished work, handoff needs, client deadlines, replacement capacity, and approved compensation terms. It proposes a replacement plan with its client and contributor cost effects before commitments change.

**Stack fit:** AG Studio exposes contributors, deliverables, dependencies, compensation obligations, client receipts, and individual payout states. AssemblyAI captures briefing sessions and contributor handoffs as evidence for assignments and scope changes. PayPal collects from the client and separately pays approved contributors; it does not automatically split the original client transaction. The shared stack adds contribution agreements, handoff records, and settlement obligations.

## 8. Photography and Event Freelancer Studio

**Audience:** Freelance photographers, event videographers, and small crews working around fixed event dates.

**Value:** Coordinate the booking, event requirements, crew, delivery, and payments as one commercial job.

**Core features**

- Client consultation, package proposals, booking terms, and deposit tracking.
- Event requirements, shot lists, schedules, locations, crew assignments, and equipment needs.
- Proofing, selection, editing, and delivery records for the agreed package.
- Coverage extensions, rescheduling, package upgrades, and cancellation assessment under approved terms.
- Final-balance collection, approved adjustments, and second-shooter or editor settlement.

**Agent mission:** Preserve the agreed coverage when an event changes. If a client adds a second location or extends coverage, the agent checks timing, crew capacity, travel gaps, and package terms; it proposes an achievable adjustment and its price, then links the approved change to collection and contributor obligations.

**Stack fit:** AG Studio brings bookings, event requirements, crew commitments, selections, delivery status, and payments together. AssemblyAI turns consultations and spoken day-of updates into requirements and amendments, with their source context intact. PayPal supports deposit and balance collections, actual refunds where applicable, and separate contributor payouts. The shared stack includes event-specific booking, coverage, proofing, and fulfillment records.

## 9. Localization Studio

**Audience:** Freelance translators, transcribers, subtitle editors, voice artists, and localization collectives.

**Value:** Manage multilingual delivery from source material to approved outputs while preserving the commercial effect of source changes and contributor work.

**Core features**

- Audio, video, and document intake with source versions, transcripts, terminology, and style requirements.
- Asset and language assignments with specialist availability, deadlines, and reviewer responsibilities.
- Segment-level review, exceptions, approval, and delivery tracking.
- Change-impact analysis that separates reusable approved work from new or revised work.
- Client billing and approved contributor settlement based on recorded, agreed units of work.

**Agent mission:** Complete a multilingual release despite changing source material or capacity. When a new recording replaces part of the source, the agent identifies affected segments and languages, preserves reusable work, reallocates tasks, and proposes the incremental client charge and contributor obligations.

**Stack fit:** AG Studio provides an asset-by-language workspace with versions, segments, specialists, exceptions, deadlines, billable changes, and payout status. AssemblyAI speech recognition supplies source transcripts for supported audio and captures spoken terminology or pronunciation guidance; translation and review remain explicit parts of the broader workflow. PayPal supports client collections and separate contributor payments. The shared stack adds language, segment, glossary, source-version, and review records.

## 10. Creative Commission and Licensing Studio

**Audience:** Freelance illustrators, photographers, musicians, animators, and other creators selling commissioned work and rights to existing assets.

**Value:** Manage both the production of a creative asset and the commercial scope in which a client may use it.

**Core features**

- Commission briefs, proposals, creative milestones, and approval records.
- An asset catalog linked to license terms, clients, permitted uses, and existing commitments.
- Usage-scope assessment covering the supported dimensions of territory, duration, channels, and exclusivity.
- License-extension, renewal, and package proposals based on creator-approved pricing and terms.
- Commission and license payments, controlled delivery records, and any approved collaborator obligations.

**Agent mission:** Match a client's evolving intended use to an available creative package and approved licensing rules. If a one-campaign request expands into a year of advertising, the agent checks the original agreement and existing commitments, identifies conflicts, and proposes compatible alternatives and an approved additional charge. Ambiguous or unsupported terms remain subject to human review.

**Stack fit:** AG Studio displays an asset-by-client license matrix with permitted use, duration, exclusivity, renewal opportunities, collected amounts, and collaborator obligations. AssemblyAI turns creative-direction and licensing conversations into source-linked requirements. PayPal supports commission deposits, milestone collections, license purchases, and approved renewal payments. The shared stack adds asset rights, license versions, usage requests, and renewal records.

## Reference points

These documents explain the platform capabilities underlying the proposals. They do not establish that any complete product above has been implemented.

- [AG Studio Agent Framework](https://www.ag-grid.com/studio/react/ai/) — application-supplied models and tools for exploring data and modifying dashboards.
- [AG Studio custom widgets](https://www.ag-grid.com/studio/react/custom-widgets/) — domain-specific visual components for the shared workspace.
- [AssemblyAI voice-agent guide](https://www.assemblyai.com/blog/how-to-build-a-voice-agent-with-assemblyai) — speech recognition, language-model access, speech generation, and application-owned tool workflows.
- [PayPal Agent Toolkit](https://github.com/paypal/agent-toolkit) — supported PayPal capabilities exposed to agent applications.
- [PayPal Invoicing reference](https://developer.paypal.com/invoicing/reference/) — invoice lifecycle and the distinction between actual payments and records of external payments.
- [PayPal Payments API](https://developer.paypal.com/api/payments/v2/) — payment authorization, capture, and refund operations.
- [PayPal Payouts setup](https://developer.paypal.com/payouts/use-payouts/set-up/) — sandbox testing, production activation, and funding requirements for outgoing payouts.
- [PayPal Subscriptions](https://developer.paypal.com/platforms/subscriptions) — recurring payment arrangements for applicable retainer products.
