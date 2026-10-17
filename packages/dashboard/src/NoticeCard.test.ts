import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import NoticeCard from './NoticeCard.svelte';
import { fakeDaemon } from './testing';
import type { Notice } from './types';

afterEach(() => vi.unstubAllGlobals());

const question: Notice = { key: 'q:q1', kind: 'question', urgent: true, title: 'gemini-1 has a question', text: 'Should bookings be limit…', questionId: 'q1' };
const stuck: Notice = { key: 'stuck:gemini-1:M0-2:x', kind: 'stuck', urgent: true, title: 'gemini-1 gave up on task M0-2', text: 'quota', agentId: 'gemini-1', subject: 'M0-2' };
const plan: Notice = { key: 'plan:M1:v1:r1', kind: 'plan', urgent: true, title: 'Plan ready: Car wash booking', text: 'Read it first.', missionId: 'M1' };

describe('a question is answered where it is shown', () => {
  it('shows the whole question, not the clipped one, and will not send an empty answer', () => {
    fakeDaemon({});
    render(NoticeCard, { notice: question, question: 'Should bookings be limited to one wash per customer per day, or is two fine?', onNavigate: vi.fn(), onChanged: vi.fn() });
    expect(screen.getByText(/or is two fine\?/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Answer' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('sends the answer for that question, tells the page to refresh, and clears the box', async () => {
    const daemon = fakeDaemon({ '/api/answer': { ok: true } });
    const onChanged = vi.fn();
    render(NoticeCard, { notice: question, onNavigate: vi.fn(), onChanged });
    const box = screen.getByLabelText('Your answer') as HTMLTextAreaElement;
    await fireEvent.input(box, { target: { value: '  One per day.  ' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(daemon.posts('/api/answer')[0]!.body).toEqual({ questionId: 'q1', answer: 'One per day.' });
    expect(box.value).toBe('');
  });

  it('says what went wrong and keeps the words when the daemon refuses', async () => {
    fakeDaemon({ '/api/answer': { status: 409, body: { error: 'That question was already answered.' } } });
    const onChanged = vi.fn();
    render(NoticeCard, { notice: question, onNavigate: vi.fn(), onChanged });
    const box = screen.getByLabelText('Your answer') as HTMLTextAreaElement;
    await fireEvent.input(box, { target: { value: 'One per day.' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
    expect((await screen.findByRole('alert')).textContent).toBe('That question was already answered.');
    expect(onChanged).not.toHaveBeenCalled();
    expect(box.value).toBe('One per day.');
  });
});

describe('a run that gave up can be retried or looked into', () => {
  it('"Try again" retries that agent on that subject', async () => {
    const daemon = fakeDaemon({ '/api/retry': { ok: true } });
    const onChanged = vi.fn();
    render(NoticeCard, { notice: stuck, onNavigate: vi.fn(), onChanged });
    await fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(daemon.posts('/api/retry')[0]!.body).toEqual({ agentId: 'gemini-1', subject: 'M0-2' });
  });

  it('"See why" goes to the board and sends nothing', async () => {
    const daemon = fakeDaemon({});
    const onNavigate = vi.fn();
    render(NoticeCard, { notice: stuck, onNavigate, onChanged: vi.fn() });
    await fireEvent.click(screen.getByRole('button', { name: 'See why' }));
    expect(onNavigate).toHaveBeenCalledWith('board', undefined);
    expect(daemon.calls).toHaveLength(0);
  });
});

describe('a plan is opened, never approved from a summary', () => {
  it('"Read the plan" lands on that mission and offers no approve button', async () => {
    const daemon = fakeDaemon({});
    const onNavigate = vi.fn();
    render(NoticeCard, { notice: plan, onNavigate, onChanged: vi.fn() });
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Read the plan' }));
    expect(onNavigate).toHaveBeenCalledWith('missions', 'mission-M1');
    expect(daemon.calls).toHaveLength(0);
  });
});
