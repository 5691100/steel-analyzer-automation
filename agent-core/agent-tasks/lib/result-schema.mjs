export function validateResult(obj) {
  const required = ['schema', 'task_id', 'from', 'verdict', 'completed_at'];
  for (const field of required) {
    if (obj[field] === undefined || obj[field] === null) {
      throw new Error(`Missing required result field: ${field}`);
    }
  }
  if (obj.schema !== 'pos.result.v1') {
    throw new Error(`Invalid result schema: ${obj.schema}`);
  }
}
