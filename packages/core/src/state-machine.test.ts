import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ACTOR_ROLES,
  DAEMON_PRINCIPAL,
  LEGAL_TRANSITIONS,
  TRANSITION_AUTHORIZED_ROLES,
  TASK_STATUSES,
  type ActorRole,
  type CanonicalActorRole,
  type TaskLike,
  getAllowedActorRoles,
  getLegalTargetStatuses,
  isLegalTransition,
  resolveActorRole,
  validateTaskTransition,
  validateTransition,
} from './index.js';

const schema = readFileSync(
  fileURLToPath(new URL('../../../docs/design/schema.sql', import.meta.url)),
  'utf8'
);

describe('Task State Machine: Canonical Transition Table', () => {
  it('defines exactly 32 legal transitions across all 11 statuses', () => {
    let totalTransitions = 0;
    for (const status of TASK_STATUSES) {
      const targets = LEGAL_TRANSITIONS[status];
      expect(targets).toBeDefined();
      totalTransitions += targets.length;
    }
    expect(totalTransitions).toBe(32);
    expect(Object.keys(TRANSITION_AUTHORIZED_ROLES).length).toBe(32);
  });

  it('matches exactly the transitions in SQLite trigger trg_task_status_transition', () => {
    // Extract the trigger body for trg_task_status_transition
    const triggerMatch = /CREATE TRIGGER IF NOT EXISTS trg_task_status_transition[\s\S]*?BEGIN([\s\S]*?)END;/.exec(
      schema
    );
    expect(triggerMatch).toBeDefined();
    const triggerBody = triggerMatch![1] ?? '';

    // Regex to match: (OLD.status = 'FROM' AND NEW.status IN ('TO1', 'TO2', ...))
    const transitionRegex = /OLD\.status\s*=\s*'([^']+)'\s*AND\s*NEW\.status\s*IN\s*\(([^)]+)\)/g;
    const triggerTransitions = new Map<string, string[]>();

    for (const match of triggerBody.matchAll(transitionRegex)) {
      const fromStatus = match[1]!;
      const toList = [...match[2]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
      triggerTransitions.set(fromStatus, toList);
    }

    // Verify all 11 statuses
    for (const status of TASK_STATUSES) {
      const expectedInTrigger = triggerTransitions.get(status) ?? [];
      const inCore = [...LEGAL_TRANSITIONS[status]];
      expect(inCore.sort()).toEqual(expectedInTrigger.sort());
    }
  });

  it('reports correct legal target statuses via getLegalTargetStatuses', () => {
    expect(getLegalTargetStatuses('DRAFT')).toEqual(['TODO', 'BLOCKED']);
    expect(getLegalTargetStatuses('COMMITTED')).toEqual([]);
    expect(getLegalTargetStatuses('PASSED')).toEqual([
      'COMMITTED',
      'IN_PROGRESS',
      'READY_FOR_REVIEW',
      'BLOCKED',
    ]);
  });

  it('correctly identifies legal vs illegal transitions with isLegalTransition', () => {
    expect(isLegalTransition('TODO', 'IN_PROGRESS')).toBe(true);
    expect(isLegalTransition('IN_PROGRESS', 'READY_FOR_REVIEW')).toBe(true);
    expect(isLegalTransition('READY_FOR_REVIEW', 'PASSED')).toBe(true);
    expect(isLegalTransition('PASSED', 'COMMITTED')).toBe(true);

    // Illegal transitions
    expect(isLegalTransition('TODO', 'PASSED')).toBe(false);
    expect(isLegalTransition('IN_PROGRESS', 'COMMITTED')).toBe(false);
    expect(isLegalTransition('COMMITTED', 'IN_PROGRESS')).toBe(false);
    expect(isLegalTransition('TODO', 'TODO')).toBe(false);
  });

  it('returns allowed actor roles via getAllowedActorRoles', () => {
    expect(getAllowedActorRoles('IN_PROGRESS', 'READY_FOR_REVIEW')).toEqual(['author', 'human']);
    expect(getAllowedActorRoles('PASSED', 'COMMITTED')).toEqual(['daemon', 'human']);
    expect(getAllowedActorRoles('COMMITTED', 'TODO')).toEqual([]);
    expect(getAllowedActorRoles('TODO', 'PASSED')).toEqual([]);
  });
});

