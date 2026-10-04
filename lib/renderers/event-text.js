// The human rendering of one verify event: one plain line, derived from the event alone. Human progress is a view of the
// events, never a second runner and never a query.
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

export function renderEventLine(event) {
  const { data } = event;
  switch (event.type) {
    case 'started':
      return `verify ${data.road}: ${plural(data.checks.length, 'check')}${data.dry_run ? ' (dry run, nothing starts)' : ''}`;
    case 'progress': {
      if (data.phase === 'check_started') return `[${data.index + 1}] ${data.name}: running`;
      if (data.phase === 'check_terminating') return `[${data.index + 1}] ${data.name}: ending the process tree (${data.reason})`;
      const exit = data.exit_code === null ? '' : `exit ${data.exit_code}`;
      const signal = data.signal === null ? '' : `signal ${data.signal}`;
      const detail = [exit, signal, data.duration_ms === null ? '' : `${data.duration_ms} ms`].filter((part) => part !== '').join(', ');
      return `[${data.index + 1}] ${data.name}: ${data.status}${detail === '' ? '' : ` (${detail})`}`;
    }
    case 'evidence':
      return `[${data.index + 1}] ${data.name}: ${data.stream} ${plural(data.total_bytes, 'byte')}${data.truncated ? ' (truncated)' : ''}`;
    case 'finding':
      return `${data.finding.code} ${data.finding.severity}: ${data.finding.message}`;
    case 'complete':
      return `complete ${data.packet.status} (${data.packet.command})`;
    default:
      throw new TypeError(`unknown event type: ${String(event.type)}`);
  }
}
