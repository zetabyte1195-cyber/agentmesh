import { describe, expect, it } from 'vitest';
import { isThisComputer, looksLikeCloudModel } from './address';

describe('which addresses are this computer', () => {
  it('knows 127.0.0.1, localhost, and the same address written as one number', () => {
    for (const a of ['http://127.0.0.1:11434', 'http://localhost:1', 'https://localhost', 'http://2130706433:11434']) expect(isThisComputer(a), a).toBe(true);
  });
  it('treats everything else, and what is not an address, as another machine', () => {
    for (const a of ['http://192.168.1.50:11434', 'https://ollama.example.com', 'http://127.0.0.1.example.com', 'not a url', '', 'http://127.0.0.1:99999']) expect(isThisComputer(a), a).toBe(false);
  });
});

describe('models that run in the cloud', () => {
  it('are recognised by a name ending in cloud', () => {
    for (const n of ['minimax-m3:cloud', 'gpt-oss:120b-cloud', 'qwen3-coder:480b-cloud', 'X:CLOUD']) expect(looksLikeCloudModel(n), n).toBe(true);
    for (const n of ['qwen3:8b', 'cloudy:7b', 'gemma4:e2b', 'my-cloud-model:1']) expect(looksLikeCloudModel(n), n).toBe(false);
  });
});
