const CROCKFORD32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeTime(time: number, length: number): string {
  let remaining = time;
  const chars = Array<string>(length);
  for (let i = length - 1; i >= 0; i--) {
    const mod = remaining % 32;
    chars[i] = CROCKFORD32.charAt(mod);
    remaining = Math.floor(remaining / 32);
  }
  return chars.join('');
}

function encodeRandom(length: number): string {
  const chars = Array<string>(length);
  for (let i = 0; i < length; i++) {
    const rand = Math.floor(Math.random() * 32);
    chars[i] = CROCKFORD32.charAt(rand);
  }
  return chars.join('');
}

export function generateAgentId(): string {
  const time = Date.now();
  const timePart = encodeTime(time, 10);
  const randomPart = encodeRandom(16);
  return `agt-${timePart}${randomPart}`;
}
