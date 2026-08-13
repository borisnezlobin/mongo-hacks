/**
 * Email: draft only. Amelia never auto-sends.
 *
 * `draftEmail` is reachable from the agent loop. `sendDraft` is reachable ONLY
 * from the owner tapping send in the app — deliberately not a tool.
 *
 * Uses fetch rather than the pre-installed `resend` package: one HTTP call, no
 * version coupling, and nothing new added to the frozen dependency list.
 */

import type { Id, MemoryApi, Timestamp } from '../../shared/contracts';

export interface EmailDraft {
  draft_id: Id;
  to_person_id: Id;
  to_name: string | null;
  to_email: string | null;
  subject: string;
  body: string;
  created_at: Timestamp;
  sent_at: Timestamp | null;
}

const drafts = new Map<string, EmailDraft>();
let seq = 0;

export async function draftEmail(
  memory: MemoryApi,
  toPersonId: Id,
  subject: string,
  body: string,
): Promise<EmailDraft> {
  const person = await memory.getPerson(toPersonId).catch(() => null);
  const personId = person?._id ?? toPersonId;

  // The address comes from memory, never from the model — no invented recipients.
  const emailFact = await memory.resolveFactState(personId, 'email').catch(() => null);

  const draft: EmailDraft = {
    draft_id: `draft_${++seq}`,
    to_person_id: personId,
    to_name: person?.name ?? null,
    to_email: emailFact?.claim ?? null,
    subject,
    body,
    created_at: new Date().toISOString(),
    sent_at: null,
  };
  drafts.set(draft.draft_id, draft);
  return draft;
}

export function getDraft(draftId: string): EmailDraft | undefined {
  return drafts.get(draftId);
}

export function listDrafts(): EmailDraft[] {
  return [...drafts.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** Owner-initiated only. Never call this from a tool. */
export async function sendDraft(draftId: string): Promise<EmailDraft> {
  const draft = drafts.get(draftId);
  if (!draft) throw new Error(`No draft ${draftId}`);
  if (draft.sent_at) return draft;
  if (!draft.to_email) {
    throw new Error(`No email address on record for ${draft.to_name ?? draft.to_person_id}`);
  }

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!apiKey || !from) throw new Error('RESEND_API_KEY and RESEND_FROM must be set');

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from, to: [draft.to_email], subject: draft.subject, text: draft.body }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);

  draft.sent_at = new Date().toISOString();
  return draft;
}
