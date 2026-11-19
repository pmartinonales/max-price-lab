// Builds /marketing_messages payloads from a template's components.
import type { SendMarketingRequest, TemplateComponent } from './d360';

export interface TemplateVariables {
  /** Variable names in order: "1", "2"… (positional) or "first_name"… (named). */
  header: string[];
  body: string[];
  named: boolean;
  /** Parts this demo can't fill (media headers, dynamic URL buttons…). */
  unsupported: string[];
}

const VAR = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

function varsIn(text: string | undefined): string[] {
  const names = [...(text ?? '').matchAll(VAR)].map((m) => m[1]);
  const unique = [...new Set(names)];
  // Positional variables are filled in numeric order.
  return unique.every((n) => /^\d+$/.test(n)) ? unique.sort((a, b) => Number(a) - Number(b)) : unique;
}

export function templateVariables(components: TemplateComponent[]): TemplateVariables {
  const find = (t: string) => components.find((c) => c.type?.toUpperCase() === t);
  const header = find('HEADER');
  const body = find('BODY');
  const unsupported: string[] = [];
  let headerVars: string[] = [];
  if (header) {
    const format = String(header.format ?? 'TEXT').toUpperCase();
    if (format === 'TEXT') headerVars = varsIn(header.text);
    else unsupported.push(`${format.toLowerCase()} header`);
  }
  const buttons = (find('BUTTONS')?.buttons ?? []) as { type?: string; url?: string }[];
  for (const b of buttons) {
    if (String(b.type).toUpperCase() === 'URL' && /\{\{/.test(b.url ?? '')) unsupported.push('dynamic URL button');
    if (['COPY_CODE', 'FLOW', 'CATALOG', 'MPM'].includes(String(b.type).toUpperCase())) unsupported.push(`${String(b.type).toLowerCase()} button`);
  }
  if (find('CAROUSEL')) unsupported.push('carousel');
  if (find('LIMITED_TIME_OFFER')) unsupported.push('limited-time offer');
  const bodyVars = varsIn(body?.text);
  const named = [...headerVars, ...bodyVars].some((n) => !/^\d+$/.test(n));
  return { header: headerVars, body: bodyVars, named, unsupported: [...new Set(unsupported)] };
}

export interface BuildOptions {
  templateName: string;
  language: string;
  vars: TemplateVariables;
  /** Values for header vars then body vars, in order. */
  values: string[];
  to: string;
  perMessageMultiplier?: number | null;
}

export function buildPayload(o: BuildOptions): SendMarketingRequest {
  const param = (name: string, text: string) =>
    o.vars.named ? { type: 'text', parameter_name: name, text } : { type: 'text', text };
  const headerValues = o.values.slice(0, o.vars.header.length);
  const bodyValues = o.values.slice(o.vars.header.length, o.vars.header.length + o.vars.body.length);
  const components: unknown[] = [];
  if (o.vars.header.length) components.push({ type: 'header', parameters: o.vars.header.map((n, i) => param(n, headerValues[i] ?? '')) });
  if (o.vars.body.length) components.push({ type: 'body', parameters: o.vars.body.map((n, i) => param(n, bodyValues[i] ?? '')) });

  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: o.to,
    type: 'template',
    template: {
      name: o.templateName,
      language: { code: o.language },
      ...(components.length ? { components } : {}),
    },
    ...(o.perMessageMultiplier ? { bid_spec: { per_message_bid_multiplier: o.perMessageMultiplier } } : {}),
  };
}
