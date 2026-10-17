import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RecipeCard from './RecipeCard.svelte';
import { fakeDaemon } from './testing';
import type { RecipeInfo } from './types';

afterEach(() => vi.unstubAllGlobals());

const ollama: RecipeInfo = {
  id: 'CLAUDE_OLLAMA',
  title: 'Claude Code on a local model (Ollama)',
  summary: 'Runs Claude Code against a model on your own computer.',
  caveats: ['Set the context length first.', 'It is its own platform for reviews.'],
  install: 'ollama pull <model>',
  signIn: 'No sign-in.',
  docs: ['https://docs.ollama.com/integrations/claude-code'],
  added: false,
  current: null,
  fields: [
    { id: 'model', label: 'Model', hint: 'Type the name of a model you have pulled.', default: '', suggest: 'ollama-models' },
    { id: 'address', label: 'Ollama address', hint: 'Where Ollama is listening.', default: 'http://127.0.0.1:11434', suggest: null },
  ],
};
const codex: RecipeInfo = { ...ollama, id: 'CODEX', title: 'Codex CLI (OpenAI)', fields: [], caveats: ['Unverified.'] };
const models = (list: { name: string; sizeGb: number | null; cloud: boolean }[]) => ({ checked: true, reachable: true, models: list });
const mount = (recipe: RecipeInfo, onAdd = vi.fn()) => ({ onAdd, ...render(RecipeCard, { recipe, onAdd }) });
const add = () => screen.getByRole('button', { name: 'Add as "not verified"' }) as HTMLButtonElement;

