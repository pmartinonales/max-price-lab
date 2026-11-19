// Send plans (checked recipients + template + values) and the throttled send job.
import { randomUUID } from 'node:crypto';
import type { DB } from './db';
import { D360Error, type D360Client, type SendMarketingRequest, type TemplateComponent } from './d360';
import { buildPayload, templateVariables, type TemplateVariables } from './payload';
import { parseRecipients, splitAB, type Recipient } from './recipients';

export interface TemplateInfo {
  id: string;
  name: string;
  language: string;
  status: string;
  hasMaxPrice: boolean;
  components: TemplateComponent[];
}

export interface SendPlan {
  id: string;
  createdAt: number;
  kind: 'template' | 'pair';
  pairId: string | null;
  arms: Partial<Record<'A' | 'B', TemplateInfo>>;
  /** For a single template, the one used. */
  template: TemplateInfo | null;
  vars: TemplateVariables;
  values: string[];
  perMessageMultiplier: number | null;
  recipients: Recipient[];
}

export interface SendJob {
  id: string;
  planId: string;
  total: number;
  done: number;
  ok: number;
  failed: number;
  finished: boolean;
  startedAt: string;
  finishedAt: string | null;
  ratePerSecond: number;
  errors: { masked: string; country: string | null; arm: string | null; error: string; api?: unknown }[];
}

const PLAN_TTL_MS = 60 * 60_000;
const plans = new Map<string, SendPlan>();
const jobs = new Map<string, SendJob>();

export function getPlan(id: string) {
  const p = plans.get(id);
  return p && Date.now() - p.createdAt < PLAN_TTL_MS ? p : undefined;
}
export const getJob = (id: string) => jobs.get(id);

export interface PlanInput {
  kind: 'template' | 'pair';
  pairId: string | null;
  arms: Partial<Record<'A' | 'B', TemplateInfo>>;
  template: TemplateInfo | null;
  numbers: string;
  values: string[];
  perMessageMultiplier: number | null;
  rng?: () => number;
}

export function createPlan(input: PlanInput): SendPlan {
  const ref = input.template ?? input.arms.A ?? input.arms.B;
  if (!ref) throw new Error('No template');
  const vars = templateVariables(ref.components);
  let recipients = parseRecipients(input.numbers);
  if (input.kind === 'pair') recipients = splitAB(recipients, input.rng);
  const plan: SendPlan = {
    id: randomUUID(),
    createdAt: Date.now(),
    kind: input.kind,
    pairId: input.pairId,
    arms: input.arms,
    template: input.template,
    vars,
    values: input.values,
    perMessageMultiplier: input.perMessageMultiplier,
    recipients,
  };
  plans.set(plan.id, plan);
  for (const [id, p] of plans) if (Date.now() - p.createdAt > PLAN_TTL_MS) plans.delete(id);
  return plan;
}

/** Recipient's own values override the shared ones, position by position. */
const valuesFor = (plan: SendPlan, r: Recipient) => plan.values.map((v, i) => r.vars[i] ?? v);

export function templateFor(plan: SendPlan, r: Recipient): TemplateInfo {
  return plan.kind === 'pair' ? plan.arms[r.arm!]! : plan.template!;
}

export function payloadsFor(plan: SendPlan): { recipient: Recipient; template: TemplateInfo; payload: SendMarketingRequest }[] {
  return plan.recipients
    .filter((r) => r.canSend)
    .map((r) => {
      const t = templateFor(plan, r);
      return {
        recipient: r,
        template: t,
        payload: buildPayload({
          templateName: t.name,
          language: t.language,
          vars: plan.vars,
          values: valuesFor(plan, r),
          to: r.to,
          perMessageMultiplier: plan.perMessageMultiplier,
        }),
      };
    });
}

/** Payload with the number masked, for showing in the UI. */
export function maskedPayload(p: SendMarketingRequest, masked: string): SendMarketingRequest {
  return { ...p, to: masked };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function startJob(db: DB, client: D360Client, plan: SendPlan, ratePerSecond: number): SendJob {
  const items = payloadsFor(plan);
  const job: SendJob = {
    id: randomUUID(),
    planId: plan.id,
    total: items.length,
    done: 0,
    ok: 0,
    failed: 0,
    finished: items.length === 0,
    startedAt: new Date().toISOString(),
    finishedAt: items.length === 0 ? new Date().toISOString() : null,
    ratePerSecond,
    errors: [],
  };
  jobs.set(job.id, job);
  plans.delete(plan.id); // a plan is sent once

  const insert = db.prepare(`
    INSERT OR REPLACE INTO messages (wamid, to_masked, country, template_id, template_name, arm, sent_at, send_response_json, per_message_multiplier)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const gap = 1000 / ratePerSecond;

  (async () => {
    for (const { recipient: r, template: t, payload } of items) {
      const started = Date.now();
      const arm = plan.kind === 'pair' ? (r.arm ?? null) : null;
      try {
        const res = await client.sendMarketing(payload);
        const wamid = res.messages?.[0]?.id;
        if (!wamid) throw new Error('No message id in the response');
        insert.run(wamid, r.masked, r.country, t.id, t.name, arm, new Date().toISOString(), JSON.stringify(res), plan.perMessageMultiplier);
        job.ok++;
      } catch (e) {
        const api = e instanceof D360Error ? { status: e.status, body: e.body } : undefined;
        const error = e instanceof Error ? e.message : String(e);
        insert.run(`failed:${randomUUID()}`, r.masked, r.country, t.id, t.name, arm, new Date().toISOString(), JSON.stringify({ error, api }), plan.perMessageMultiplier);
        job.failed++;
        if (job.errors.length < 50) job.errors.push({ masked: r.masked, country: r.country, arm, error, api });
      }
      job.done++;
      const wait = gap - (Date.now() - started);
      if (job.done < job.total && wait > 0) await sleep(wait);
    }
    job.finished = true;
    job.finishedAt = new Date().toISOString();
  })().catch((e) => {
    job.finished = true;
    job.finishedAt = new Date().toISOString();
    job.errors.push({ masked: '', country: null, arm: null, error: `Job stopped: ${(e as Error).message}` });
  });

  return job;
}
