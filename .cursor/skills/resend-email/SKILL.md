---
name: resend-email
description: Sends transactional email via Resend for Amelia promise reminders and notifications. Use when implementing createReminder delivery, Resend domain setup, or email follow-ups from MongoDB-stored promises.
---

# Resend — promise reminders

## Setup

- Env: `RESEND_API_KEY` in `server/.env`
- Package: `resend` (root workspace)
- Verify sending domain before demo (DNS takes hours) — fallback: Resend onboarding sender

## Amelia flow

1. Jules says: "I promise I'll send Yan the venue photos tonight"
2. Lane B extracts promise → MongoDB `promises` collection
3. Lane B or D calls `createReminder(promiseId, fireAt)` from `MemoryApi`
4. Resend sends at `fire_at` (or immediately for demo)

```typescript
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY!);

await resend.emails.send({
  from: 'Amelia <onboarding@resend.dev>', // replace after domain verify
  to: ownerEmail,
  subject: 'Reminder: venue photos from Jules',
  text: promise.text,
});
```

## Contract surface

Lane D imports `createReminder` from Lane B's exported `MemoryApi` — never writes `reminders` collection directly.

## Demo tip

For 60s video: trigger a reminder manually via `/reminders` POST with `fire_at` 30 seconds ahead; show phone notification + email arriving.

## Do not

- Hardcode recipient email — derive from owner profile or env `OWNER_EMAIL`
- Commit API keys or verified domain secrets
