import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function fixMigration() {
  try {
    // Delete the failed migration record
    await prisma.$executeRawUnsafe(
      `DELETE FROM "_prisma_migrations" WHERE migration_name = '20251216200325_add_reward_amount'`
    );
    console.log('✅ Deleted failed migration record');

    // Mark it as completed
    await prisma.$executeRawUnsafe(
      `INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
       VALUES (gen_random_uuid(), 'skip', NOW(), '20251216200325_add_reward_amount', NULL, NULL, NOW(), 1)`
    );
    console.log('✅ Marked migration as completed');
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

fixMigration();
