import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function fixMigration() {
  try {
    await prisma.$executeRawUnsafe(
      `DELETE FROM "_prisma_migrations" WHERE migration_name = '20251216170425_add_reward_amount_to_referrals'`
    );
    console.log('✅ Deleted failed migration from database');
  } catch (error) {
    console.error('Error deleting migration:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

fixMigration();
