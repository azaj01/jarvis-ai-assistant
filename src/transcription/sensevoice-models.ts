// SenseVoice is decoded through sherpa-onnx-node's OfflineRecognizer (the same
// native runtime used for Parakeet), NOT raw onnxruntime: SenseVoice needs
// fbank feature extraction + CTC token decoding + a tokens.txt vocab, all of
// which sherpa-onnx provides out of the box. These URLs therefore point at the
// sherpa-onnx ONNX export (single `model.int8.onnx` + `tokens.txt`), not the
// upstream FunASR checkpoint which is not directly runnable here.
export interface SenseVoiceModel {
  id: string;
  name: string;
  description: string;
  size: string;
  language: string;
  modelUrl: string;  // model.int8.onnx
  tokensUrl: string; // tokens.txt vocab used to decode CTC token ids
}

export const SENSEVOICE_MODELS: SenseVoiceModel[] = [
  {
    id: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17-int8',
    name: 'SenseVoice Small (Multilingual, Int8)',
    description: 'Non-autoregressive SenseVoice Small (int8). 50+ languages incl. zh/en/ja/ko/yue, ~100ms latency. Runs locally via sherpa-onnx with CoreML on Apple Silicon.',
    size: '250MB',
    language: 'Multilingual (zh/en/ja/ko/yue)',
    modelUrl: 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/model.int8.onnx',
    tokensUrl: 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/tokens.txt'
  }
];

export const DEFAULT_SENSEVOICE_MODEL = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17-int8';

export function findSenseVoiceModel(modelId: string): SenseVoiceModel | undefined {
  return SENSEVOICE_MODELS.find(m => m.id === modelId);
}