describe('Task State Machine: Every Legal Transition (32) with Authorized Actors', () => {
  const dummyTask: TaskLike = {
    id: 'T-100',
    assigned_agent_id: 'agent-1',
    diff_hash: 'abc123diffhash',
    prerequisites: [],
  };

  for (const fromStatus of TASK_STATUSES) {
    const targets = LEGAL_TRANSITIONS[fromStatus];
    for (const toStatus of targets) {
      const key = `${fromStatus}->${toStatus}` as const;
      const authorizedRoles = TRANSITION_AUTHORIZED_ROLES[key];

      it(`authorizes transition ${key} for authorized roles: [${authorizedRoles.join(', ')}]`, () => {
        expect(authorizedRoles.length).toBeGreaterThan(0);
        for (const role of authorizedRoles) {
          const decision = validateTaskTransition(
            dummyTask,
            fromStatus,
            toStatus,
            role
          );
          expect(decision.allowed).toBe(true);
          expect(decision.reason).toContain('authorized');
          expect(decision.code).toBeUndefined();
        }
      });
    }
  }
});

describe('Task State Machine: Every Legal Transition Rejects Unauthorized Actors', () => {
  const dummyTask: TaskLike = {
    id: 'T-100',
    assigned_agent_id: 'agent-1',
    diff_hash: 'abc123diffhash',
    prerequisites: [],
  };

  const allRoles: ActorRole[] = ['author', 'auditor', 'human', 'daemon', 'other_agent'];

  for (const fromStatus of TASK_STATUSES) {
    const targets = LEGAL_TRANSITIONS[fromStatus];
    for (const toStatus of targets) {
      const key = `${fromStatus}->${toStatus}` as const;
      const authorizedRoles = TRANSITION_AUTHORIZED_ROLES[key];
      const unauthorizedRoles = allRoles.filter((r) => !authorizedRoles.includes(r as CanonicalActorRole));

      if (unauthorizedRoles.length > 0) {
        it(`rejects ${key} for unauthorized roles: [${unauthorizedRoles.join(', ')}]`, () => {
          for (const role of unauthorizedRoles) {
            const decision = validateTaskTransition(
              dummyTask,
              fromStatus,
              toStatus,
              role
            );
            expect(decision.allowed).toBe(false);
            expect(decision.code).toBe('UNAUTHORIZED_ACTOR');
            expect(decision.reason).toContain(`Actor role '${role}' is not authorized`);
          }
        });
      }
    }
  }
});

