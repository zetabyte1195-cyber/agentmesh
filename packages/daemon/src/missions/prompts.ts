// What each agent is told for each mission step. The mission itself (brief, plan, reviews) is read with
// mesh_get_mission, so these stay short and stable; they say WHAT to produce and HOW to hand it in.

export interface MissionRef {
  id: string;
  title: string;
}

const SCRATCH =
  'You are in a scratch copy of the project (its current main branch). Read it if it helps; anything you change here is thrown away, so do not try to build anything now.';

export function planJob(m: MissionRef): string {
  return (
    `Mission ${m.id} "${m.title}" needs a PLAN. Call mesh_get_mission with missionId "${m.id}" to read the brief and any notes. ${SCRATCH} ` +
    'Write a concrete plan in Markdown, under about two pages: the goal and what is out of scope; what will be built (features/components, and the technology if the project has none yet); the key decisions and assumptions you are making; the order of work in small steps; how it will be tested; risks and open questions for the Human. ' +
    `Then call mesh_submit_plan with missionId "${m.id}" and the full plan as body. Do not create tasks now.`
  );
}

export function reviewJob(m: MissionRef, round: number): string {
  return (
    `Review the plan for mission ${m.id} "${m.title}" (review round ${round}). Call mesh_get_mission with missionId "${m.id}" to read the brief and the current plan. ${SCRATCH} ` +
    'Look hard for gaps: requirements in the brief the plan misses, wrong or risky assumptions, missing tests or error handling, unclear scope, steps in the wrong order, and anything that would be hard to split between several agents working in parallel. Be specific and short. Do not rewrite the plan. ' +
    `Then call mesh_submit_plan_review with missionId "${m.id}", planVersion set to the plan's version, verdict "OK" if you found nothing that matters or "GAPS" with a concrete list in gaps.`
  );
}

export function reviseJob(m: MissionRef): string {
  return (
    `The plan for mission ${m.id} "${m.title}" got feedback. Call mesh_get_mission with missionId "${m.id}" to read the plan and every review (the Human's notes count most). ${SCRATCH} ` +
    'Write the FINAL plan: address each gap (fix it, or say in one line why not), keep what was fine, and end with a short "Changes from review" section. ' +
    `Then call mesh_submit_plan with missionId "${m.id}" and the complete revised plan as body.`
  );
}

export function splitJob(m: MissionRef, owners: readonly string[]): string {
  return (
    `The Human approved the plan for mission ${m.id} "${m.title}". Call mesh_get_mission with missionId "${m.id}" to read it. ${SCRATCH} ` +
    `Break the plan into tasks with mesh_create_task, in dependency order: ids "${m.id}-1", "${m.id}-2", ...; phase exactly "mission:${m.id}"; a short title; a description saying what to build and where; testable acceptanceCriteria; prerequisites listing earlier task ids that must be finished first; and suggestedOwner set to one of ${owners.map((o) => `"${o}"`).join(', ')} or "Pair". ` +
    'Share the work sensibly between the agents and prefer small tasks that can run in parallel once their prerequisites are done. Tasks that run at the same time must not edit the same files: name in each description exactly which files it creates or changes, and tell the owner to lease those FILES individually (never a whole folder that other tasks also use).If the project has no test command yet, make the first task set up a test runner with one passing test, and put the exact test command in its description. ' +
    `When every task exists, call mesh_finish_split with missionId "${m.id}".`
  );
}
