import fs from 'node:fs';
import path from 'node:path';

export type LocalMultimodalFile = {
  path: string;
  kind: 'image' | 'pdf' | 'audio' | 'video';
  mimeType: string;
  filename: string;
  data: Buffer;
  prompt?: string;
};

function stripQuotes(input: string): string {
  if (input.length < 2) return input;
  const first = input[0];
  const last = input[input.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return input.slice(1, -1);
  }
  return input;
}

export function parseReadCommand(input: string): { path: string; prompt?: string } | null {
  const trimmed = input.trim();
  let rest = '';
  if (trimmed.startsWith('读取')) {
    rest = trimmed.slice(2).trim();
  } else if (trimmed.toLowerCase().startsWith('read ')) {
    rest = trimmed.slice(5).trim();
  } else {
    return null;
  }

  if (!rest) return null;
  if (rest.includes('|')) {
    const pipeParts = rest.split('|');
    const withPipePath = stripQuotes(pipeParts[0].trim());
    const withPipePrompt = pipeParts.slice(1).join('|').trim() || undefined;
    if (withPipePath) {
      return { path: withPipePath, prompt: withPipePrompt };
    }
  }

  if (rest.startsWith('"') || rest.startsWith("'")) {
    const quote = rest[0];
    const end = rest.indexOf(quote, 1);
    if (end > 0) {
      const pathPart = stripQuotes(rest.slice(0, end + 1).trim());
      const tail = rest.slice(end + 1).trim();
      const prompt = tail.replace(/^[:：,，;；\s]+/, '').trim() || undefined;
      return { path: pathPart, prompt };
    }
  }

  const separatorMatch = rest.match(/[:：,，;；。]/);
  if (separatorMatch?.index !== undefined) {
    const pathPart = stripQuotes(rest.slice(0, separatorMatch.index).trim());
    const prompt = rest.slice(separatorMatch.index + 1).trim() || undefined;
    if (pathPart) {
      return { path: pathPart, prompt };
    }
  }

  const tokens = rest.split(/\s+/);
  const pathPart = stripQuotes(tokens[0].trim());
  const prompt = tokens.slice(1).join(' ').trim() || undefined;
  if (!pathPart) return null;
  return { path: pathPart, prompt };
}

export function loadLocalFile(command: { path: string; prompt?: string }): LocalMultimodalFile {
  const resolved = path.resolve(command.path);
  const data = fs.readFileSync(resolved);
  const ext = path.extname(resolved).toLowerCase();
  const filename = path.basename(resolved);

  if (ext === '.pdf') {
    return {
      path: resolved,
      kind: 'pdf',
      mimeType: 'application/pdf',
      filename,
      data,
      prompt: command.prompt,
    };
  }

  if (ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.webp' || ext === '.gif') {
    const mimeType = ext === '.png'
      ? 'image/png'
      : ext === '.webp'
      ? 'image/webp'
      : ext === '.gif'
      ? 'image/gif'
      : 'image/jpeg';
    return {
      path: resolved,
      kind: 'image',
      mimeType,
      filename,
      data,
      prompt: command.prompt,
    };
  }

  const audioMimes: Record<string, string> = {
    '.mp3': 'audio/mp3',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.flac': 'audio/flac',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.wma': 'audio/x-ms-wma',
    '.mpeg': 'audio/mpeg',
  };
  if (audioMimes[ext]) {
    return {
      path: resolved,
      kind: 'audio',
      mimeType: audioMimes[ext],
      filename,
      data,
      prompt: command.prompt,
    };
  }

  const videoMimes: Record<string, string> = {
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.avi': 'video/x-msvideo',
    '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska',
    '.wmv': 'video/x-ms-wmv',
    '.flv': 'video/x-flv',
  };
  if (videoMimes[ext]) {
    return {
      path: resolved,
      kind: 'video',
      mimeType: videoMimes[ext],
      filename,
      data,
      prompt: command.prompt,
    };
  }

  throw new Error(`Unsupported file type: ${ext}`);
}
