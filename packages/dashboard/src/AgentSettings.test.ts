import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AgentSettings from './AgentSettings.svelte';
import { fakeDaemon } from './testing';
import type { AgentSetting } from './types';

afterEach(() => vi.unstubAllGlobals());

const claude: AgentSetting = { id: 'claude-1', platform: 'CLAUDE_CODE', model: null, subAgents: false, canChooseModel: true, canUseSubAgents: true };
const gemini: AgentSetting = { id: 'gemini-1', platform: 'ANTIGRAVITY', model: 'gemini-3.8-flash-high', subAgents: false, canChooseModel: true, canUseSubAgents: false };
const custom: AgentSetting = { id: 'fake-1', platform: 'FAKE', model: null, subAgents: false, canChooseModel: false, canUseSubAgents: false };
const MODELS = { models: [{ id: 'sonnet', label: 'Sonnet (the latest)' }, { id: 'opus', label: 'Opus (the latest)' }], note: 'These names always mean the latest of each.' };
const row = (id: string) => within(screen.getByRole('group', { name: id }));

describe('what each agent runs on', () => {
  it('shows one row per agent with what is set now, and says "its own default" when nothing is', () => {
    fakeDaemon({});
    render(AgentSettings, { agents: [claude, gemini], onChanged: vi.fn() });
    expect((row('claude-1').getByLabelText('Model') as HTMLInputElement).value).toBe('');
    expect((row('claude-1').getByLabelText('Model') as HTMLInputElement).placeholder).toBe("the tool's own default");
    expect((row('gemini-1').getByLabelText('Model') as HTMLInputElement).value).toBe('gemini-3.8-flash-high');
  });

  it('offers sub-agents for Claude Code only, saying what they are and what they cost; Antigravity decides for itself', () => {
    fakeDaemon({});
    render(AgentSettings, { agents: [claude, gemini], onChanged: vi.fn() });
    expect(row('claude-1').getByRole('checkbox', { name: /Allow sub-agents/ })).toBeTruthy();
    expect(row('claude-1').getByText(/helper agents/)).toBeTruthy();
    expect(row('claude-1').getByText(/tokens of their own/)).toBeTruthy();
    expect(within(screen.getByRole('group', { name: 'gemini-1' })).queryByRole('checkbox')).toBeNull();
    expect(row('gemini-1').getByText(/decides for itself/)).toBeTruthy();
  });

  it('has nothing to choose for a tool defined by hand, and says where its model is', () => {
    fakeDaemon({});
    render(AgentSettings, { agents: [custom], onChanged: vi.fn() });
    expect(row('fake-1').queryByLabelText('Model')).toBeNull();
    expect(row('fake-1').getByText(/own definition/)).toBeTruthy();
  });

  it('asks which models exist only when the person goes to choose one, once per tool, and offers them', async () => {
    const daemon = fakeDaemon({ '/api/models': MODELS });
    render(AgentSettings, { agents: [claude], onChanged: vi.fn() });
    expect(daemon.calls).toHaveLength(0); // opening Setup asks nothing
    await fireEvent.focus(row('claude-1').getByLabelText('Model'));
    await waitFor(() => expect(document.querySelectorAll('datalist option')).toHaveLength(2));
    await fireEvent.blur(row('claude-1').getByLabelText('Model'));
    await fireEvent.focus(row('claude-1').getByLabelText('Model'));
    expect(daemon.posts('/api/models')).toHaveLength(1);
    expect(daemon.posts('/api/models')[0]!.body).toEqual({ platform: 'CLAUDE_CODE' });
    expect([...document.querySelectorAll('datalist option')].map((o) => o.getAttribute('value'))).toEqual(['sonnet', 'opus']);
    expect(screen.getByText(/always mean the latest/)).toBeTruthy();
  });

  it('saves the model and the sub-agent choice, tells the page to refresh, and says it applies from the next run', async () => {
    const daemon = fakeDaemon({ '/api/models': MODELS, '/api/agents/settings': { id: 'claude-1', model: 'opus', subAgents: true } });
    const onChanged = vi.fn();
    render(AgentSettings, { agents: [claude], onChanged });
    await fireEvent.input(row('claude-1').getByLabelText('Model'), { target: { value: 'opus' } });
    await fireEvent.click(row('claude-1').getByRole('checkbox', { name: /Allow sub-agents/ }));
    await fireEvent.click(row('claude-1').getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(daemon.posts('/api/agents/settings')[0]!.body).toEqual({ agentId: 'claude-1', model: 'opus', subAgents: true });
    expect(row('claude-1').getByText(/from its next run/)).toBeTruthy();
  });

  it('puts an agent back on the default by clearing the box', async () => {
    const daemon = fakeDaemon({ '/api/agents/settings': { id: 'gemini-1', model: null, subAgents: false } });
    render(AgentSettings, { agents: [gemini], onChanged: vi.fn() });
    await fireEvent.input(row('gemini-1').getByLabelText('Model'), { target: { value: '  ' } });
    await fireEvent.click(row('gemini-1').getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(daemon.posts('/api/agents/settings')).toHaveLength(1));
    expect(daemon.posts('/api/agents/settings')[0]!.body).toEqual({ agentId: 'gemini-1', model: null });
  });

  it('saves nothing until something was changed', async () => {
    fakeDaemon({});
    render(AgentSettings, { agents: [claude, gemini], onChanged: vi.fn() });
    expect((row('claude-1').getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.input(row('claude-1').getByLabelText('Model'), { target: { value: 'haiku' } });
    expect((row('claude-1').getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false);
    expect((row('gemini-1').getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the daemon\'s refusal on the row, and keeps what was typed', async () => {
    fakeDaemon({ '/api/agents/settings': { status: 409, body: { error: '"a b" is not a model name.' } } });
    render(AgentSettings, { agents: [claude], onChanged: vi.fn() });
    await fireEvent.input(row('claude-1').getByLabelText('Model'), { target: { value: 'a b' } });
    await fireEvent.click(row('claude-1').getByRole('button', { name: 'Save' }));
    expect((await row('claude-1').findByRole('alert')).textContent).toContain('is not a model name');
    expect((row('claude-1').getByLabelText('Model') as HTMLInputElement).value).toBe('a b');
  });

  it('says when a model list could not be read, and lets the name be typed anyway', async () => {
    fakeDaemon({ '/api/models': { models: [], note: 'AgentMesh could not ask Antigravity which models it has. You can still type a model name.' } });
    render(AgentSettings, { agents: [gemini], onChanged: vi.fn() });
    await fireEvent.focus(row('gemini-1').getByLabelText('Model'));
    expect(await screen.findByText(/could not ask Antigravity/)).toBeTruthy();
  });
});
