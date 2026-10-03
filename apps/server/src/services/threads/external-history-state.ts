import { eq } from "drizzle-orm";
import {
  getActiveStoredTurnId,
  queuedThreadMessages,
  type DbQueryConnection,
} from "@bb/db";
import type { Thread } from "@bb/domain";

export function isExternalHistoryThreadSettled(
  db: DbQueryConnection,
  thread: Pick<Thread, "id" | "status">,
): boolean {
  return (
    (thread.status === "idle" || thread.status === "error") &&
    getActiveStoredTurnId(db, thread.id) === null &&
    db
      .select({ id: queuedThreadMessages.id })
      .from(queuedThreadMessages)
      .where(eq(queuedThreadMessages.threadId, thread.id))
      .limit(1)
      .get() === undefined
  );
}
