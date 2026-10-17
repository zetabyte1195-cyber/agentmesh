import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Setup from './Setup.svelte';
import { fakeDaemon } from './testing';
import type { RecipeInfo } from './types';

afterEach(() => vi.unstubAllGlobals());

const ollama = (o: Partial<RecipeInfo> = {}): RecipeInfo => ({
  id: 'CLAUDE_OLLAMA',
  title: 'Claude Code on a local model (Ollama)',
  summary: 'Runs Claude Code against a model that Ollama serves.',
  caveats: ['Set the context length first.'],
  install: 'ollama pull <model>',
  signIn: 'No sign-in.',
  docs: [],
  added: false,
  current: null,
  fields: [
    { id: 'model', label: 'Model', hint: 'The model.', default: '', suggest: 'ollama-models' },
    { id: 'address', label: 'Ollama address', hint: 'Where Ollama listens.', default: 'http://127.0.0.1:11434', suggest: null },
  ],
  ...o,
});
const codex = (o: Partial<RecipeInfo> = {}): RecipeInfo => ({ ...ollama(), id: 'CODEX', title: 'Codex CLI (OpenAI)', fields: [], ...o });

function mount(recipes: RecipeInfo[], onChanged = vi.fn()) {
  const props = {
    platforms: [],
    project: { name: 'p', verifyCommand: null, landWithoutVerify: false, suggestedVerifyCommand: null, landing: false, context: '', maxContext: 3500 },
    playbooks: null,
    recipes,
    sandbox: null,
    notifications: { webhookUrl: null, hasSecret: false, last: null },
    update: { enabled: false, info: null, error: null },
    version: '0.2.0',
    onChanged,
  };
  return { onChanged, ...render(Setup, props as never) };
}
const routes = { '/api/platforms': [], '/api/platforms/ollama-models': { checked: true, reachable: true, models: [{ name: 'gemma4:e2b', sizeGb: 7, cloud: false }] } };

describe('the tools added from a recipe', () => {
  it('a recipe not added yet is offered to add, and one with choices that is added is offered to change', async () => {
    fakeDaemon(routes);
    mount([codex(), ollama({ added: true, current: { model: 'qwen3:8b', address: 'http://127.0.0.1:11434' } })]);
    expect(await screen.findByRole('article', { name: 'Codex CLI (OpenAI)' })).toBeTruthy();
    const change = await screen.findByRole('region', { name: 'Change a tool you added' });
    expect(within(change).getByRole('heading', { name: /Change: Claude Code on a local model/ })).toBeTruthy();
    expect((within(change).getByLabelText('Model') as HTMLInputElement).value).toBe('qwen3:8b');
  });

  it('a recipe without choices that is added has nothing to change, so it is not shown again', async () => {
    fakeDaemon(routes);
    mount([codex({ added: true })]);
    await waitFor(() => expect(screen.getByText(/A tool that is not listed\?/)).toBeTruthy());
    expect(screen.queryByRole('region', { name: 'Change a tool you added' })).toBeNull();
    expect(screen.queryByRole('article', { name: 'Codex CLI (OpenAI)' })).toBeNull();
  });

  it('changing the model posts the choices, says what happened, and asks to test again', async () => {
    const daemon = fakeDaemon({ ...routes, '/api/platforms/recipe': { id: 'CLAUDE_OLLAMA', verified: false, changed: true } });
    const { onChanged } = mount([ollama({ added: true, current: { model: 'qwen3:8b-typo', address: 'http://127.0.0.1:11434' } })]);
    const change = await screen.findByRole('region', { name: 'Change a tool you added' });
    await fireEvent.input(within(change).getByLabelText('Model'), { target: { value: 'gemma4:e2b' } });
    await fireEvent.click(within(change).getByRole('button', { name: 'Save the change' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(daemon.posts('/api/platforms/recipe')[0]!.body).toEqual({ id: 'CLAUDE_OLLAMA', values: { model: 'gemma4:e2b', address: 'http://127.0.0.1:11434' } });
    expect(within(change).getByText(/changed\. Press Test/i)).toBeTruthy();
  });

  it('shows the daemon\'s refusal on the card', async () => {
    fakeDaemon({ ...routes, '/api/platforms/recipe': { status: 400, body: { error: 'Model: Type the name of a model you have pulled.' } } });
    mount([ollama({ added: true, current: { model: 'x', address: 'http://127.0.0.1:11434' } })]);
    const change = await screen.findByRole('region', { name: 'Change a tool you added' });
    await fireEvent.click(within(change).getByRole('button', { name: 'Save the change' }));
    expect((await within(change).findByRole('alert')).textContent).toMatch(/Type the name of a model/);
  });
});
