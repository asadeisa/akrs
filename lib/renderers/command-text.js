// `commandTokens` (command ID -> manifest tokens) makes the text pasteable: `road-new` is `akrs road new`.
export function commandText({ command, args }, commandTokens) {
  const known = commandTokens?.get(command);
  if (known !== undefined) return ['akrs', ...known, ...args].join(' ');
  const token = command === 'help'
    ? '--help'
    : command === 'version' ? '--version' : command;
  return ['akrs', token, ...args].join(' ');
}
