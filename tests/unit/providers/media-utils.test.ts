/**
 * Unit tests for audio/video media utilities
 */
import {
  buildGeminiAudioPart,
  buildGeminiVideoPart,
  extractOpenAIAudioFormat,
  buildOpenAIAudioPart,
  VIDEO_UNSUPPORTED_TEXT,
  AUDIO_UNSUPPORTED_TEXT,
} from '../../../src/infra/providers/utils';
import { AudioContentBlock, VideoContentBlock } from '../../../src/core/types';
import { TestRunner, expect } from '../../helpers/utils';

const runner = new TestRunner('Provider/MediaUtils');

// =============================================================================
// buildGeminiAudioPart Tests
// =============================================================================

runner
  .test('buildGeminiAudioPart: 支持多种输入类型', async () => {
    // base64 + mime_type
    const base64Block: AudioContentBlock = {
      type: 'audio',
      base64: 'dGVzdC1hdWRpby1kYXRh',
      mime_type: 'audio/mp3',
    };
    const base64Result = buildGeminiAudioPart(base64Block);
    expect.toBeTruthy(base64Result, 'base64 result should exist');
    expect.toEqual(base64Result.inline_data.mime_type, 'audio/mp3');
    expect.toEqual(base64Result.inline_data.data, 'dGVzdC1hdWRpby1kYXRh');

    // GCS URI
    const gcsBlock: AudioContentBlock = {
      type: 'audio',
      url: 'gs://bucket/audio.wav',
      mime_type: 'audio/wav',
    };
    const gcsResult = buildGeminiAudioPart(gcsBlock);
    expect.toBeTruthy(gcsResult, 'GCS result should exist');
    expect.toEqual(gcsResult.file_data.file_uri, 'gs://bucket/audio.wav');
    expect.toEqual(gcsResult.file_data.mime_type, 'audio/wav');

    // HTTPS URL
    const httpsBlock: AudioContentBlock = {
      type: 'audio',
      url: 'https://example.com/audio.mp3',
      mime_type: 'audio/mpeg',
    };
    const httpsResult = buildGeminiAudioPart(httpsBlock);
    expect.toBeTruthy(httpsResult, 'HTTPS result should exist');
    expect.toEqual(httpsResult.file_data.file_uri, 'https://example.com/audio.mp3');

    // file_id
    const fileIdBlock: AudioContentBlock = {
      type: 'audio',
      file_id: 'files/abc123',
      mime_type: 'audio/wav',
    };
    const fileIdResult = buildGeminiAudioPart(fileIdBlock);
    expect.toBeTruthy(fileIdResult, 'file_id result should exist');
    expect.toEqual(fileIdResult.file_data.file_uri, 'files/abc123');
  })

  .test('buildGeminiAudioPart: 边界情况处理', async () => {
    // empty block returns null
    const emptyBlock: AudioContentBlock = { type: 'audio' };
    const emptyResult = buildGeminiAudioPart(emptyBlock);
    expect.toEqual(emptyResult, null);

    // default mime_type when not specified
    const noMimeBlock: AudioContentBlock = {
      type: 'audio',
      base64: 'dGVzdC1hdWRpby1kYXRh',
    };
    const noMimeResult = buildGeminiAudioPart(noMimeBlock);
    expect.toBeTruthy(noMimeResult, 'Result should exist');
    expect.toEqual(noMimeResult.inline_data.mime_type, 'audio/wav');
  })

// =============================================================================
// buildGeminiVideoPart Tests
// =============================================================================

  .test('buildGeminiVideoPart: 支持多种输入类型', async () => {
    // base64
    const base64Block: VideoContentBlock = {
      type: 'video',
      base64: 'dGVzdC12aWRlby1kYXRh',
      mime_type: 'video/mp4',
    };
    const base64Result = buildGeminiVideoPart(base64Block);
    expect.toBeTruthy(base64Result, 'base64 result should exist');
    expect.toEqual(base64Result.inline_data.mime_type, 'video/mp4');
    expect.toEqual(base64Result.inline_data.data, 'dGVzdC12aWRlby1kYXRh');

    // GCS URI
    const gcsBlock: VideoContentBlock = {
      type: 'video',
      url: 'gs://bucket/video.mp4',
      mime_type: 'video/mp4',
    };
    const gcsResult = buildGeminiVideoPart(gcsBlock);
    expect.toBeTruthy(gcsResult, 'GCS result should exist');
    expect.toEqual(gcsResult.file_data.file_uri, 'gs://bucket/video.mp4');

    // file_id
    const fileIdBlock: VideoContentBlock = {
      type: 'video',
      file_id: 'files/video123',
      mime_type: 'video/webm',
    };
    const fileIdResult = buildGeminiVideoPart(fileIdBlock);
    expect.toBeTruthy(fileIdResult, 'file_id result should exist');
    expect.toEqual(fileIdResult.file_data.file_uri, 'files/video123');
  })

  .test('buildGeminiVideoPart: 边界情况处理', async () => {
    // default mime_type to video/mp4
    const noMimeBlock: VideoContentBlock = {
      type: 'video',
      base64: 'dGVzdC12aWRlby1kYXRh',
    };
    const noMimeResult = buildGeminiVideoPart(noMimeBlock);
    expect.toBeTruthy(noMimeResult, 'Result should exist');
    expect.toEqual(noMimeResult.inline_data.mime_type, 'video/mp4');

    // empty block returns null
    const emptyBlock: VideoContentBlock = { type: 'video' };
    const emptyResult = buildGeminiVideoPart(emptyBlock);
    expect.toEqual(emptyResult, null);
  })