describe('Task State Machine: Crucial Two-Agent & Role Guard Scenarios', () => {
  const taskWithAuthor: TaskLike = {
    id: 'T-1',
    assigned_agent_id: 'author-agent',
    diff_hash: 'sha256:1111',
  };

  it('rejects IN_PROGRESS -> READY_FOR_REVIEW when attempted by other_agent or auditor', () => {
    const resultOther = validateTaskTransition(
      taskWithAuthor,
      'IN_PROGRESS',
      'READY_FOR_REVIEW',
      'other_agent'
    );
    expect(resultOther.allowed).toBe(false);
    expect(resultOther.code).toBe('UNAUTHORIZED_ACTOR');

    const resultAuditor = validateTaskTransition(
      taskWithAuthor,
      'IN_PROGRESS',
      'READY_FOR_REVIEW',
      'auditor'
    );
    expect(resultAuditor.allowed).toBe(false);
    expect(resultAuditor.code).toBe('UNAUTHORIZED_ACTOR');
  });

  it('rejects author attempting to self-pass in READY_FOR_REVIEW -> PASSED', () => {
    const result = validateTaskTransition(
      taskWithAuthor,
      'READY_FOR_REVIEW',
      'PASSED',
      'author'
    );
    expect(result.allowed).toBe(false);
    expect(result.code).toBe('UNAUTHORIZED_ACTOR');
  });

  it('rejects other_agent attempting to pass in READY_FOR_REVIEW -> PASSED', () => {
    const result = validateTaskTransition(
      taskWithAuthor,
      'READY_FOR_REVIEW',
      'PASSED',
      'other_agent'
    );
    expect(result.allowed).toBe(false);
    expect(result.code).toBe('UNAUTHORIZED_ACTOR');
  });

  it('allows peer auditor and human to pass in READY_FOR_REVIEW -> PASSED', () => {
    expect(
      validateTaskTransition(taskWithAuthor, 'READY_FOR_REVIEW', 'PASSED', 'auditor').allowed
    ).toBe(true);
    expect(
      validateTaskTransition(taskWithAuthor, 'READY_FOR_REVIEW', 'PASSED', 'human').allowed
    ).toBe(true);
  });

  it('rejects non-daemon agent attempting PASSED -> COMMITTED', () => {
    for (const role of ['author', 'auditor', 'other_agent'] as const) {
      const result = validateTaskTransition(taskWithAuthor, 'PASSED', 'COMMITTED', role);
      expect(result.allowed).toBe(false);
      expect(result.code).toBe('UNAUTHORIZED_ACTOR');
    }
    // Daemon is authorized
    expect(
      validateTaskTransition(taskWithAuthor, 'PASSED', 'COMMITTED', 'daemon').allowed
    ).toBe(true);
  });

  it('rejects BLOCKED -> DRAFT by anyone other than Human', () => {
    for (const role of ['author', 'auditor', 'daemon', 'other_agent'] as const) {
      const result = validateTaskTransition(taskWithAuthor, 'BLOCKED', 'DRAFT', role);
      expect(result.allowed).toBe(false);
      expect(result.code).toBe('UNAUTHORIZED_ACTOR');
    }
    expect(validateTaskTransition(taskWithAuthor, 'BLOCKED', 'DRAFT', 'human').allowed).toBe(true);
  });

  it('allows CLAIMED -> IN_PROGRESS only for author (or human)', () => {
    expect(
      validateTaskTransition(taskWithAuthor, 'CLAIMED', 'IN_PROGRESS', 'author').allowed
    ).toBe(true);
    expect(
      validateTaskTransition(taskWithAuthor, 'CLAIMED', 'IN_PROGRESS', 'human').allowed
    ).toBe(true);
    expect(
      validateTaskTransition(taskWithAuthor, 'CLAIMED', 'IN_PROGRESS', 'other_agent').allowed
    ).toBe(false);
    expect(
      validateTaskTransition(taskWithAuthor, 'CLAIMED', 'IN_PROGRESS', 'auditor').allowed
    ).toBe(false);
  });
});

describe('Task State Machine: Every Illegal Transition (78) Rejected', () => {
  const dummyTask: TaskLike = {
    id: 'T-100',
    assigned_agent_id: 'agent-1',
    diff_hash: 'hash123',
  };

  it('rejects every non-legal status pair for any actor role', () => {
    let illegalCount = 0;
    for (const fromStatus of TASK_STATUSES) {
      for (const toStatus of TASK_STATUSES) {
        if (fromStatus === toStatus || fromStatus === 'COMMITTED') continue;
        if (!isLegalTransition(fromStatus, toStatus)) {
          illegalCount++;
          // Test with all actor roles
          for (const role of ['author', 'auditor', 'human', 'daemon', 'other_agent'] as const) {
            const decision = validateTaskTransition(dummyTask, fromStatus, toStatus, role);
            expect(decision.allowed).toBe(false);
            expect(decision.code).toBe('ILLEGAL_TRANSITION');
            expect(decision.reason).toBe(
              `Illegal task status transition from '${fromStatus}' to '${toStatus}'.`
            );
          }
        }
      }
    }
    // 10 non-COMMITTED statuses * 10 targets = 100 pairs - 32 legal = 68 illegal transitions
    // (Plus 10 non-self transitions out of COMMITTED tested below = 78 total non-self illegal transitions)
    expect(illegalCount).toBe(68);
  });

  it('rejects every transition out of COMMITTED with TERMINAL_STATE', () => {
    for (const target of TASK_STATUSES) {
      for (const role of ACTOR_ROLES) {
        const decision = validateTaskTransition(dummyTask, 'COMMITTED', target, role);
        expect(decision.allowed).toBe(false);
        expect(decision.code).toBe('TERMINAL_STATE');
        expect(decision.reason).toContain('irreversible terminal state');
      }
    }
  });

  it('rejects same-status transitions with SAME_STATUS', () => {
    for (const status of TASK_STATUSES) {
      if (status === 'COMMITTED') continue; // COMMITTED is caught by terminal state
      const decision = validateTaskTransition(dummyTask, status, status, 'author');
      expect(decision.allowed).toBe(false);
      expect(decision.code).toBe('SAME_STATUS');
      expect(decision.reason).toContain('already in status');
    }
  });
});