describe('the local-model recipe: what it sends where', () => {
  const one = (name: string) => ({ '/api/platforms/ollama-models': models([{ name, sizeGb: 5, cloud: false }]) });

  it('says nothing alarming for Ollama on this computer', async () => {
    fakeDaemon(one('qwen3:8b'));
    mount(ollama);
    await screen.findByText(/Ollama answered/);
    expect(screen.queryByText(/is not this computer/)).toBeNull();
    expect(screen.queryByText(/runs on Ollama's servers, not on your computer\./)).toBeNull();
  });

  it('warns, as soon as it is typed, when the address is not this computer, and says what is sent there', async () => {
    fakeDaemon(one('qwen3:8b'));
    mount(ollama);
    await screen.findByText(/Ollama answered/);
    await fireEvent.input(screen.getByLabelText('Ollama address'), { target: { value: 'http://192.168.1.50:11434' } });
    const warning = screen.getByRole('note');
    expect(warning.textContent).toMatch(/http:\/\/192\.168\.1\.50:11434 is not this computer/);
    expect(warning.textContent).toMatch(/files, plans and reviews/);
    await fireEvent.input(screen.getByLabelText('Ollama address'), { target: { value: 'http://localhost:11434' } });
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('warns when the model chosen runs in the cloud, whether it came from the list or was typed', async () => {
    fakeDaemon({ '/api/platforms/ollama-models': models([{ name: 'minimax-m3:cloud', sizeGb: 0, cloud: true }, { name: 'a', sizeGb: 1, cloud: false }]) });
    mount(ollama);
    await screen.findByText(/Ollama answered/);
    await fireEvent.input(screen.getByLabelText('Model'), { target: { value: 'minimax-m3:cloud' } });
    expect(screen.getByRole('note').textContent).toMatch(/minimax-m3:cloud runs on Ollama's servers, not on your computer/);
    await fireEvent.input(screen.getByLabelText('Model'), { target: { value: 'gpt-oss:120b-cloud' } }); // not in the list: the name says it
    expect(screen.getByRole('note').textContent).toMatch(/gpt-oss:120b-cloud runs on Ollama's servers/);
    await fireEvent.input(screen.getByLabelText('Model'), { target: { value: 'a' } });
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('a cleared field shows the value that will be used instead of looking empty', async () => {
    fakeDaemon(one('qwen3:8b'));
    mount(ollama);
    await screen.findByText(/Ollama answered/);
    await fireEvent.input(screen.getByLabelText('Ollama address'), { target: { value: '' } });
    expect((screen.getByLabelText('Ollama address') as HTMLInputElement).placeholder).toBe('http://127.0.0.1:11434');
  });
});

describe('looking again at another address', () => {
  it('replaces the model that was offered for the first address, as long as the person did not choose one', async () => {
    let answer = models([{ name: 'gemma4:e2b', sizeGb: 7, cloud: false }]);
    fakeDaemon({ '/api/platforms/ollama-models': () => answer });
    mount(ollama);
    await waitFor(() => expect((screen.getByLabelText('Model') as HTMLInputElement).value).toBe('gemma4:e2b'));
    answer = models([{ name: 'qwen3:8b', sizeGb: 5, cloud: false }]);
    await fireEvent.input(screen.getByLabelText('Ollama address'), { target: { value: 'http://127.0.0.1:11500' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Look again' }));
    await waitFor(() => expect((screen.getByLabelText('Model') as HTMLInputElement).value).toBe('qwen3:8b'));
  });

  it('empties the model if the new address has none to offer, so a model that is not there cannot be added by accident', async () => {
    let answer = models([{ name: 'gemma4:e2b', sizeGb: 7, cloud: false }]);
    fakeDaemon({ '/api/platforms/ollama-models': () => answer });
    mount(ollama);
    await waitFor(() => expect((screen.getByLabelText('Model') as HTMLInputElement).value).toBe('gemma4:e2b'));
    answer = models([]);
    await fireEvent.click(screen.getByRole('button', { name: 'Look again' }));
    await waitFor(() => expect((screen.getByLabelText('Model') as HTMLInputElement).value).toBe(''));
    expect(add().disabled).toBe(true);
  });

  it('leaves a model the person typed alone', async () => {
    let answer = models([{ name: 'gemma4:e2b', sizeGb: 7, cloud: false }]);
    fakeDaemon({ '/api/platforms/ollama-models': () => answer });
    mount(ollama);
    await waitFor(() => expect((screen.getByLabelText('Model') as HTMLInputElement).value).toBe('gemma4:e2b'));
    await fireEvent.input(screen.getByLabelText('Model'), { target: { value: 'mine' } });
    answer = models([{ name: 'qwen3:8b', sizeGb: 5, cloud: false }]);
    await fireEvent.click(screen.getByRole('button', { name: 'Look again' }));
    await waitFor(() => expect(screen.getByText(/Ollama answered: 1 model/)).toBeTruthy());
    expect((screen.getByLabelText('Model') as HTMLInputElement).value).toBe('mine');
  });
});

describe('changing a recipe that was added', () => {
  const added: RecipeInfo = { ...ollama, added: true, current: { model: 'qwen3:8b-typo', address: 'http://127.0.0.1:11434' } };

  it('starts from what is set, offers the models, and saves the change under its own name', async () => {
    fakeDaemon({ '/api/platforms/ollama-models': models([{ name: 'gemma4:e2b', sizeGb: 7, cloud: false }]) });
    render(RecipeCard, { recipe: added, mode: 'change', onAdd: vi.fn() });
    await screen.findByText(/Ollama answered: 1 model/);
    expect((screen.getByLabelText('Model') as HTMLInputElement).value).toBe('qwen3:8b-typo'); // what is set, not a suggestion
    expect(screen.queryByRole('button', { name: 'Add as "not verified"' })).toBeNull();
    expect(screen.getByRole('heading', { name: /Change: Claude Code on a local model/ })).toBeTruthy();
  });

  it('sends the new choices', async () => {
    fakeDaemon({ '/api/platforms/ollama-models': models([{ name: 'gemma4:e2b', sizeGb: 7, cloud: false }]) });
    const onAdd = vi.fn();
    render(RecipeCard, { recipe: added, mode: 'change', onAdd });
    await screen.findByText(/Ollama answered/);
    await fireEvent.input(screen.getByLabelText('Model'), { target: { value: 'gemma4:e2b' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Save the change' }));
    expect(onAdd).toHaveBeenCalledWith({ model: 'gemma4:e2b', address: 'http://127.0.0.1:11434' });
  });

  it('shows a confirmation, and tells the person to test again', () => {
    fakeDaemon({ '/api/platforms/ollama-models': models([]) });
    render(RecipeCard, { recipe: added, mode: 'change', message: 'Changed.', onAdd: vi.fn() });
    expect(screen.getByText('Changed.')).toBeTruthy();
  });
});

describe('a recipe without choices', () => {
  it('shows its notes, asks Ollama nothing, and adds with nothing to choose', async () => {
    const daemon = fakeDaemon({});
    const { onAdd } = mount(codex);
    expect(screen.getByText('Read before adding (1 note)')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(add().disabled).toBe(false);
    await fireEvent.click(add());
    expect(onAdd).toHaveBeenCalledWith({});
    expect(daemon.calls).toHaveLength(0);
  });
});

describe('the local-model recipe', () => {
  it('asks Ollama on this computer which models it has, and offers them', async () => {
    const daemon = fakeDaemon({ '/api/platforms/ollama-models': models([{ name: 'gemma4:e2b', sizeGb: 7.2, cloud: false }, { name: 'qwen3:8b', sizeGb: 5.2, cloud: false }]) });
    mount(ollama);
    await screen.findByText(/Ollama answered: 2 models/);
    expect(daemon.posts('/api/platforms/ollama-models')[0]!.body).toEqual({ address: 'http://127.0.0.1:11434' });
    const options = [...document.querySelectorAll('datalist option')].map((o) => [o.getAttribute('value'), o.textContent]);
    expect(options).toEqual([['gemma4:e2b', '7.2 GB'], ['qwen3:8b', '5.2 GB']]);
  });

  it('will not add until a model is chosen, and says what is missing', async () => {
    fakeDaemon({ '/api/platforms/ollama-models': models([{ name: 'a', sizeGb: 1, cloud: false }, { name: 'b', sizeGb: 1, cloud: false }]) });
    mount(ollama);
    await screen.findByText(/Ollama answered: 2 models/);
    expect(add().disabled).toBe(true);
    expect(add().title).toBe('Fill in: Model');
    await fireEvent.input(screen.getByLabelText('Model'), { target: { value: 'b' } });
    expect(add().disabled).toBe(false);
  });

  it('with exactly one model on this computer it is offered as the choice, which can still be changed', async () => {
    fakeDaemon({ '/api/platforms/ollama-models': models([{ name: 'gemma4:e2b', sizeGb: 7.2, cloud: false }, { name: 'minimax-m3:cloud', sizeGb: 0, cloud: true }]) });
    const { onAdd } = mount(ollama);
    await waitFor(() => expect((screen.getByLabelText('Model') as HTMLInputElement).value).toBe('gemma4:e2b'));
    await fireEvent.input(screen.getByLabelText('Model'), { target: { value: 'something-else' } });
    await fireEvent.click(add());
    expect(onAdd).toHaveBeenCalledWith({ model: 'something-else', address: 'http://127.0.0.1:11434' });
  });

  it('says plainly that a cloud model does not run on this computer', async () => {
    fakeDaemon({ '/api/platforms/ollama-models': models([{ name: 'minimax-m3:cloud', sizeGb: 0, cloud: true }]) });
    mount(ollama);
    expect((await screen.findByText(/Ollama answered: 1 model/)).textContent).toContain('runs on Ollama\'s servers, not on your computer');
    expect(document.querySelector('datalist option')!.textContent).toBe('runs in the cloud, not on your computer');
  });

  it('says so when Ollama is not answering, and "Look again" asks again at the address typed', async () => {
    const daemon = fakeDaemon({ '/api/platforms/ollama-models': { checked: true, reachable: false, models: [], note: 'Ollama did not answer at http://127.0.0.1:11434. Start it, then look again.' } });
    mount(ollama);
    expect((await screen.findByText(/Ollama did not answer/)).textContent).toContain('Start it, then look again');
    await fireEvent.input(screen.getByLabelText('Ollama address'), { target: { value: 'http://127.0.0.1:11500' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Look again' }));
    await waitFor(() => expect(daemon.posts('/api/platforms/ollama-models')).toHaveLength(2));
    expect(daemon.posts('/api/platforms/ollama-models')[1]!.body).toEqual({ address: 'http://127.0.0.1:11500' });
  });

  it('a model can be typed by hand when none could be listed, and the card shows a refusal from the daemon', async () => {
    fakeDaemon({ '/api/platforms/ollama-models': { checked: false, reachable: null, models: [], note: 'Models are only listed for Ollama on this computer. Type the model name yourself.' } });
    render(RecipeCard, { recipe: ollama, error: 'Model: Type the name of a model you have pulled.', onAdd: vi.fn() });
    await fireEvent.input(screen.getByLabelText('Model'), { target: { value: 'qwen3:8b' } });
    expect((await screen.findByRole('alert')).textContent).toBe('Model: Type the name of a model you have pulled.');
    expect(add().disabled).toBe(false);
  });
});