// =============================================================================
// extractOpenAIAudioFormat Tests
// =============================================================================

  .test('extractOpenAIAudioFormat: 支持的格式转换', async () => {
    // wav variants
    expect.toEqual(extractOpenAIAudioFormat('audio/wav'), 'wav');
    expect.toEqual(extractOpenAIAudioFormat('audio/x-wav'), 'wav');
    expect.toEqual(extractOpenAIAudioFormat('audio/wave'), 'wav');

    // mp3 variants
    expect.toEqual(extractOpenAIAudioFormat('audio/mpeg'), 'mp3');
    expect.toEqual(extractOpenAIAudioFormat('audio/mp3'), 'mp3');

    // case insensitive
    expect.toEqual(extractOpenAIAudioFormat('AUDIO/WAV'), 'wav');
    expect.toEqual(extractOpenAIAudioFormat('Audio/Mpeg'), 'mp3');
  })

  .test('extractOpenAIAudioFormat: 不支持的格式和边界情况', async () => {
    // unsupported formats return null
    expect.toEqual(extractOpenAIAudioFormat('audio/ogg'), null);
    expect.toEqual(extractOpenAIAudioFormat('audio/flac'), null);
    expect.toEqual(extractOpenAIAudioFormat('audio/aac'), null);

    // undefined/empty returns null
    expect.toEqual(extractOpenAIAudioFormat(undefined), null);
    expect.toEqual(extractOpenAIAudioFormat(''), null);
  })

// =============================================================================
// buildOpenAIAudioPart Tests
// =============================================================================

  .test('buildOpenAIAudioPart: 有效输入', async () => {
    // valid wav
    const wavBlock: AudioContentBlock = {
      type: 'audio',
      base64: 'dGVzdC1hdWRpby1kYXRh',
      mime_type: 'audio/wav',
    };
    const wavResult = buildOpenAIAudioPart(wavBlock);
    expect.toBeTruthy(wavResult, 'wav result should exist');
    expect.toEqual(wavResult.type, 'input_audio');
    expect.toEqual(wavResult.input_audio.format, 'wav');
    expect.toEqual(wavResult.input_audio.data, 'dGVzdC1hdWRpby1kYXRh');

    // valid mp3
    const mp3Block: AudioContentBlock = {
      type: 'audio',
      base64: 'dGVzdC1hdWRpby1kYXRh',
      mime_type: 'audio/mpeg',
    };
    const mp3Result = buildOpenAIAudioPart(mp3Block);
    expect.toBeTruthy(mp3Result, 'mp3 result should exist');
    expect.toEqual(mp3Result.input_audio.format, 'mp3');
  })

  .test('buildOpenAIAudioPart: 无效输入返回 null', async () => {
    // unsupported format
    const oggBlock: AudioContentBlock = {
      type: 'audio',
      base64: 'dGVzdC1hdWRpby1kYXRh',
      mime_type: 'audio/ogg',
    };
    expect.toEqual(buildOpenAIAudioPart(oggBlock), null);

    // no base64 (URL only - not supported by OpenAI)
    const urlBlock: AudioContentBlock = {
      type: 'audio',
      url: 'https://example.com/audio.wav',
      mime_type: 'audio/wav',
    };
    expect.toEqual(buildOpenAIAudioPart(urlBlock), null);

    // no mime_type
    const noMimeBlock: AudioContentBlock = {
      type: 'audio',
      base64: 'dGVzdC1hdWRpby1kYXRh',
    };
    expect.toEqual(buildOpenAIAudioPart(noMimeBlock), null);
  })

// =============================================================================
// Constants Tests
// =============================================================================

  .test('降级文本常量已定义', async () => {
    expect.toBeTruthy(VIDEO_UNSUPPORTED_TEXT, 'VIDEO_UNSUPPORTED_TEXT should exist');
    expect.toContain(VIDEO_UNSUPPORTED_TEXT, 'video');

    expect.toBeTruthy(AUDIO_UNSUPPORTED_TEXT, 'AUDIO_UNSUPPORTED_TEXT should exist');
    expect.toContain(AUDIO_UNSUPPORTED_TEXT, 'audio');
  });

export async function run() {
  return await runner.run();
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
