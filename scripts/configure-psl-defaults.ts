#!/usr/bin/env node

/**
 * Configure Documenso defaults for the PSL Conferences org.
 *
 * Idempotent post-deploy script for the v2.9.1 upgrade. Sets:
 *   1. Organisation envelopeExpirationPeriod (default 30 days for all
 *      new envelopes — see ZEnvelopeExpirationPeriod)
 *   2. Organisation reminderSettings (auto-reminders 3d after send,
 *      then every 4d — gives reminders at ~3d / 7d / 11d / 15d…)
 *   3. Webhook subscription eventTriggers (adds the 5 new v2.9.1
 *      events on top of the ones already configured)
 *
 * Why a DB script and not API: Documenso's Organisation settings and
 * Webhook eventTriggers updates are tRPC-only (session-cookie auth),
 * not exposed via the v2 OpenAPI surface. An external API-key script
 * cannot reach them. Direct Prisma writes are stable enough for this
 * one-time post-deploy config and align with how the same fields are
 * mutated by Documenso's own admin UI under the hood.
 *
 * Usage:
 *   DATABASE_URL=… npx tsx scripts/configure-psl-defaults.ts
 *   DATABASE_URL=… npx tsx scripts/configure-psl-defaults.ts --dry-run
 *
 * The script reads `DATABASE_URL` from env (the same one Documenso
 * uses at runtime). Run it from the repo root after `npm install`
 * has been executed at least once (so @prisma/client is generated).
 *
 * Re-running is safe — every write is idempotent (the dry-run
 * preview shows the exact diff before committing).
 */
import { PrismaClient } from '@prisma/client';

const PSL_ORG_URL = process.env.PSL_ORG_URL ?? 'psl-conferences';
const DRY_RUN = process.argv.includes('--dry-run');

// --- Target configuration values --------------------------------

const TARGET_EXPIRATION_PERIOD = {
  unit: 'day' as const,
  amount: 30,
};

// reminderSettings model: { sendAfter, repeatEvery }. The first
// reminder fires `sendAfter` days after the send timestamp, then
// every `repeatEvery` days until signed/expired. With 3d + 4d the
// reminders land at ~3d, 7d, 11d, 15d — a reasonable approximation
// of the 3/7/14 cadence the issue asked for (Documenso's model
// doesn't allow non-uniform intervals).
const TARGET_REMINDER_SETTINGS = {
  sendAfter: { unit: 'day' as const, amount: 3 },
  repeatEvery: { unit: 'day' as const, amount: 4 },
};

// Five new events introduced upstream between v2.3.2 and v2.9.1.
// Already-active triggers are preserved — this script only ADDs
// the missing ones and never removes anything.
const REQUIRED_EVENT_TRIGGERS = [
  'DOCUMENT_SENT',
  'DOCUMENT_OPENED',
  'DOCUMENT_RECIPIENT_COMPLETED',
  'DOCUMENT_REMINDER_SENT',
  'RECIPIENT_EXPIRED',
] as const;

// ----------------------------------------------------------------

async function main() {
  const prisma = new PrismaClient();

  if (DRY_RUN) {
    console.log('### DRY-RUN — no changes will be persisted ###\n');
  }

  // Resolve the PSL organisation by url (slug) — that's how Documenso
  // identifies orgs externally and is more stable than guessing the id.
  const org = await prisma.organisation.findUnique({
    where: { url: PSL_ORG_URL },
    select: { id: true, name: true, organisationGlobalSettingsId: true },
  });
  if (!org) {
    console.error(`✗ Organisation introuvable (url=${PSL_ORG_URL}).`);
    console.error(`  Set PSL_ORG_URL env var to override the slug if it differs.`);
    process.exit(1);
  }
  console.log(`✓ Org found: ${org.name} (id=${org.id})`);

  // ---- 1. envelopeExpirationPeriod + 2. reminderSettings ------

  const settings = await prisma.organisationGlobalSettings.findUnique({
    where: { id: org.organisationGlobalSettingsId },
    select: {
      id: true,
      envelopeExpirationPeriod: true,
      reminderSettings: true,
    },
  });
  if (!settings) {
    console.error('✗ OrganisationGlobalSettings introuvable. Anomalie de schéma.');
    process.exit(1);
  }

  console.log('\n--- Organisation settings (current) ---');
  console.log('  envelopeExpirationPeriod:', JSON.stringify(settings.envelopeExpirationPeriod));
  console.log('  reminderSettings:        ', JSON.stringify(settings.reminderSettings));

  console.log('\n--- Organisation settings (target) ---');
  console.log('  envelopeExpirationPeriod:', JSON.stringify(TARGET_EXPIRATION_PERIOD));
  console.log('  reminderSettings:        ', JSON.stringify(TARGET_REMINDER_SETTINGS));

  if (!DRY_RUN) {
    await prisma.organisationGlobalSettings.update({
      where: { id: settings.id },
      data: {
        envelopeExpirationPeriod: TARGET_EXPIRATION_PERIOD,
        reminderSettings: TARGET_REMINDER_SETTINGS,
      },
    });
    console.log('✓ Organisation settings updated.');
  }

  // ---- 3. Webhook eventTriggers --------------------------------

  // Find webhooks attached to the PSL portal endpoint. There may be
  // several teams under the org — we update every webhook whose URL
  // points at the psl-backend webhook handler.
  const webhooks = await prisma.webhook.findMany({
    where: {
      team: { organisationId: org.id },
      webhookUrl: { contains: 'pslconferences.com' },
    },
    select: {
      id: true,
      webhookUrl: true,
      eventTriggers: true,
      enabled: true,
    },
  });

  if (webhooks.length === 0) {
    console.warn(
      "\n⚠ Aucun webhook trouvé pointant vers pslconferences.com — créer la subscription dans l'UI puis re-run.",
    );
  }

  for (const w of webhooks) {
    const current = new Set(w.eventTriggers);
    const missing = REQUIRED_EVENT_TRIGGERS.filter((e) => !current.has(e as never));

    console.log(`\n--- Webhook ${w.id} (${w.webhookUrl}) ---`);
    console.log('  current triggers:', [...current].join(', ') || '(none)');
    console.log('  enabled         :', w.enabled);

    if (missing.length === 0) {
      console.log('  ✓ All 5 v2.9.1 events already active — skip.');
      continue;
    }
    console.log('  + adding        :', missing.join(', '));

    if (!DRY_RUN) {
      await prisma.webhook.update({
        where: { id: w.id },
        data: {
          eventTriggers: [...current, ...missing] as never,
        },
      });
      console.log('  ✓ Webhook updated.');
    }
  }

  console.log(DRY_RUN ? '\n### DRY-RUN end ###' : '\n✓ All done.');
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('✗ Script failed:', err);
  process.exit(1);
});
