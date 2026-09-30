import {
  type TaskStatus,
  type AgentParadigm,
} from './index.js';

/**
 * Recognized actor roles in AgentMesh lifecycle transitions.
 * - 'author': The agent assigned to the task (tasks.assigned_agent_id).
 * - 'auditor': Peer agent meeting the cross-platform audit rule (or assigned reviewing_agent_id).
 * - 'human': The verified human operator (platform = 'HUMAN', paradigm = 'HUMAN').
 * - 'daemon': Internal AgentMesh daemon (merge queue worker, lease arbiter, watchdog).
 * - 'other_agent': Any other registered agent not assigned as author or auditor.
 */
export const ACTOR_ROLES = [
  'author',
  'auditor',
  'human',
  'daemon',
  'other_agent',
] as const;

export type CanonicalActorRole = (typeof ACTOR_ROLES)[number];
export type ActorRole = CanonicalActorRole | 'other';

/**
 * Shape of a task record passed into state machine validator.
 * Accommodates both snake_case (SQLite columns) and camelCase properties.
 */
export interface TaskLike {
  readonly id?: string | undefined;
  readonly status?: TaskStatus | undefined;
  readonly assigned_agent_id?: string | null | undefined;
  readonly assignedAgentId?: string | null | undefined;
  readonly author_platform?: string | null | undefined;
  readonly authorPlatform?: string | null | undefined;
  readonly reviewing_agent_id?: string | null | undefined;
  readonly reviewingAgentId?: string | null | undefined;
  readonly diff_hash?: string | null | undefined;
  readonly diffHash?: string | null | undefined;
  readonly prerequisites?: readonly string[] | string | null | undefined;
  readonly author?: { readonly platform?: string | undefined } | undefined;
  readonly assignedAgent?: { readonly platform?: string | undefined } | undefined;
}

/**
 * Agent identity attributes used to resolve actor roles.
 */
export interface AgentIdentityLike {
  readonly id?: string | undefined;
  readonly agentId?: string | undefined;
  readonly platform?: string | undefined;
  readonly paradigm?: AgentParadigm | string | undefined;
  readonly isDaemon?: boolean | undefined;
  readonly isHuman?: boolean | undefined;
}

/**
 * Options or context for resolving an actor's role.
 */
export interface ResolveActorRoleOptions {
  readonly authorPlatform?: string | null | undefined;
  readonly isDaemon?: boolean | undefined;
}

/**
 * Sentinel internal principal for daemon-internal actions.
 * Never assigned to an agent registered in the agents table.
 */
export const DAEMON_PRINCIPAL: AgentIdentityLike = Object.freeze({
  id: 'internal:daemon',
  platform: 'DAEMON',
  paradigm: 'DAEMON',
  isDaemon: true,
});

/**
 * Specific error codes for disallowed transitions.
 */
export type TransitionErrorCode =
  | 'TERMINAL_STATE'
  | 'SAME_STATUS'
  | 'ILLEGAL_TRANSITION'
  | 'UNAUTHORIZED_ACTOR'
  | 'MISSING_AUTHOR'
  | 'MISSING_DIFF_HASH'
  | 'UNSATISFIED_PREREQUISITES'
  | 'MISSING_TASK';

/**
 * Result returned by the task state machine validator.
 */
export interface ValidationDecision {
  readonly allowed: boolean;
  readonly reason: string;
  readonly code?: TransitionErrorCode | undefined;
}

/**
 * Options for transition validation.
 */
export interface ValidateTransitionOptions {
  readonly task?: TaskLike | null | undefined;
  readonly currentStatus?: TaskStatus | undefined;
  readonly targetStatus: TaskStatus;
  readonly actorRole?: ActorRole | undefined;
  readonly actor?: AgentIdentityLike | null | undefined;
  readonly authorPlatform?: string | null | undefined;
  readonly isDaemon?: boolean | undefined;
  readonly satisfiedPrerequisiteIds?: Iterable<string> | undefined;
}

/**
 * Canonical table of legal transitions from docs/design/state-machine.md §4
 * and DB trigger trg_task_status_transition in docs/design/schema.sql.
 * Exactly 32 legal transitions across 11 statuses.
 */
