#!/usr/bin/env node

/**
 * Diagnose and (optionally) reset an admin account on Documenso.
 *
 * Use cases :
 *   - "Je n'arrive pas à me connecter" → run with `--diagnose`
 *     pour voir l'état du compte (password présent, emailVerified,
 *     disabled, 2FA, dernier login) avant de toucher quoi que ce soit
 *   - Mot de passe oublié → run with `--reset-password '<new>'` pour
 *     réécrire le hash bcrypt directement en DB (l'utilisateur peut
 *     ensuite se connecter avec ce nouveau mot de passe)
 *
 * Pas d'effet de bord en mode diagnose. Rien n'est jamais supprimé.
 *
 * Usage :
 *   DATABASE_URL=… npx tsx scripts/admin-account-tool.ts \
 *     --email <addr> --diagnose
 *
 *   DATABASE_URL=… npx tsx scripts/admin-account-tool.ts \
 *     --email <addr> --reset-password 'NewPa$$w0rd!' [--unblock]
 *
 * --unblock : avec --reset-password, met aussi `disabled = false`,
 *             `emailVerified = now()`, et désactive le 2FA. À utiliser
 *             si le diagnose a montré que le compte est dans un état
 *             qui empêche le login en plus du mot de passe inconnu.
 */
import { hashSync as bcryptHashSync } from '@node-rs/bcrypt';
import { PrismaClient } from '@prisma/client';

// SALT_ROUNDS reproduit @documenso/lib/constants/auth (12 par défaut côté
// Documenso). La fonction utilitaire `hashSync` dans
// `packages/lib/server-only/auth/hash.ts` utilise la même constante.
const SALT_ROUNDS = 12;

interface CliArgs {
  email?: string;
  diagnose: boolean;
  resetPassword?: string;
  unblock: boolean;
}

const parseArgs = (): CliArgs => {
  const args = process.argv.slice(2);
  let email: string | undefined;
  let diagnose = false;
  let resetPassword: string | undefined;
  let unblock = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--email') email = args[++i];
    else if (a === '--diagnose') diagnose = true;
    else if (a === '--reset-password') resetPassword = args[++i];
    else if (a === '--unblock') unblock = true;
  }

  return { email, diagnose, resetPassword, unblock };
};

const main = async () => {
  const { email, diagnose, resetPassword, unblock } = parseArgs();

  if (!email) {
    console.error('✗ --email <addr> est requis.');
    console.error(
      "Usage: scripts/admin-account-tool.ts --email <addr> --diagnose | --reset-password '…'",
    );
    process.exit(1);
  }
  if (!diagnose && !resetPassword) {
    console.error('✗ --diagnose ou --reset-password est requis.');
    process.exit(1);
  }

  const prisma = new PrismaClient();

  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
    select: {
      id: true,
      email: true,
      name: true,
      password: true,
      emailVerified: true,
      disabled: true,
      twoFactorEnabled: true,
      roles: true,
      lastSignedIn: true,
      createdAt: true,
    },
  });

  if (!user) {
    console.error(`✗ Aucun utilisateur trouvé pour ${email}`);
    console.error('  → Vérifier la casse, ou lister les admins :');
    console.error('    SELECT email, roles FROM "User" WHERE \'ADMIN\' = ANY(roles);');
    await prisma.$disconnect();
    process.exit(1);
  }

  // --- Diagnose ---
  console.log(`\n--- État du compte ${user.email} ---`);
  console.log(`  id              : ${user.id}`);
  console.log(`  name            : ${user.name ?? '(none)'}`);
  console.log(`  roles           : ${user.roles.join(', ')}`);
  console.log(
    `  password set    : ${user.password ? 'YES' : '✗ NO (compte sans mdp — login email impossible)'}`,
  );
  console.log(
    `  emailVerified   : ${user.emailVerified ? user.emailVerified.toISOString() : '✗ null (login bloqué — UNVERIFIED_EMAIL)'}`,
  );
  console.log(
    `  disabled        : ${user.disabled ? '✗ TRUE (login bloqué — ACCOUNT_DISABLED)' : 'false'}`,
  );
  console.log(
    `  twoFactorEnabled: ${user.twoFactorEnabled ? '⚠ TRUE (besoin du code TOTP)' : 'false'}`,
  );
  console.log(`  lastSignedIn    : ${user.lastSignedIn.toISOString()}`);
  console.log(`  createdAt       : ${user.createdAt.toISOString()}`);

  // Surface les blocages actifs en clair
  const blockers: string[] = [];
  if (!user.password) blockers.push('pas de password set en DB');
  if (!user.emailVerified) blockers.push('email non vérifié');
  if (user.disabled) blockers.push('compte désactivé');
  if (user.twoFactorEnabled) blockers.push('2FA activé (besoin du TOTP en plus du mdp)');

  console.log(
    `\n  Blocage actifs  : ${blockers.length === 0 ? '(aucun — login devrait fonctionner avec le bon mdp)' : blockers.join(' • ')}`,
  );

  if (diagnose && !resetPassword) {
    await prisma.$disconnect();
    return;
  }

  // --- Reset password ---
  if (resetPassword) {
    if (resetPassword.length < 8) {
      console.error('\n✗ Le nouveau mot de passe doit faire au moins 8 caractères.');
      await prisma.$disconnect();
      process.exit(1);
    }

    console.log(`\n--- Reset password${unblock ? ' + unblock' : ''} ---`);
    const hash = bcryptHashSync(resetPassword, SALT_ROUNDS);

    const updateData: Record<string, unknown> = { password: hash };
    if (unblock) {
      updateData.disabled = false;
      updateData.emailVerified = new Date();
      updateData.twoFactorEnabled = false;
      // Ne pas toucher twoFactorSecret/twoFactorBackupCodes — si le 2FA
      // est ré-activé plus tard, autant ne pas perdre la config.
    }

    await prisma.user.update({
      where: { id: user.id },
      data: updateData,
    });

    console.log('✓ Password mis à jour en DB.');
    if (unblock) {
      console.log('✓ Compte unblock (disabled=false, emailVerified=now, 2FA off).');
    }
    console.log(`\nTu peux maintenant te connecter avec ${user.email} et le nouveau mot de passe.`);
  }

  await prisma.$disconnect();
};

main().catch(async (err) => {
  console.error('✗ Script failed:', err);
  process.exit(1);
});