describe('Task State Machine: Precondition Enforcement (Triggers H4, H5, DAG)', () => {
  it('rejects IN_PROGRESS -> READY_FOR_REVIEW without an assigned author', () => {
    const unauthoredTask: TaskLike = {
      id: 'T-2',
      assigned_agent_id: null,
      diff_hash: 'sha256:valid',
    };
    const decision = validateTaskTransition(
      unauthoredTask,
      'IN_PROGRESS',
      'READY_FOR_REVIEW',
      'author'
    );
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('MISSING_AUTHOR');
    expect(decision.reason).toBe('Task cannot be READY_FOR_REVIEW without an assigned author');
  });

  it('rejects IN_PROGRESS -> READY_FOR_REVIEW without diff_hash or with empty whitespace diff_hash', () => {
    const noDiffTask: TaskLike = {
      id: 'T-3',
      assigned_agent_id: 'agent-1',
      diff_hash: null,
    };
    const decision1 = validateTaskTransition(
      noDiffTask,
      'IN_PROGRESS',
      'READY_FOR_REVIEW',
      'author'
    );
    expect(decision1.allowed).toBe(false);
    expect(decision1.code).toBe('MISSING_DIFF_HASH');
    expect(decision1.reason).toBe('Task cannot be READY_FOR_REVIEW without diff_hash');

    const emptyDiffTask: TaskLike = {
      id: 'T-4',
      assigned_agent_id: 'agent-1',
      diff_hash: '   ',
    };
    const decision2 = validateTaskTransition(
      emptyDiffTask,
      'IN_PROGRESS',
      'READY_FOR_REVIEW',
      'author'
    );
    expect(decision2.allowed).toBe(false);
    expect(decision2.code).toBe('MISSING_DIFF_HASH');
  });

  it('rejects TESTING -> READY_FOR_REVIEW without diff_hash', () => {
    const noDiffTask: TaskLike = {
      id: 'T-5',
      assigned_agent_id: 'agent-1',
      diff_hash: '',
    };
    const decision = validateTaskTransition(
      noDiffTask,
      'TESTING',
      'READY_FOR_REVIEW',
      'author'
    );
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('MISSING_DIFF_HASH');
  });

  it('rejects self-referencing prerequisites when claiming task', () => {
    const selfPrereqTask: TaskLike = {
      id: 'T-CYCLE',
      status: 'TODO',
      prerequisites: ['T-CYCLE'],
    };
    const decision = validateTaskTransition(
      selfPrereqTask,
      'TODO',
      'CLAIMED',
      'author'
    );
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('UNSATISFIED_PREREQUISITES');
    expect(decision.reason).toBe('Task cannot have itself as a prerequisite');
  });

  it('rejects claiming task when prerequisites are not satisfied', () => {
    const dependentTask: TaskLike = {
      id: 'T-DEP',
      status: 'TODO',
      prerequisites: ['P1.1', 'P1.2'],
    };
    const decision = validateTaskTransition(
      dependentTask,
      'TODO',
      'CLAIMED',
      'author',
      { satisfiedPrerequisiteIds: new Set(['P1.1']) } // P1.2 missing
    );
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('UNSATISFIED_PREREQUISITES');
    expect(decision.reason).toBe('Cannot claim task: prerequisite P1.2 is not PASSED or COMMITTED');
  });

  it('accepts claiming task when all prerequisites are satisfied', () => {
    const dependentTask: TaskLike = {
      id: 'T-DEP',
      status: 'TODO',
      prerequisites: ['P1.1', 'P1.2'],
    };
    const decision = validateTaskTransition(
      dependentTask,
      'TODO',
      'IN_PROGRESS',
      'author',
      { satisfiedPrerequisiteIds: new Set(['P1.1', 'P1.2']) }
    );
    expect(decision.allowed).toBe(true);
  });
});

