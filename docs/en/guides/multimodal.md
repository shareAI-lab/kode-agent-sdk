# Multimodal Content Guide

KODE SDK supports multimodal input including images, audio, video, and files (PDF). This guide covers how to send multimodal content to LLM models and manage multimodal history.

---

## Supported Content Types

| Type | Block Type | Supported Providers |
|------|------------|---------------------|
| Images | `image` | Anthropic, OpenAI, Gemini, GLM, Minimax |
| PDF Files | `file` | Anthropic, OpenAI (Responses API), Gemini |
| Audio | `audio` | OpenAI (wav/mp3), Gemini |
| Video | `video` | Gemini |

---

## Sending Multimodal Content

### Image Input

Send images using `ContentBlock[]` with `agent.send()`:

```typescript
import { Agent, ContentBlock } from '@shareai-lab/kode-sdk';
import * as fs from 'fs';

// Read image as base64
const imageBuffer = fs.readFileSync('./image.png');
const base64 = imageBuffer.toString('base64');

// Build content blocks
const content: ContentBlock[] = [
  { type: 'text', text: 'What animals are in this image?' },
  { type: 'image', base64, mime_type: 'image/png' }
];

// Send to agent
const response = await agent.send(content);
```

### URL-based Images

You can also use URLs instead of base64:

```typescript
const content: ContentBlock[] = [
  { type: 'text', text: 'Describe this image.' },
  { type: 'image', url: 'https://example.com/image.jpg' }
];

const response = await agent.send(content);
```

### PDF File Input

```typescript
const pdfBuffer = fs.readFileSync('./document.pdf');
const base64 = pdfBuffer.toString('base64');

const content: ContentBlock[] = [
  { type: 'text', text: 'Extract the main topics from this PDF.' },
  { type: 'file', base64, mime_type: 'application/pdf', filename: 'document.pdf' }
];

const response = await agent.send(content);
```

### Audio Input

```typescript
const audioBuffer = fs.readFileSync('./audio.wav');
const base64 = audioBuffer.toString('base64');

const content: ContentBlock[] = [
  { type: 'text', text: 'Please transcribe this audio.' },
  { type: 'audio', base64, mime_type: 'audio/wav' }
];

const response = await agent.send(content);
```

### Video Input

```typescript
const videoBuffer = fs.readFileSync('./video.mp4');
const base64 = videoBuffer.toString('base64');

const content: ContentBlock[] = [
  { type: 'text', text: 'Describe what is happening in this video.' },
  { type: 'video', base64, mime_type: 'video/mp4' }
];

const response = await agent.send(content);
```

---

## Multimodal Configuration

### Agent Configuration

Configure multimodal behavior when creating an Agent:

```typescript
const agent = await Agent.create({
  templateId: 'multimodal-assistant',
  // Keep multimodal content in conversation history
  multimodalContinuation: 'history',
  // Keep recent 3 messages with multimodal content when compressing context
  multimodalRetention: { keepRecent: 3 },
}, deps);
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `multimodalContinuation` | `'history'` | `'history'` | Preserve multimodal content in conversation history |
| `multimodalRetention.keepRecent` | `number` | `3` | Number of recent multimodal messages to keep during context compression |

### Provider Configuration

Configure multimodal options in the model configuration:

```typescript
const provider = new GeminiProvider(
  process.env.GEMINI_API_KEY!,
  'gemini-2.0-flash-exp',
  undefined, // baseUrl
  undefined, // proxyUrl
  {
    multimodal: {
      mode: 'url+base64',           // Allow both URL and base64
      maxBase64Bytes: 20_000_000,   // 20MB max for base64
      allowMimeTypes: [             // Allowed MIME types
        'image/jpeg',
        'image/png',
        'image/webp',
        'application/pdf',
        'audio/wav',
        'audio/mp3',
        'video/mp4',
        'video/webm',
      ],
    },
  }
);
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `mode` | `'url'` \| `'url+base64'` | `'url'` | URL handling mode |
| `maxBase64Bytes` | `number` | `20000000` | Maximum size for base64 content |
| `allowMimeTypes` | `string[]` | Common image + PDF types | Allowed MIME types |

---

## Supported MIME Types

### Images

