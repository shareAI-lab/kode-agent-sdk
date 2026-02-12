// ---------------------------------------------------------------------------
// TAU benchmark evaluator — DB state comparison + pass^k calculation
// ---------------------------------------------------------------------------

/**
 * Compare the final database state against expected changes.
 *
 * `expectedDb` is a partial DB snapshot: for each table, an array of objects
 * specifying the fields that must match. Each object must contain the table's
 * primary key field (e.g. `reservation_id`) so we can look up the record.
 *
 * Returns `true` if all specified fields in all expected records match.
 */
export function evaluateDBState(
  finalDb: Record<string, any[]>,
  expectedDb: Record<string, any[]>,
): boolean {
  for (const [table, expectedRecords] of Object.entries(expectedDb)) {
    const actualRecords: any[] = finalDb[table];
    if (!actualRecords) return false;

    for (const expected of expectedRecords) {
      // Find primary key field (first field ending with _id)
      const pkField = Object.keys(expected).find(k => k.endsWith('_id'));
      if (!pkField) continue;

      const actual = actualRecords.find(r => r[pkField] === expected[pkField]);
      if (!actual) return false;

      // Check all specified fields
      for (const [key, value] of Object.entries(expected)) {
        if (actual[key] !== value) return false;
      }
    }
  }

  return true;
}

/**
 * Compute pass^k metrics from trial results.
 *
 * For each task, we have an array of boolean results (one per trial).
 * pass^k = fraction of tasks where ALL of the first k trials passed.
 *
 * Returns an array [pass^1, pass^2, ..., pass^numTrials].
 */
export function computePassK(
  taskTrialResults: boolean[][],
  numTrials: number,
): number[] {
  if (taskTrialResults.length === 0) return [];

  const passAtK: number[] = [];

  for (let k = 1; k <= numTrials; k++) {
    let passCount = 0;
    for (const trials of taskTrialResults) {
      // Check if all of the first k trials passed
      const firstK = trials.slice(0, k);
      if (firstK.length >= k && firstK.every(r => r)) {
        passCount++;
      }
    }
    passAtK.push(passCount / taskTrialResults.length);
  }

  return passAtK;
}
