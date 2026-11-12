import { z } from 'zod';
import { fundingCommandActionSchema, fundingCommandContextSchema, fundingCommandResultSchema } from './funding-commands';

const selector = z.string().trim().min(1).max(150);
const section = z.enum(['funding', 'payments', 'deposit', 'change', 'final']);
const purpose = z.enum(['next', 'deposit', 'change', 'final']);
/** Model output contains selectors and intent only, never money, recipients, decisions, or payment state. */
export const fundingAgentIntentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('projects') }).strict(),
  z.object({ type: z.literal('project'), selector }).strict(),
  z.object({ type: z.literal('inspect'), section, projectSelector: selector.optional(), changeSelector: selector.optional(),
    invoiceId: z.string().regex(/^sbx_[a-f0-9-]{36}$/).optional() }).strict(),
  z.object({ type: z.literal('prepare'), purpose, projectSelector: selector.optional(), changeSelector: selector.optional() }).strict(),
  z.object({ type: z.literal('clarification') }).strict(),
]);
export type FundingAgentIntent = z.infer<typeof fundingAgentIntentSchema>;
export const fundingAgentRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('plan'), message: z.string().trim().min(1).max(1000), context: fundingCommandContextSchema }).strict(),
  z.object({ action: z.literal('apply'), token: z.string().min(20).max(5000), context: fundingCommandContextSchema }).strict(),
]);
export type FundingAgentRequest = z.infer<typeof fundingAgentRequestSchema>;
export const fundingInvoiceActionSchema = fundingCommandActionSchema.options[3];
const viewAction = z.union([fundingCommandActionSchema.options[0], fundingCommandActionSchema.options[1], fundingCommandActionSchema.options[2]]);
const common = { provider: z.literal('funding-nebius'), message: z.string().min(1).max(1000) };
export const fundingAgentResponseSchema = z.discriminatedUnion('kind', [
  z.object({ ...common, kind: z.literal('clarification') }).strict(),
  z.object({ ...common, kind: z.literal('view'), action: viewAction, context: fundingCommandContextSchema }).strict(),
  z.object({ ...common, kind: z.literal('draft-preview'), action: fundingInvoiceActionSchema, context: fundingCommandContextSchema,
    token: z.string().min(20).max(5000), expiresAt: z.iso.datetime(),
    preview: z.object({ projectTitle: z.string().min(1).max(100), sourceTitle: z.string().min(1).max(100), amountCents: z.number().int().min(1).max(99_999_999), currency: z.literal('USD'), existing: z.boolean() }).strict(),
  }).strict(),
  z.object({ ...common, kind: z.literal('draft-prepared'), action: fundingInvoiceActionSchema, context: fundingCommandContextSchema,
    preparation: z.object({ invoiceId: z.string().regex(/^sbx_[a-f0-9-]{36}$/), existing: z.boolean() }).strict(),
  }).strict(),
]).superRefine((value, ctx) => {
  if (value.kind === 'clarification') return;
  const checked = fundingCommandResultSchema.safeParse({ provider: 'funding-local', message: value.message, action: value.action, context: value.context,
    ...(value.kind === 'draft-prepared' ? { preparation: value.preparation } : {}) });
  if (!checked.success) ctx.addIssue({ code: 'custom', message: 'The Funding proposal does not match its source context.' });
  if (value.kind === 'draft-preview' && (value.preview.amountCents !== value.action.amountCents || value.preview.existing !== !!value.action.invoiceId)) ctx.addIssue({ code: 'custom', message: 'The preview must describe the exact resolved invoice.' });
});
export type FundingAgentResponse = z.infer<typeof fundingAgentResponseSchema>;