export const LEGAL_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  DRAFT: ['TODO', 'BLOCKED'],
  BLOCKED: ['TODO', 'DRAFT'],
  TODO: ['CLAIMED', 'IN_PROGRESS', 'BLOCKED'],
  CLAIMED: ['IN_PROGRESS', 'TODO', 'BLOCKED'],
  IN_PROGRESS: ['TESTING', 'READY_FOR_REVIEW', 'BLOCKED', 'TODO'],
  TESTING: ['IN_PROGRESS', 'READY_FOR_REVIEW', 'BLOCKED'],
  READY_FOR_REVIEW: ['AUDITING', 'PASSED', 'REJECTED', 'IN_PROGRESS'],
  AUDITING: ['PASSED', 'REJECTED', 'READY_FOR_REVIEW', 'IN_PROGRESS'],
  REJECTED: ['IN_PROGRESS', 'BLOCKED', 'TODO'],
  PASSED: ['COMMITTED', 'IN_PROGRESS', 'READY_FOR_REVIEW', 'BLOCKED'],
  COMMITTED: [],
} as const;

export type LegalTransitionKey =
  | 'DRAFT->TODO'
  | 'DRAFT->BLOCKED'
  | 'BLOCKED->TODO'
  | 'BLOCKED->DRAFT'
  | 'TODO->CLAIMED'
  | 'TODO->IN_PROGRESS'
  | 'TODO->BLOCKED'
  | 'CLAIMED->IN_PROGRESS'
  | 'CLAIMED->TODO'
  | 'CLAIMED->BLOCKED'
  | 'IN_PROGRESS->TESTING'
  | 'IN_PROGRESS->READY_FOR_REVIEW'
  | 'IN_PROGRESS->BLOCKED'
  | 'IN_PROGRESS->TODO'
  | 'TESTING->IN_PROGRESS'
  | 'TESTING->READY_FOR_REVIEW'
  | 'TESTING->BLOCKED'
  | 'READY_FOR_REVIEW->AUDITING'
  | 'READY_FOR_REVIEW->PASSED'
  | 'READY_FOR_REVIEW->REJECTED'
  | 'READY_FOR_REVIEW->IN_PROGRESS'
  | 'AUDITING->PASSED'
  | 'AUDITING->REJECTED'
  | 'AUDITING->READY_FOR_REVIEW'
  | 'AUDITING->IN_PROGRESS'
  | 'REJECTED->IN_PROGRESS'
  | 'REJECTED->BLOCKED'
  | 'REJECTED->TODO'
  | 'PASSED->COMMITTED'
  | 'PASSED->IN_PROGRESS'
  | 'PASSED->READY_FOR_REVIEW'
  | 'PASSED->BLOCKED';

export type TransitionKey = `${TaskStatus}->${TaskStatus}`;

/**
 * Authorized actor roles per transition from docs/design/state-machine.md §4.
 */
export const TRANSITION_AUTHORIZED_ROLES: Readonly<
  Record<LegalTransitionKey, readonly CanonicalActorRole[]>
> = {
  // DRAFT (2)
  'DRAFT->TODO': ['human', 'author', 'other_agent', 'daemon'],
  'DRAFT->BLOCKED': ['human', 'author', 'other_agent', 'daemon'],

  // BLOCKED (2)
  'BLOCKED->TODO': ['human', 'daemon'],
  'BLOCKED->DRAFT': ['human'],

  // TODO (3)
  'TODO->CLAIMED': ['author', 'other_agent', 'human'],
  'TODO->IN_PROGRESS': ['author', 'other_agent', 'human'],
  'TODO->BLOCKED': ['human', 'daemon'],

  // CLAIMED (3)
  'CLAIMED->IN_PROGRESS': ['author', 'human'],
  'CLAIMED->TODO': ['author', 'daemon', 'human'],
  'CLAIMED->BLOCKED': ['author', 'daemon', 'human'],

  // IN_PROGRESS (4)
  'IN_PROGRESS->TESTING': ['author', 'human'],
  'IN_PROGRESS->READY_FOR_REVIEW': ['author', 'human'],
  'IN_PROGRESS->BLOCKED': ['author', 'human', 'daemon'],
  'IN_PROGRESS->TODO': ['author', 'human', 'daemon'],

  // TESTING (3)
  'TESTING->IN_PROGRESS': ['author', 'human'],
  'TESTING->READY_FOR_REVIEW': ['author', 'human'],
  'TESTING->BLOCKED': ['author', 'human', 'daemon'],

  // READY_FOR_REVIEW (4)
  'READY_FOR_REVIEW->AUDITING': ['auditor', 'human'],
  'READY_FOR_REVIEW->PASSED': ['auditor', 'human'],
  'READY_FOR_REVIEW->REJECTED': ['auditor', 'human'],
  'READY_FOR_REVIEW->IN_PROGRESS': ['author', 'daemon', 'human'],

  // AUDITING (4)
  'AUDITING->PASSED': ['auditor', 'human'],
  'AUDITING->REJECTED': ['auditor', 'human'],
  'AUDITING->READY_FOR_REVIEW': ['auditor', 'daemon', 'human'],
  'AUDITING->IN_PROGRESS': ['auditor', 'human'],

  // REJECTED (3)
  'REJECTED->IN_PROGRESS': ['author', 'human'],
  'REJECTED->BLOCKED': ['author', 'human', 'daemon'],
  'REJECTED->TODO': ['human', 'daemon'],

  // PASSED (4)
  'PASSED->COMMITTED': ['daemon', 'human'],
  'PASSED->IN_PROGRESS': ['daemon', 'human'],
  'PASSED->READY_FOR_REVIEW': ['daemon', 'human'],
  'PASSED->BLOCKED': ['daemon', 'human'],
} as const;