| MIME Type | Extension | Notes |
|-----------|-----------|-------|
| `image/jpeg` | `.jpg`, `.jpeg` | All providers |
| `image/png` | `.png` | All providers |
| `image/webp` | `.webp` | All providers |
| `image/gif` | `.gif` | Not supported by Gemini |

### Documents

| MIME Type | Extension | Notes |
|-----------|-----------|-------|
| `application/pdf` | `.pdf` | Anthropic, OpenAI (Responses API), Gemini |

### Audio

| MIME Type | Extension | Notes |
|-----------|-----------|-------|
| `audio/wav` | `.wav` | OpenAI, Gemini |
| `audio/mp3` | `.mp3` | OpenAI, Gemini |
| `audio/mpeg` | `.mp3` | OpenAI, Gemini |
| `audio/ogg` | `.ogg` | Gemini only |
| `audio/flac` | `.flac` | Gemini only |

### Video

| MIME Type | Extension | Notes |
|-----------|-----------|-------|
| `video/mp4` | `.mp4` | Gemini only |
| `video/webm` | `.webm` | Gemini only |
| `video/quicktime` | `.mov` | Gemini only |

---

## Provider-Specific Notes

### Anthropic

- Supports images and PDF files
- Files API beta header is automatically added when file blocks are detected
- Base64 images embedded directly in messages
- **Audio and video are not supported**

```typescript
const provider = new AnthropicProvider(apiKey, model, baseUrl, proxyUrl, {
  multimodal: {
    mode: 'url+base64',
  },
});
```

### OpenAI

- Images: Supported in Chat Completions API
- PDF/Files: Requires Responses API (`api: 'responses'`)
- Audio: Supports wav/mp3 formats via Chat Completions API `input_audio` type
- **Video is not supported** (use `customFrameExtractor` callback to extract frames as images)

```typescript
const provider = new OpenAIProvider(apiKey, model, baseUrl, proxyUrl, {
  api: 'responses',  // Required for PDF support
  multimodal: {
    mode: 'url+base64',
    allowMimeTypes: [
      'image/jpeg', 'image/png', 'image/webp',
      'audio/wav', 'audio/mp3',
      'application/pdf',
    ],
  },
});
```

### Gemini

- Supports images, PDF, audio, and video
- GIF format not supported
- Audio and video natively supported without special configuration

```typescript
const provider = new GeminiProvider(apiKey, model, baseUrl, proxyUrl, {
  multimodal: {
    mode: 'url+base64',
    allowMimeTypes: [
      'image/jpeg', 'image/png', 'image/webp',
      'application/pdf',
      'audio/wav', 'audio/mp3', 'audio/ogg',
      'video/mp4', 'video/webm',
    ],
  },
});
```

---

## Video Fallback Handling

For providers that don't support video (like OpenAI), you can configure `customFrameExtractor` callback to extract video frames as images:

```typescript
const multimodalConfig = {
  mode: 'url+base64',
  maxBase64Bytes: 20_000_000,
  video: {
    // Extract key frames when provider doesn't support video
    customFrameExtractor: async (video: { base64?: string; url?: string; mimeType?: string }) => {
      // Use ffmpeg or other tools to extract key frames
      // Return array of images
      return [
        { base64: '...', mimeType: 'image/jpeg' },
        { base64: '...', mimeType: 'image/jpeg' },
      ];
    },
  },
};

const provider = new OpenAIProvider(apiKey, model, baseUrl, proxyUrl, {
  multimodal: multimodalConfig,
});
```

---

## Best Practices

### 1. Use Appropriate File Sizes

Large files increase token usage and latency. Resize before sending:

```typescript
// Recommendation: Keep files under 1MB for optimal performance
const maxBytes = 1024 * 1024; // 1MB

function validateFileSize(base64: string): boolean {
  const bytes = Math.ceil(base64.length * 3 / 4);
  return bytes <= maxBytes;
}
```

### 2. Handle Multimodal Context Retention

For long conversations with many multimedia files, configure retention to avoid context overflow:

```typescript
const agent = await Agent.create({
  templateId: 'vision-assistant',
  multimodalRetention: { keepRecent: 2 },  // Keep only recent 2 multimedia messages
  context: {
    maxTokens: 100_000,
    compressToTokens: 60_000,
  },
}, deps);
```