describe('Task State Machine: Options Object & Positional Overloads', () => {
  const task: TaskLike = {
    id: 'T-9',
    status: 'IN_PROGRESS',
    assigned_agent_id: 'agent-9',
    diff_hash: 'diff999',
  };

  it('supports options object calling style', () => {
    const decision = validateTaskTransition({
      task,
      targetStatus: 'READY_FOR_REVIEW',
      actorRole: 'author',
    });
    expect(decision.allowed).toBe(true);
  });

  it('supports alias validateTransition', () => {
    const decision = validateTransition(task, 'IN_PROGRESS', 'READY_FOR_REVIEW', 'author');
    expect(decision.allowed).toBe(true);
  });

  it('supports normalize other to other_agent', () => {
    const decision = validateTaskTransition(task, 'IN_PROGRESS', 'READY_FOR_REVIEW', 'other');
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('UNAUTHORIZED_ACTOR');
  });
});

describe('Task State Machine: resolveActorRole Utility', () => {
  const task: TaskLike = {
    id: 'T-RESOLVE',
    assigned_agent_id: 'author-uuid',
    author_platform: 'CLAUDE_CODE',
    reviewing_agent_id: 'auditor-uuid',
  };

  it('resolves human identity correctly (requires BOTH platform=HUMAN and paradigm=HUMAN)', () => {
    expect(resolveActorRole(task, { platform: 'HUMAN', paradigm: 'HUMAN' })).toBe('human');
    expect(resolveActorRole(task, { platform: 'HUMAN', paradigm: 'CLI' })).toBe('other_agent');
    expect(resolveActorRole(task, { platform: 'CLAUDE_CODE', paradigm: 'HUMAN' })).toBe('other_agent');
  });

  it('resolves daemon correctly (requires DAEMON_PRINCIPAL reference or options.isDaemon)', () => {
    expect(resolveActorRole(task, DAEMON_PRINCIPAL)).toBe('daemon');
    expect(resolveActorRole(task, { id: 'daemon-internal' }, { isDaemon: true })).toBe('daemon');
    expect(resolveActorRole(task, { id: 'daemon-internal', isDaemon: true })).not.toBe('daemon');
    expect(resolveActorRole(task, { id: 'daemon-1', paradigm: 'DAEMON' })).not.toBe('daemon');
  });

  it('resolves author correctly', () => {
    expect(resolveActorRole(task, { id: 'author-uuid', paradigm: 'CLI', platform: 'CLAUDE_CODE' })).toBe(
      'author'
    );
  });

  it('resolves auditor correctly for cross-platform peer', () => {
    expect(resolveActorRole(task, { id: 'auditor-uuid', paradigm: 'IDE', platform: 'ANTIGRAVITY' })).toBe(
      'auditor'
    );
  });

  it('resolves other_agent for non-matching agent', () => {
    expect(resolveActorRole(task, { id: 'random-agent', paradigm: 'CLI', platform: 'CLAUDE_CODE' })).toBe(
      'other_agent'
    );
    expect(resolveActorRole(task, null)).toBe('other_agent');
  });
});