/**
 * Check whether a status transition is structurally legal in the AgentMesh state machine.
 */
export function isLegalTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === 'COMMITTED') return false;
  if (from === to) return false;
  const targets = LEGAL_TRANSITIONS[from];
  return targets ? targets.includes(to) : false;
}

/**
 * Returns the list of authorized actor roles for a legal transition, or empty array if illegal.
 */
export function getAllowedActorRoles(
  from: TaskStatus,
  to: TaskStatus
): readonly CanonicalActorRole[] {
  if (!isLegalTransition(from, to)) return [];
  const key = `${from}->${to}` as LegalTransitionKey;
  return TRANSITION_AUTHORIZED_ROLES[key] ?? [];
}

/**
 * Returns legal target statuses from a given current status.
 */
export function getLegalTargetStatuses(from: TaskStatus): readonly TaskStatus[] {
  return LEGAL_TRANSITIONS[from] ?? [];
}

/**
 * Resolves the ActorRole of an agent with respect to a specific task.
 *
 * Rules:
 * - 'daemon': ONLY granted to explicit internal daemon principals via reference identity
 *   (actor === DAEMON_PRINCIPAL) or daemon-controlled options.isDaemon === true (Finding G).
 *   Never from actor properties (actor.isDaemon or actor.paradigm).
 * - 'human': Verified human supervisor (requires BOTH paradigm === 'HUMAN' AND platform === 'HUMAN') (Finding H).
 *   Self-asserted actor.isHuman flag is ignored.
 * - 'author': The agent assigned to the task (tasks.assigned_agent_id).
 * - 'auditor': Cross-platform peer meeting the two-agent eligibility rule
 *   (actor.platform !== author.platform, and actor is not the author). Same-platform is rejected even
 *   if recorded as reviewing_agent_id.
 * - 'other_agent': Any other registered agent not meeting author or auditor eligibility.
 */
export function resolveActorRole(
  task: TaskLike | null | undefined,
  actor: AgentIdentityLike | null | undefined,
  options?: ResolveActorRoleOptions | string | null
): CanonicalActorRole {
  if (!actor) return 'other_agent';

  // Findings C & G: Daemon role is granted ONLY via reference identity (actor === DAEMON_PRINCIPAL)
  // or daemon-controlled options.isDaemon === true. Never from actor properties (actor.isDaemon or actor.paradigm).
  const isExplicitDaemon =
    actor === DAEMON_PRINCIPAL ||
    (typeof options === 'object' && options?.isDaemon === true);
  if (isExplicitDaemon) {
    return 'daemon';
  }

  // Findings D & H: Human role requires BOTH paradigm === 'HUMAN' AND platform === 'HUMAN'.
  // Decided ONLY by platform and paradigm; self-asserted actor.isHuman is ignored (Finding H).
  // Spoofed human identities (where one is HUMAN and other is not) must resolve to other_agent, never human or auditor.
  if (actor.platform === 'HUMAN' || actor.paradigm === 'HUMAN') {
    if (actor.platform === 'HUMAN' && actor.paradigm === 'HUMAN') {
      return 'human';
    }
    return 'other_agent';
  }

  // Author check: actor is the assigned agent on the task
  const assignedId = task?.assigned_agent_id ?? task?.assignedAgentId;
  const actorId = actor.id ?? actor.agentId;
  if (assignedId && actorId && actorId === assignedId) {
    return 'author';
  }

  // Findings A & B: Auditor role is based on cross-platform ELIGIBILITY (actor.platform !== author.platform).
  // The auditor must NOT be the author, and their platform MUST differ from the author's platform.
  // Matching reviewing_agent_id is NOT sufficient (and even if reviewing_agent_id matches, same-platform is denied).
  const authorPlatform =
    (typeof options === 'string' ? options : options?.authorPlatform) ??
    task?.author_platform ??
    task?.authorPlatform ??
    (task?.author as { platform?: string } | undefined)?.platform ??
    (task?.assignedAgent as { platform?: string } | undefined)?.platform;

  if (
    authorPlatform &&
    actor.platform &&
    actor.platform !== 'HUMAN' &&
    actor.platform !== authorPlatform &&
    (!assignedId || actorId !== assignedId)
  ) {
    return 'auditor';
  }

  return 'other_agent';
}