### 3. Validate MIME Types

Always validate MIME types before sending:

```typescript
const ALLOWED_TYPES: Record<string, string[]> = {
  image: ['image/jpeg', 'image/png', 'image/webp'],
  audio: ['audio/wav', 'audio/mp3', 'audio/mpeg'],
  video: ['video/mp4', 'video/webm'],
};

function getMimeType(filename: string, category: 'image' | 'audio' | 'video'): string {
  const ext = filename.toLowerCase().split('.').pop();
  const mimeMap: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
    wav: 'audio/wav', mp3: 'audio/mp3',
    mp4: 'video/mp4', webm: 'video/webm',
  };
  const mimeType = mimeMap[ext!];
  if (!mimeType || !ALLOWED_TYPES[category].includes(mimeType)) {
    throw new Error(`Unsupported ${category} type: ${ext}`);
  }
  return mimeType;
}
```

---

## Error Handling

Common multimodal errors:

| Error | Cause | Solution |
|-------|-------|----------|
| `MultimodalValidationError: Base64 is not allowed` | `mode` set to `'url'` only | Set `mode: 'url+base64'` |
| `MultimodalValidationError: base64 payload too large` | Exceeds `maxBase64Bytes` | Resize file or increase limit |
| `MultimodalValidationError: mime_type not allowed` | MIME type not in allowlist | Add to `allowMimeTypes` |
| `MultimodalValidationError: Missing url/file_id/base64` | No content source provided | Provide `url`, `file_id`, or `base64` |
| `UnsupportedContentBlockError: Unsupported content block type: video` | Provider doesn't support video | Use Gemini or configure `customFrameExtractor` |

---

## Complete Examples

### Image Analysis Example

```typescript
import { Agent, GeminiProvider, JSONStore, ContentBlock } from '@shareai-lab/kode-sdk';
import * as fs from 'fs';

async function analyzeImage() {
  const provider = new GeminiProvider(
    process.env.GEMINI_API_KEY!,
    'gemini-2.0-flash-exp',
    undefined,
    undefined,
    {
      multimodal: {
        mode: 'url+base64',
        maxBase64Bytes: 10_000_000,
      },
    }
  );

  const store = new JSONStore('./.kode');

  const agent = await Agent.create({
    templateId: 'vision-assistant',
    multimodalContinuation: 'history',
    multimodalRetention: { keepRecent: 3 },
  }, {
    store,
    templateRegistry,
    toolRegistry,
    sandboxFactory,
    modelFactory: () => provider,
  });

  const imageBuffer = fs.readFileSync('./photo.jpg');
  const base64 = imageBuffer.toString('base64');

  const content: ContentBlock[] = [
    { type: 'text', text: 'What objects are in this photo?' },
    { type: 'image', base64, mime_type: 'image/jpeg' }
  ];

  // Use chatStream for streaming responses
  for await (const envelope of agent.chatStream(content)) {
    if (envelope.event.type === 'text_chunk') {
      process.stdout.write(envelope.event.delta);
    }
    if (envelope.event.type === 'done') break;
  }
}
```

### Audio Transcription Example

```typescript
async function transcribeAudio() {
  const audioBuffer = fs.readFileSync('./speech.wav');
  const base64 = audioBuffer.toString('base64');

  const content: ContentBlock[] = [
    { type: 'text', text: 'Please transcribe this audio and identify the speaker\'s emotion.' },
    { type: 'audio', base64, mime_type: 'audio/wav' }
  ];

  const response = await agent.chat(content);
  console.log(response.text);
}
```

### Video Analysis Example

```typescript
async function analyzeVideo() {
  const videoBuffer = fs.readFileSync('./clip.mp4');
  const base64 = videoBuffer.toString('base64');

  const content: ContentBlock[] = [
    { type: 'text', text: 'What is happening in this video? Please describe in detail.' },
    { type: 'video', base64, mime_type: 'video/mp4' }
  ];

  // Note: Only Gemini supports video
  const response = await agent.chat(content);
  console.log(response.text);
}
```

---

## References

- [Provider Guide](./providers.md) - Provider-specific configuration
- [Events Guide](./events.md) - Progress event handling
- [API Reference](../reference/api.md) - ContentBlock types