describe('Task State Machine: Regression Tests for Findings A-H (P1.3 Audit)', () => {
  it('Finding A: resolves cross-platform peer to auditor when reviewing_agent_id is not yet set (audit claim)', () => {
    const readyTask: TaskLike = {
      id: 'T-READY',
      status: 'READY_FOR_REVIEW',
      assigned_agent_id: 'claude-1',
      author_platform: 'CLAUDE_CODE',
      diff_hash: 'diff123',
    };
    const geminiActor = { id: 'gemini-1', platform: 'ANTIGRAVITY', paradigm: 'IDE' as const };
    const role = resolveActorRole(readyTask, geminiActor);
    expect(role).toBe('auditor');

    // And READY_FOR_REVIEW -> AUDITING transition is authorized for this role
    const decision = validateTaskTransition(readyTask, 'READY_FOR_REVIEW', 'AUDITING', role);
    expect(decision.allowed).toBe(true);
  });

  it('Finding B: rejects same-platform agent recorded as reviewing_agent_id from auditor role', () => {
    const task: TaskLike = {
      id: 'T-REVIEW',
      status: 'READY_FOR_REVIEW',
      assigned_agent_id: 'claude-1',
      author_platform: 'CLAUDE_CODE',
      reviewing_agent_id: 'claude-2',
      diff_hash: 'diff123',
    };
    const samePlatformReviewer = { id: 'claude-2', platform: 'CLAUDE_CODE', paradigm: 'CLI' as const };
    const role = resolveActorRole(task, samePlatformReviewer);
    expect(role).toBe('other_agent');
    expect(role).not.toBe('auditor');

    const decision = validateTaskTransition(task, 'READY_FOR_REVIEW', 'AUDITING', role);
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('UNAUTHORIZED_ACTOR');
  });

  it('Finding C: agent row with paradigm DAEMON never confers daemon authority; requires DAEMON_PRINCIPAL or explicit isDaemon flag', () => {
    const task: TaskLike = {
      id: 'T-LAND',
      status: 'PASSED',
      assigned_agent_id: 'agent-1',
    };
    const untrustedAgentRow = { id: 'rogue-agent', paradigm: 'DAEMON' as const, platform: 'CLI' };
    const untrustedRole = resolveActorRole(task, untrustedAgentRow);
    expect(untrustedRole).not.toBe('daemon');

    const rogueDecision = validateTaskTransition(task, 'PASSED', 'COMMITTED', untrustedRole);
    expect(rogueDecision.allowed).toBe(false);
    expect(rogueDecision.code).toBe('UNAUTHORIZED_ACTOR');

    // Explicit internal principal succeeds
    const daemonRole = resolveActorRole(task, DAEMON_PRINCIPAL);
    expect(daemonRole).toBe('daemon');
    const validDecision = validateTaskTransition(task, 'PASSED', 'COMMITTED', daemonRole);
    expect(validDecision.allowed).toBe(true);
  });

  it('Finding D: resolves human role only when BOTH paradigm and platform are HUMAN', () => {
    const task: TaskLike = { id: 'T-HUMAN' };
    expect(resolveActorRole(task, { platform: 'HUMAN', paradigm: 'CLI' })).toBe('other_agent');
    expect(resolveActorRole(task, { platform: 'CLAUDE_CODE', paradigm: 'HUMAN' })).toBe('other_agent');
    expect(resolveActorRole(task, { platform: 'HUMAN', paradigm: 'HUMAN' })).toBe('human');
  });

  it('Finding E: fails closed when task has prerequisites but satisfiedPrerequisiteIds is omitted', () => {
    const taskWithPrereqs: TaskLike = {
      id: 'T-PREREQ',
      status: 'TODO',
      prerequisites: ['P1.1', 'P1.2'],
    };
    // Omitting satisfiedPrerequisiteIds must be denied
    const decisionNoPrereqList = validateTaskTransition(
      taskWithPrereqs,
      'TODO',
      'IN_PROGRESS',
      'author'
    );
    expect(decisionNoPrereqList.allowed).toBe(false);
    expect(decisionNoPrereqList.code).toBe('UNSATISFIED_PREREQUISITES');

    // With unsatisfied prerequisites: denied
    const decisionUnsatisfied = validateTaskTransition(
      taskWithPrereqs,
      'TODO',
      'IN_PROGRESS',
      'author',
      { satisfiedPrerequisiteIds: ['P1.1'] }
    );
    expect(decisionUnsatisfied.allowed).toBe(false);
    expect(decisionUnsatisfied.code).toBe('UNSATISFIED_PREREQUISITES');

    // With all satisfied: allowed
    const decisionSatisfied = validateTaskTransition(
      taskWithPrereqs,
      'TODO',
      'IN_PROGRESS',
      'author',
      { satisfiedPrerequisiteIds: ['P1.1', 'P1.2'] }
    );
    expect(decisionSatisfied.allowed).toBe(true);
  });

  it('Finding F: denies transitions with preconditions when task is null or undefined', () => {
    // READY_FOR_REVIEW requires author and diff_hash
    const decisionRFR = validateTaskTransition(null, 'IN_PROGRESS', 'READY_FOR_REVIEW', 'author');
    expect(decisionRFR.allowed).toBe(false);
    expect(decisionRFR.code).toBe('MISSING_AUTHOR');

    // Claiming requires task record to verify prerequisites
    const decisionClaim = validateTaskTransition(null, 'TODO', 'CLAIMED', 'author');
    expect(decisionClaim.allowed).toBe(false);
    expect(decisionClaim.code).toBe('MISSING_TASK');

    const decisionStart = validateTaskTransition(null, 'TODO', 'IN_PROGRESS', 'author');
    expect(decisionStart.allowed).toBe(false);
    expect(decisionStart.code).toBe('MISSING_TASK');
  });

  it('Finding G: rejects forgeable actor.isDaemon flag; daemon role granted ONLY via DAEMON_PRINCIPAL reference or options.isDaemon', () => {
    const task: TaskLike = {
      id: 'T-LAND',
      status: 'PASSED',
      assigned_agent_id: 'agent-1',
    };
    // Untrusted actor attempting to forge isDaemon on actor object
    const rogueActor = { id: 'rogue-daemon', platform: 'CLAUDE_CODE', paradigm: 'CLI' as const, isDaemon: true };
    const resolvedRole = resolveActorRole(task, rogueActor);
    expect(resolvedRole).not.toBe('daemon');
    expect(resolvedRole).toBe('other_agent');

    // Rogue actor cannot perform daemon-only transition PASSED -> COMMITTED
    const rogueDecision = validateTaskTransition(task, 'PASSED', 'COMMITTED', resolvedRole);
    expect(rogueDecision.allowed).toBe(false);
    expect(rogueDecision.code).toBe('UNAUTHORIZED_ACTOR');

    // Also via validateTaskTransition options without options.isDaemon
    const optionsDecision = validateTaskTransition({
      task,
      currentStatus: 'PASSED',
      targetStatus: 'COMMITTED',
      actor: rogueActor,
    });
    expect(optionsDecision.allowed).toBe(false);
    expect(optionsDecision.code).toBe('UNAUTHORIZED_ACTOR');

    // Legitimate daemon via reference identity (DAEMON_PRINCIPAL)
    expect(resolveActorRole(task, DAEMON_PRINCIPAL)).toBe('daemon');
    expect(
      validateTaskTransition({
        task,
        currentStatus: 'PASSED',
        targetStatus: 'COMMITTED',
        actor: DAEMON_PRINCIPAL,
      }).allowed
    ).toBe(true);

    // Legitimate daemon via options.isDaemon
    expect(resolveActorRole(task, { id: 'worker-1' }, { isDaemon: true })).toBe('daemon');
    expect(
      validateTaskTransition({
        task,
        currentStatus: 'PASSED',
        targetStatus: 'COMMITTED',
        actor: { id: 'worker-1' },
        isDaemon: true,
      }).allowed
    ).toBe(true);
  });

  it('Finding H: rejects forgeable actor.isHuman flag; human role granted ONLY via platform===HUMAN && paradigm===HUMAN', () => {
    const task: TaskLike = { id: 'T-HUMAN-OP' };

    // Actor with CLI platform attempting to forge isHuman: true
    const rogueHumanActor = {
      id: 'rogue-human',
      platform: 'CLAUDE_CODE',
      paradigm: 'CLI' as const,
      isHuman: true,
    };
    const roleRogue = resolveActorRole(task, rogueHumanActor);
    expect(roleRogue).not.toBe('human');
    expect(roleRogue).toBe('other_agent');

    // Rogue actor cannot perform human-only transition BLOCKED -> DRAFT
    const blockedTask: TaskLike = { id: 'T-BLOCKED', status: 'BLOCKED' };
    const rogueDecision = validateTaskTransition(blockedTask, 'BLOCKED', 'DRAFT', roleRogue);
    expect(rogueDecision.allowed).toBe(false);
    expect(rogueDecision.code).toBe('UNAUTHORIZED_ACTOR');

    // Partial spoofing with isHuman: true must also fail
    expect(resolveActorRole(task, { platform: 'HUMAN', paradigm: 'CLI', isHuman: true })).toBe('other_agent');
    expect(resolveActorRole(task, { platform: 'CLAUDE_CODE', paradigm: 'HUMAN', isHuman: true })).toBe('other_agent');

    // Legitimate human (platform===HUMAN && paradigm===HUMAN) succeeds regardless of isHuman flag presence
    const legitHuman = { id: 'human-operator', platform: 'HUMAN', paradigm: 'HUMAN' as const };
    expect(resolveActorRole(task, legitHuman)).toBe('human');
    expect(validateTaskTransition(blockedTask, 'BLOCKED', 'DRAFT', 'human').allowed).toBe(true);
  });
});