function normalizeActorRole(role: ActorRole): CanonicalActorRole {
  return role === 'other' ? 'other_agent' : role;
}

function parsePrerequisites(prereqs: readonly string[] | string | null | undefined): readonly string[] {
  if (!prereqs) return [];
  if (Array.isArray(prereqs)) return prereqs;
  if (typeof prereqs === 'string') {
    try {
      const parsed: unknown = JSON.parse(prereqs);
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === 'string');
      }
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Validates a task status transition against daemon-side actor authorization rules
 * and database trigger preconditions.
 */
export function validateTaskTransition(options: ValidateTransitionOptions): ValidationDecision;
export function validateTaskTransition(
  task: TaskLike | null | undefined,
  currentStatus: TaskStatus,
  targetStatus: TaskStatus,
  actorRole: ActorRole,
  options?: Omit<ValidateTransitionOptions, 'task' | 'currentStatus' | 'targetStatus' | 'actorRole'>
): ValidationDecision;
export function validateTaskTransition(
  taskOrOptions: TaskLike | ValidateTransitionOptions | null | undefined,
  currentStatusArg?: TaskStatus,
  targetStatusArg?: TaskStatus,
  actorRoleArg?: ActorRole,
  extraOptions?: Omit<ValidateTransitionOptions, 'task' | 'currentStatus' | 'targetStatus' | 'actorRole'>
): ValidationDecision {
  let task: TaskLike | null | undefined;
  let currentStatus: TaskStatus;
  let targetStatus: TaskStatus;
  let rawRole: ActorRole;
  let satisfiedPrereqIds: Iterable<string> | undefined;

  // Determine call style (options object vs positional arguments)
  if (
    taskOrOptions &&
    typeof taskOrOptions === 'object' &&
    'targetStatus' in taskOrOptions &&
    ('actorRole' in taskOrOptions || 'actor' in taskOrOptions)
  ) {
    const opts = taskOrOptions as ValidateTransitionOptions;
    task = opts.task;
    targetStatus = opts.targetStatus;
    if (opts.actorRole) {
      rawRole = opts.actorRole;
    } else if (opts.actor) {
      rawRole = resolveActorRole(task, opts.actor, {
        authorPlatform: opts.authorPlatform,
        isDaemon: opts.isDaemon,
      });
    } else {
      rawRole = 'other_agent';
    }
    currentStatus = opts.currentStatus ?? task?.status ?? 'TODO';
    satisfiedPrereqIds = opts.satisfiedPrerequisiteIds;
  } else {
    task = taskOrOptions as TaskLike | null | undefined;
    currentStatus = currentStatusArg ?? task?.status ?? 'TODO';
    if (!targetStatusArg) {
      throw new Error('validateTaskTransition: targetStatus is required');
    }
    targetStatus = targetStatusArg;
    rawRole = actorRoleArg ?? 'other_agent';
    satisfiedPrereqIds = extraOptions?.satisfiedPrerequisiteIds;
  }

  // 1. Terminal state check: COMMITTED has no outgoing transitions
  if (currentStatus === 'COMMITTED') {
    return {
      allowed: false,
      code: 'TERMINAL_STATE',
      reason: 'COMMITTED is an irreversible terminal state; no transitions are permitted out of COMMITTED.',
    };
  }

  // 2. Same status check: no-op transition
  if (currentStatus === targetStatus) {
    return {
      allowed: false,
      code: 'SAME_STATUS',
      reason: `Task is already in status '${currentStatus}'.`,
    };
  }

  // 3. Structural validity check (must be one of the 32 legal transitions)
  if (!isLegalTransition(currentStatus, targetStatus)) {
    return {
      allowed: false,
      code: 'ILLEGAL_TRANSITION',
      reason: `Illegal task status transition from '${currentStatus}' to '${targetStatus}'.`,
    };
  }

  // 4. Actor authorization check
  const role = normalizeActorRole(rawRole);
  const transitionKey = `${currentStatus}->${targetStatus}` as LegalTransitionKey;
  const allowedRoles = TRANSITION_AUTHORIZED_ROLES[transitionKey];

  if (!allowedRoles || !allowedRoles.includes(role)) {
    return {
      allowed: false,
      code: 'UNAUTHORIZED_ACTOR',
      reason: `Actor role '${rawRole}' is not authorized to transition task from '${currentStatus}' to '${targetStatus}'.`,
    };
  }

  // 5. Preconditions: READY_FOR_REVIEW requires assigned author and diff_hash (schema triggers H4, H5)
  // Finding F: A missing task record must be denied, not skipped.
  if (targetStatus === 'READY_FOR_REVIEW') {
    if (!task) {
      return {
        allowed: false,
        code: 'MISSING_AUTHOR',
        reason: 'Task cannot be READY_FOR_REVIEW without an assigned author',
      };
    }

    const authorId = task.assigned_agent_id ?? task.assignedAgentId;
    if (!authorId || (typeof authorId === 'string' && authorId.trim() === '')) {
      return {
        allowed: false,
        code: 'MISSING_AUTHOR',
        reason: 'Task cannot be READY_FOR_REVIEW without an assigned author',
      };
    }

    const diffHash = task.diff_hash ?? task.diffHash;
    if (!diffHash || (typeof diffHash === 'string' && diffHash.trim() === '')) {
      return {
        allowed: false,
        code: 'MISSING_DIFF_HASH',
        reason: 'Task cannot be READY_FOR_REVIEW without diff_hash',
      };
    }
  }

  // 6. Preconditions: Claiming / Starting from TODO or BLOCKED requires satisfied prerequisites
  // Finding F: Missing task record must be denied, not skipped.
  // Finding E: Fail closed when prerequisites are present but satisfiedPrerequisiteIds is omitted.
  if (
    (currentStatus === 'TODO' || currentStatus === 'BLOCKED') &&
    (targetStatus === 'CLAIMED' || targetStatus === 'IN_PROGRESS')
  ) {
    if (!task) {
      return {
        allowed: false,
        code: 'MISSING_TASK',
        reason: `Cannot transition from '${currentStatus}' to '${targetStatus}': task record is required to verify prerequisites`,
      };
    }

    const prereqs = parsePrerequisites(task.prerequisites);

    // Check self-referencing prerequisite
    if (task.id && prereqs.includes(task.id)) {
      return {
        allowed: false,
        code: 'UNSATISFIED_PREREQUISITES',
        reason: 'Task cannot have itself as a prerequisite',
      };
    }

    // Fail closed: if task has non-empty prerequisites, satisfied set must be provided and complete
    if (prereqs.length > 0) {
      if (!satisfiedPrereqIds) {
        return {
          allowed: false,
          code: 'UNSATISFIED_PREREQUISITES',
          reason: `Cannot claim task: prerequisite ${prereqs[0]} is not satisfied (no satisfied prerequisites provided)`,
        };
      }

      const satisfiedSet =
        satisfiedPrereqIds instanceof Set
          ? satisfiedPrereqIds
          : new Set(satisfiedPrereqIds);

      for (const prereqId of prereqs) {
        if (!satisfiedSet.has(prereqId)) {
          return {
            allowed: false,
            code: 'UNSATISFIED_PREREQUISITES',
            reason: `Cannot claim task: prerequisite ${prereqId} is not PASSED or COMMITTED`,
          };
        }
      }
    }
  }

  return {
    allowed: true,
    reason: `Transition from '${currentStatus}' to '${targetStatus}' is authorized for role '${rawRole}'.`,
  };
}

/**
 * Alias for validateTaskTransition.
 */
export const validateTransition = validateTaskTransition;
