export class CliUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CliUsageError';
  }
}

export class WorkflowNotFoundError extends Error {
  constructor(workflowRoot) {
    super(`workflow not found: ${workflowRoot}`);
    this.name = 'WorkflowNotFoundError';
    this.workflowRoot = workflowRoot;
  }
}
