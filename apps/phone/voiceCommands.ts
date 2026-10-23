export type RelayCommand = { id: number; text: string; expiresAt: number };
const phrases = new Set(['pause','pause workout','resume','continue','finish','stop','finish workout','home','go home','repeat','repeat instructions','left','right','confirm','squat','squats','start squats','jumping jacks','start jumping jacks','arm raises','start arm raises','freeze dance','start freeze dance','mimic the pose','mimic pose','gesture trivia','start gesture trivia','start','start session','begin session']);
export function normalizeCommand(text: string): string | null {
  const clean = text.trim().toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  return phrases.has(clean) ? clean : null;
}
export function commandHeaders(command: RelayCommand | undefined, now: number, encode: (text: string) => string): string {
  if (!command || command.expiresAt <= now || !normalizeCommand(command.text)) return '';
  return `X-MoveQuest-Command-Id: ${command.id}\r\nX-MoveQuest-Command: ${encode(command.text)}\r\n`;
}
