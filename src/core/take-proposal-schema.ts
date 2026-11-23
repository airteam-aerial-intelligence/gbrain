/**
 * Schema the take-proposal review needs beyond the table propose_takes creates. Its own module so the notification
 * emitter (notifications/emit.ts) can read the review columns without importing take-proposals.ts (which emits).
 */
import type { BrainEngine } from './engine.ts';

/**
 * The review columns (`acted_via`, `decision_reason`). This fork adds them with idempotent DDL on first use instead
 * of a numbered schema migration: the migration runner applies versions above the recorded one, so a fork-only
 * version would make the brain skip upstream's migrations of the same or lower number after a later upgrade. Once
 * upstream carries the columns in a migration, this becomes a no-op.
 */
const reviewSchemaReady = new WeakSet<BrainEngine>();
export async function ensureProposalReviewColumns(engine: BrainEngine): Promise<void> {
  if (reviewSchemaReady.has(engine)) return;
  const present = await engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'take_proposals' AND column_name IN ('acted_via', 'decision_reason')`);
  if (Number(present[0]?.n ?? 0) < 2) {
    await engine.executeRaw('ALTER TABLE take_proposals ADD COLUMN IF NOT EXISTS acted_via TEXT');
    await engine.executeRaw('ALTER TABLE take_proposals ADD COLUMN IF NOT EXISTS decision_reason TEXT');
  }
  reviewSchemaReady.add(engine);
}
