# Module 1 Spec — "The system acts"
*The working document for Module 1. Everything proposed for this module lives here; anything not here is out of scope. You judge this document; CC builds against it; checks run against it. Draft v1 — awaiting Roei's rulings (marked ⚖️).*

---

## 1. The big picture — what exists, what's missing

Today's chain, in plain language:

```
Triage ranks the late loans          ✅ (S24, real lateness S26)
You approve the call list            ✅ (S25, identity from token)
Approval is recorded + visible       ✅ (S25/S27, history section)
Approved loans get marked "queued"   ✅ (S29, the flow-fired write)
                                     ─────────────
Something contacts those borrowers   ❌ ← MODULE 1
```

The gate exists; nothing walks through it. Module 1 builds the walker: a **caller agent** that picks up the queued loans and produces the outreach — with the model choosing its steps, but every real action executed by our code, and only on loans *you* approved.

## 2. What ships (the fence)

Four pieces, one CC run:

### A. The caller agent (`api/run-caller.js` — teller #9)
The second true agent, same skeleton as ask-AI, different powers.

- **Trigger:** a "Run caller" button in the browser (a human hand, not a cron — cron is a later module).
- **Its menu (tools the model may order):**
  - `get_queued_loans` — read: loans where queued_for_contact is true
  - `draft_outreach` — produce the email/call-script text for one loan
  - `record_contact` — **write:** save the draft + timestamp against the loan, and set the loan's queue flag back to false ("contacted, dequeued")
- **The loop:** identical shape to ask-AI — order → validate against the menu → execute → next lap. Lap cap: 15 (it may handle several loans; ask-AI's 5 is too tight). ⚖️ *Ruling: is 15 right?*
- **What "act" means in v1:** draft + record. No real emails leave the system — no email plumbing exists. The output is a written record of *what would have been sent*.

### B. Where the records go: a new `Contact` table
Columns: id, created_at, loan_id, draft_text, drafted_by (= "caller-agent"). Schema + RLS by **your hands** (rule 11 — the agent never touches Supabase).

### C. Making it visible (audit surfacing + UI column)
- **Contact history section** in the page, beside Approval history — same pattern: a button, a read teller (`get-contacts.js`, teller #10), rows of who/when/which loan.
- **"Queued" column** in the loan table — the S29 write finally visible on the page instead of only in Supabase.

### D. Rider A (the shelf, ruled in at S30)
formatWhen on the approve receipt · due_date field on the add-loan form · Approval-insert dedup · delete stale `netlify/functions` · untrack `settings.local.json`.

## 3. Must-survive invariants (guardrail 3 — the run doesn't launch without these)

1. **The model never holds a pen.** Every write is executed by harness code after validating the order — the model only *asks* (rule 12).
2. **The agent acts only on approved loans.** `get_queued_loans` reads the queue flag; there is no tool that reaches unqueued loans. The gate is the *only* path in.
3. **Every teller verifies the token first** (rule 5) — including both new ones.
4. **Writes are idempotent** (rule 16): `record_contact` *sets* the queue flag to false and *inserts* one contact row per order — and the harness refuses a second record_contact for the same loan within a run.
5. **Lap cap enforced, every lap logged** (rules 9, 15).
6. **No secrets move** (rules 1, 2): no new keys, nothing in browser code.
7. **Existing flows untouched:** login, add-loan, ask-AI, triage → approve must all still work — the integration check re-runs the full chain.

## 4. Success criteria (checks by Roei's hands, live)

1. Log in → triage → approve 2 loans → loan table shows both as Queued.
2. Click "Run caller" → within a minute, Contact history shows 2 new rows with real draft text naming the right borrowers.
3. The loan table now shows both loans **de-queued** (flag back to false).
4. Click "Run caller" **again** → zero new contact rows (nothing queued = nothing to do). The idempotency check.
5. Approval history unchanged by all of the above — the flight recorder only grows, never rewrites.
6. View Source: keys 0 times.

## 5. Out of scope (named so it can't creep)

Real email sending · cron/scheduled triggers · multi-tenant RLS · streaming · retrieval. Each has a later module.

## 6. Open rulings for Roei ⚖️

1. Lap cap 15 — right?
2. `record_contact` sets queue→false immediately on drafting. Alternative: keep a separate "contacted" flag and leave queue history intact. Simpler vs. richer — your call.
3. Contact table readable by any logged-in user (same as Approval) — confirm.
