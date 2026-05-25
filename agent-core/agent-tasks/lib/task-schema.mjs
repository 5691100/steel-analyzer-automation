export function validateTask(obj) {
  const required = [
    'schema', 'id', 'from', 'to', 'type', 'created_at', 'state',
    'prompt_path', 'cwd', 'result_path'
  ];
  for (const field of required) {
    if (obj[field] === undefined || obj[field] === null) {
      throw new Error(`Missing required task field: ${field}`);
    }
  }
  if (obj.schema !== 'pos.task.v1') {
    throw new Error(`Invalid task schema: ${obj.schema}`);
  }
}
